import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export type AcpTransport =
  | { command: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
  | { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

export interface AcpClientOptions {
  transport: AcpTransport;
  timeoutMs?: number;
  shutdownMs?: number;
  permissionTimeoutMs?: number;
  onUpdate?: (update: acp.SessionNotification) => void | Promise<void>;
  requestPermission?: (request: acp.RequestPermissionRequest, signal: AbortSignal) => Promise<acp.RequestPermissionResponse>;
}

function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("ACP operation timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** One connection, one session, one prompt. Owns and closes the supplied streams. */
export class AcpClient {
  private readonly connection: acp.ClientSideConnection;
  private readonly abort = new AbortController();
  private readonly child?: ChildProcess;
  private readonly failure: Promise<never>;
  private fail!: (error: Error) => void;
  private error?: Error;
  private closing?: Promise<void>;
  private initialized?: acp.InitializeResponse;
  private session?: string;
  private info?: acp.NewSessionResponse | acp.LoadSessionResponse;
  private busy = false;
  private active?: Promise<acp.PromptResponse>;
  private cancelling = false;
  private permissionAbort = new AbortController();
  private readonly timeout: number;
  private readonly grace: number;
  private stderrTail = Buffer.alloc(0);

  private readonly options: AcpClientOptions;

  constructor(options: AcpClientOptions) {
    this.options = options;
    this.timeout = options.timeoutMs ?? 10_000;
    this.grace = options.shutdownMs ?? 500;
    if (![this.timeout, this.grace, options.permissionTimeoutMs ?? 120_000].every(n => Number.isFinite(n) && n > 0)) {
      throw new Error("ACP timeouts must be positive finite numbers");
    }
    this.failure = new Promise((_, reject) => { this.fail = reject; });
    void this.failure.catch(() => {});
    let readable: ReadableStream<Uint8Array>;
    let writable: WritableStream<Uint8Array>;
    const transport = options.transport;
    if ("command" in transport) {
      const child = spawn(transport.command, transport.args ?? [], {
        cwd: transport.cwd, env: transport.env, shell: false,
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      child.on("error", () => this.stop(new Error("ACP process failed to start")));
      child.on("exit", (code, signal) => {
        this.stop(new Error(`ACP process exited (${signal ?? code})`));
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        this.stderrTail = Buffer.from(Buffer.concat([this.stderrTail, chunk.subarray(-8192)]).subarray(-8192));
      });
      readable = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
      writable = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    } else {
      ({ readable, writable } = transport);
    }
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const pipeOptions = { signal: this.abort.signal };
    void readable.pipeTo(input.writable, pipeOptions).catch(() => {
      this.stop(new Error("ACP input closed"));
    });
    void output.readable.pipeTo(writable, pipeOptions).catch(() => {
      this.stop(new Error("ACP output closed"));
    });
    this.connection = new acp.ClientSideConnection(() => ({
      sessionUpdate: update => options.onUpdate?.(update),
      requestPermission: request => this.permission(request),
    }), acp.ndJsonStream(output.writable, input.readable, { maxMessageBytes: 8 * 1024 * 1024 }));
    void this.connection.closed.then(() => this.stop(new Error("ACP connection closed")));
  }

  // Stderr may contain credentials: retained for explicit diagnostics, never logged or put in errors.
  get stderr(): string { return this.stderrTail.toString("utf8"); }
  get sessionId(): string | undefined { return this.session; }
  get sessionInfo(): acp.NewSessionResponse | acp.LoadSessionResponse | undefined { return this.info; }
  get capabilities(): acp.InitializeResponse | undefined { return this.initialized; }

  setMode(modeId: string): Promise<void> {
    return this.exclusive(async () => {
      if (!this.session || !this.info?.modes?.availableModes.some(mode => mode.id === modeId))
        throw new Error(`ACP mode not advertised: ${modeId}`);
      await this.connection.setSessionMode({ sessionId: this.session, modeId });
    });
  }

  setModel(modelId: string): Promise<void> {
    return this.exclusive(async () => {
      if (!this.session) throw new Error("Open an ACP session first");
      const option = this.info?.configOptions?.find(option => option.id === "model");
      const values = option?.type === "select" ? option.options.flatMap(item => "options" in item ? item.options : [item]) : [];
      if (!values.some(item => item.value === modelId)) throw new Error(`ACP model not advertised: ${modelId}`);
      const result = await this.connection.setSessionConfigOption({ sessionId: this.session, configId: "model", value: modelId });
      if (this.info) this.info.configOptions = result.configOptions;
    });
  }

  private stop(error: Error): void {
    if (!this.error) { this.error = error; this.fail(error); }
  }

  private check(): void {
    if (this.error) throw this.error;
    if (this.closing) throw new Error("ACP client is shutting down");
  }

  private run<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.failure]);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    if (this.busy || this.active) throw new Error("ACP operation already active");
    this.busy = true;
    try {
      return await bounded(this.run(operation()), this.timeout);
    } catch (error) {
      // A timed-out state-changing request cannot safely be retried on this connection.
      await this.shutdown();
      throw error;
    } finally { this.busy = false; }
  }

  initialize(): Promise<acp.InitializeResponse> {
    return this.exclusive(async () => {
      if (this.initialized) return this.initialized;
      const result = await this.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {}, clientInfo: { name: "hempi", version: "1" },
      });
      if (result.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error("Unsupported ACP protocol version");
      }
      return this.initialized = result;
    });
  }

  openSession(request: acp.NewSessionRequest, sessionId?: string): Promise<string> {
    return this.exclusive(async () => {
      if (!this.initialized) throw new Error("Initialize ACP first");
      if (this.session) throw new Error("ACP session already exists");
      if (sessionId !== undefined) {
        if (!this.initialized.agentCapabilities?.loadSession) {
          throw new Error("ACP agent does not support loading sessions");
        }
        this.info = await this.connection.loadSession({ ...request, sessionId });
        this.session = sessionId;
      } else {
        const result = await this.connection.newSession(request);
        this.info = result;
        this.session = result.sessionId;
      }
      return this.session;
    });
  }

  async prompt(prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    this.check();
    if (!this.session) throw new Error("Open an ACP session first");
    if (this.busy || this.active || this.cancelling) throw new Error("ACP operation already active");
    this.permissionAbort = new AbortController();
    const pending = this.run(this.connection.prompt({ sessionId: this.session, prompt }));
    this.active = pending;
    try { return await pending; }
    finally { this.permissionAbort.abort(); this.active = undefined; }
  }

  private async permission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const denied: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    if (!this.active || this.cancelling || this.closing || request.sessionId !== this.session ||
        !this.options.requestPermission) return denied;
    const deadline = new AbortController();
    const signal = AbortSignal.any([this.permissionAbort.signal, deadline.signal]);
    let cancel!: () => void;
    const cancelled = new Promise<acp.RequestPermissionResponse>(resolve => {
      cancel = () => resolve(denied);
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      const result = await bounded(Promise.race([
        this.options.requestPermission(request, signal), cancelled,
      ]), this.options.permissionTimeoutMs ?? 120_000);
      if (signal.aborted) return denied;
      const outcome = result.outcome;
      if (outcome.outcome === "selected" &&
          !request.options.some(option => option.optionId === outcome.optionId)) return denied;
      return result;
    } catch { return denied; }
    finally { deadline.abort(); signal.removeEventListener("abort", cancel); }
  }

  async cancel(): Promise<void> {
    this.check();
    if (!this.active || !this.session || this.cancelling) return;
    this.cancelling = true;
    this.permissionAbort.abort();
    try {
      await bounded(this.run(Promise.all([
        this.connection.cancel({ sessionId: this.session }), this.active,
      ])), this.grace);
    } catch (error) { await this.shutdown(); throw error; }
    finally { this.cancelling = false; }
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.stop(new Error("ACP client shut down"));
    this.permissionAbort.abort();
    this.abort.abort();
    this.closing = (async () => {
      const child = this.child;
      if (!child?.pid) return;
      const signal = (name: NodeJS.Signals) => {
        try {
          if (process.platform === "win32") child.kill(name);
          else process.kill(-child.pid!, name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      signal("SIGTERM");
      // Wait the full grace period even if the leader exits: descendants may remain.
      await new Promise(resolve => setTimeout(resolve, this.grace));
      signal("SIGKILL");
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    })();
    return this.closing;
  }
}
