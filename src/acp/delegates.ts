import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { READ_TOOLS, HARNESS_NAMES, resolveSelection, delegateCatalog, type Config, type HarnessName } from "../config.ts";
import { emptyUsage, isRetryable, type Requests } from "../requests.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { safeText } from "../ui.ts";
import { agentInstructions, artifactDirectory, childUsage, createChild, type AgentResult } from "../agents.ts";
import { AcpClient } from "./client.ts";
import { createPiAcp } from "./pi.ts";
import { externalTransport } from "./backends.ts";
import { updateJson } from "../storage.ts";
import { RunRegistry, type RunInfo, type RunControl, type RunOutcome } from "./runs.ts";
export interface StartOptions { harness?: HarnessName; signal?: AbortSignal; onUpdate?: (text: string) => void; label?: string; workflowId?: string; phaseId?: string }
type Local = ReturnType<typeof createPiAcp>;
type Peer = { fingerprint: string; closing?: Promise<void>; client: AcpClient; local?: Local; control?: RunControl; ctx: ExtensionContext;
 reportedTokens?: number; promptTokensBase?: number;
 checkpointFile?: string; resetBudget?: () => void; answer: string; onUpdate?: (text: string) => void; log: Transcript; usage: Usage };
let dialogs = Promise.resolve();
const live = (info: RunInfo) => ["queued", "starting", "running", "awaiting_approval"].includes(info.state);
const validTokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const denied = () => ({ outcome: { outcome: "cancelled" as const } });

/** Ordered, bounded asynchronous transcript writes. Overflow fails the job, never silently drops text. */
class Transcript {
 private tail = Promise.resolve();
 private pending = 0;
 private error?: unknown;
 readonly file?: string;
 constructor(file?: string) { this.file = file; }
 append(value: unknown): void {
  if (!this.file) return; // --no-session must not leave transcript files on disk.
  const file = this.file;
  const line = JSON.stringify(value) + "\n";
  const bytes = Buffer.byteLength(line);
  if (this.pending + bytes > 4 * 1024 * 1024) { this.error = new Error("ACP transcript backlog exceeded"); throw this.error; }
  this.pending += bytes;
  this.tail = this.tail.then(() => fs.appendFile(file, line, { mode: 0o600 })).catch(error => { this.error ??= error; }).finally(() => { this.pending -= bytes; });
 }
 async flush() { await this.tail; if (this.error) throw new Error("ACP transcript write failed"); }
}
export class DelegateRuns {
 runs = new RunRegistry();
 private owner?: string;
 private registryListeners = new Set<(registry: RunRegistry) => void>();
 subscribeRegistry(listener: (registry: RunRegistry) => void): () => void {
  this.registryListeners.add(listener);
  return () => { this.registryListeners.delete(listener); };
 }
 private generation = 0;
 get epoch(): number { return this.generation; }
 private stopped = false;
 private peers = new Map<string, Peer>();
 private cleanups = new Set<Promise<void>>();
 private retire(id: string, peer = this.peers.get(id)): void {
  if (!peer) return;
  if (this.peers.get(id) === peer) this.peers.delete(id);
  const cleanup = this.close(peer).catch(() => {}).finally(() => this.cleanups.delete(cleanup));
  this.cleanups.add(cleanup);
 }
 private trim(): void {
  const idle = [...this.peers].filter(([id, peer]) => !peer.control && !live(this.runs.get(id) ?? { state: "completed" } as RunInfo))
   .sort(([a], [b]) => (this.runs.get(a)?.updatedAt ?? 0) - (this.runs.get(b)?.updatedAt ?? 0));
  while (idle.length > 16) { const [id, peer] = idle.shift()!; this.retire(id, peer); }
 }
 private fingerprint(name: string, ctx: ExtensionContext, harness: HarnessName): string {
  const { config, definition } = this.validate(name, ctx, { harness });
  const selection = harness === "pi" ? resolveSelection(config, definition.role, ctx) : undefined;
  // Pi removes before_agent_start sections outside a turn; normalize only our exact generated catalog.
  const catalog = `<hempi_agents>\n${delegateCatalog(config)}\n</hempi_agents>`;
  const parent = ctx.getSystemPrompt().replace(`\n\n${catalog}`, "");
  const snapshot = JSON.stringify({ harness, definition, roles: config.roles, catalog,
   backend: harness === "pi" ? undefined : config.harnesses[harness],
   model: selection, parent });
  return createHash("sha256").update(snapshot).digest("hex");
 }
 protected readonly pi: ExtensionAPI;
 protected readonly requests: Requests;
 protected readonly config: () => Config;
 constructor(pi: ExtensionAPI, requests: Requests, config: () => Config) { this.pi = pi; this.requests = requests; this.config = config; }
 private key(ctx: ExtensionContext) { return `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getSessionFile() ?? ""}`; }
 owns(ctx: ExtensionContext): boolean { return !this.stopped && this.owner === this.key(ctx); }
 restore(ctx: ExtensionContext): void {
  const key = this.key(ctx);
  if (key === this.owner && !this.stopped) return;
  void this.stop().catch(() => {});
  this.owner = key; this.stopped = false;
  const generation = this.generation;
  this.runs = new RunRegistry(info => {
   if (generation === this.generation && key === this.owner && key === this.key(ctx)) this.pi.appendEntry("hempi.run", info);
  }, id => this.retire(id));
  const newest = new Map<string, unknown>();
  for (const entry of ctx.sessionManager.getBranch()) {
   if (entry.type === "custom" && entry.customType === "hempi.run" && entry.data && typeof entry.data === "object" && "id" in entry.data && typeof entry.data.id === "string") newest.set(entry.data.id, entry.data);
  }
  this.runs.subscribe(info => { if (!live(info)) this.trim(); });
  this.runs.restore([...newest.values()]);
  for (const listener of [...this.registryListeners]) { try { listener(this.runs); } catch { /* UI observers must not break session restoration. */ } }
 }
 async stop(): Promise<void> {
  this.generation++; this.stopped = true;
  const registry = this.runs, peers = this.peers;
  this.peers = new Map();
  const stopping = registry.stop();
  await Promise.allSettled([...peers.values()].map(peer => this.close(peer)));
  try { await stopping; }
  finally { await Promise.allSettled([...this.cleanups]); }
 }
 private validate(name: string, ctx: ExtensionContext, options: StartOptions) {
  const config = this.config(), definition = config.agents[name];
  if (!Object.hasOwn(config.agents, name)) throw new Error(`Unknown agent ${name}`);
  const writer = definition.tools.some(tool => !READ_TOOLS.includes(tool));
  if (writer && !this.pi.getActiveTools().some(tool => ["bash", "powershell", "edit", "write"].includes(tool))) throw new Error("The primary read-only loadout cannot delegate to a writer");
  const harness = options.harness ?? definition.harness ?? "pi";
  if (!HARNESS_NAMES.includes(harness)) throw new Error("Unsupported harness");
  if (harness !== "pi" && !writer) throw new Error("Exact read-only grants are not portable over ACP. Use Pi readonly or an explicitly writer external profile.");
  if (harness !== "pi" && definition.acpMode && definition.acpMode !== this.safeMode(harness)) throw new Error("ACP mode override is not a known safe mode");
  return { config, definition, writer, harness };
 }
 preflight(name: string, ctx: ExtensionContext, options: StartOptions = {}): void {
  const { config, definition, harness } = this.validate(name, ctx, options);
  if (harness === "pi") resolveSelection(config, definition.role, ctx);
 }
 private safeMode(harness: HarnessName) { return harness === "codex" ? "workspace-write" : harness === "fx" ? "ask" : "default"; }
 start(name: string, task: string, ctx: ExtensionContext, options: StartOptions = {}): string {
  const validated = this.validate(name, ctx, options);
  options.signal?.throwIfAborted();
  this.restore(ctx);
  const registry = this.runs, generation = this.generation;
  const fingerprint = this.fingerprint(name, ctx, validated.harness);
  let id!: string;
  id = registry.start({ agent: name, task, cwd: ctx.cwd, harness: validated.harness, label: options.label, workflowId: options.workflowId, phaseId: options.phaseId, extra: { fingerprint } }, control => this.execute(id, task, ctx, control, options, generation, fingerprint));
  this.bindSignal(registry, id, options.signal);
  return id;
 }
 private bindSignal(registry: RunRegistry, id: string, signal?: AbortSignal) {
  const abort = () => registry.cancel(id);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  void registry.wait(id).finally(() => signal?.removeEventListener("abort", abort)).catch(() => {});
 }
 async run(name: string, task: string, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (text: string) => void, options: StartOptions = {}): Promise<AgentResult> {
  const id = this.start(name, task, ctx, { ...options, signal: signal ?? options.signal, onUpdate: onUpdate ?? options.onUpdate });
  return this.asResult(await this.runs.wait(id));
 }
 result(id: string): AgentResult | undefined { const info = this.runs.get(id); return info && !live(info) ? this.asResult(info) : undefined; }
 private asResult(info: RunInfo): AgentResult {
  return { agent: info.agent, answer: info.answer, file: info.file, model: info.model ?? "", usage: info.usage as Usage ?? emptyUsage(), error: info.error,
   runId: info.id, harness: info.harness as HarnessName, status: info.state, usageKnown: info.harness === "pi" && info.usage !== undefined };
 }
 followup(id: string, task: string, ctx: ExtensionContext): string {
  this.restore(ctx);
  const info = this.runs.get(id);
  if (!info) throw new Error(`Unknown run: ${id}`);
  if (info.workflowId) throw new Error("Workflow tasks cannot be followed up; start a new run");
  if (live(info)) throw new Error("Run is already live");
  if (info.cwd !== ctx.cwd) throw new Error("Run cwd differs from parent");
  const fingerprint = this.fingerprint(info.agent, ctx, info.harness as HarnessName);
  const previous = this.peers.get(id)?.fingerprint ?? (info.extra as { fingerprint?: string } | undefined)?.fingerprint;
  if (fingerprint !== previous) throw new Error("Delegate profile or parent constraints changed; start a new run");
  if (!this.peers.has(id) && info.harness === "pi" && !(info.extra as { childFile?: string } | undefined)?.childFile)
   throw new Error("Pi run has no persistent child session; start a new run");
  if (!this.peers.has(id) && !info.sessionId) throw new Error("Run has no resumable ACP session");
  const generation = this.generation;
  return this.runs.submit(id, control => this.execute(id, task, ctx, control, { harness: info.harness as HarnessName }, generation, fingerprint, info), task);
 }
 private async open(id: string, ctx: ExtensionContext, control: RunControl, options: StartOptions, fingerprint: string, check: () => void, restored?: RunInfo): Promise<Peer> {
  const info = this.runs.get(id)!;
  const { config, definition, harness } = this.validate(info.agent, ctx, { harness: info.harness as HarnessName });
  const directory = await artifactDirectory(ctx, `agent-${info.agent}`);
  check();
  const checkpointFile = harness !== "pi" && directory ? path.join(directory, `${id}.checkpoint.json`) : undefined;
  if (harness !== "pi" && restored) {
   const checkpoint = (restored.extra as { checkpoint?: unknown } | undefined)?.checkpoint;
   if (!checkpointFile || typeof checkpoint !== "string" || !checkpoint) throw new Error("External resume checkpoint is missing; start a new run");
   let marker: { sessionId?: unknown; nonce?: unknown } | null;
   try {
    const stat = await fs.stat(checkpointFile);
    if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid checkpoint");
    marker = JSON.parse(await fs.readFile(checkpointFile, "utf8"));
   } catch { throw new Error("External resume checkpoint is missing or invalid; start a new run"); }
   if (marker?.sessionId !== restored.sessionId || marker?.nonce !== checkpoint)
    throw new Error("External session advanced beyond this parent checkpoint; start a new run");
   check();
  }
  const file = directory ? path.join(directory, `${id}-${randomUUID()}.acp.jsonl`) : undefined;
  if (file) { const handle = await fs.open(file, "wx", 0o600); await handle.close(); }
  check();
  const log = new Transcript(file);
  let resetBudget: (() => void) | undefined;
  const local = harness === "pi" ? createPiAcp(async sessionFile => {
   const instructions = await agentInstructions(definition);
   check();
   const child = await createChild({ ctx, requests: this.requests, config, selection: resolveSelection(config, definition.role, ctx), kind: `agent-${info.agent}`,
    instructions: `${instructions}\n\n<primary-constraints>\n${ctx.getSystemPrompt()}\n</primary-constraints>`, tools: definition.tools, maxRequests: definition.maxRequests,
    sessionFile, sessionLeaf: restored?.harness === "pi" ? (restored.extra as { childLeaf?: string | null } | undefined)?.childLeaf : undefined });
   resetBudget = () => child.resetBudget();
   return { ...child, resetBudget() {} };
  }, { supportsLoad: true }) : undefined;
  const peer: Peer = { fingerprint, ctx, control, local, log, checkpointFile, answer: "", usage: emptyUsage(), onUpdate: options.onUpdate, client: undefined! };
  control.signal.throwIfAborted();
  peer.client = new AcpClient({ transport: local?.transport ?? externalTransport(harness as Exclude<HarnessName, "pi">, config, ctx.cwd),
   onUpdate: notification => {
    log.append(notification);
    const update = notification.update;
    if (update.sessionUpdate === "usage_update" && validTokens(update.used)) peer.control?.report({ contextTokens: update.used });
    const metrics = notification._meta?.hempi as { reportedTokens?: unknown } | undefined;
    if (harness === "pi" && validTokens(metrics?.reportedTokens)) {
     const tokens = (peer.promptTokensBase ?? 0) + metrics.reportedTokens;
     if (validTokens(tokens)) { peer.reportedTokens = tokens; peer.control?.report({ reportedTokens: tokens }); }
    }
    let text = "";
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
     text = update.content.text; peer.answer = (peer.answer + text).slice(0, 50000);
    } else if (update.sessionUpdate === "tool_call") text = `${info.agent}: ${update.title}\n`;
    if (text) { peer.control?.update(text); peer.onUpdate?.(text); }
   },
   requestPermission: async (request, signal) => {
    peer.control?.setState("awaiting_approval");
    const previous = dialogs;
    let release!: () => void;
    dialogs = new Promise<void>(resolve => { release = resolve; });
    try {
     await previous;
     if (!ctx.hasUI || signal.aborted) return denied();
     const sanitize = (text: string) => safeText(stripTerminalSequences(text)).replace(/[\u0080-\u009f]/g, "");
     const labels = request.options.map((option, index) => `${index + 1}. ${sanitize(option.name)}`);
     const raw = request.toolCall.rawInput === undefined ? "" : JSON.stringify(request.toolCall.rawInput);
     const preview = raw.length > 4000 ? `${raw.slice(0, 4000)}\n[Details truncated: deny if insufficient]` : raw;
     const title = sanitize(`${info.agent} (${harness}): ${request.toolCall.title ?? "ACP permission"}${preview ? `\n${preview}` : ""}`);
     const selected = await ctx.ui.select(title, labels, { signal });
     if (signal.aborted || selected === undefined) return denied();
     const index = labels.indexOf(selected);
     return index < 0 ? denied() : { outcome: { outcome: "selected", optionId: request.options[index].optionId } };
    } finally { release(); peer.control?.setState("running"); }
   },
  });
  const abort = () => { void this.close(peer).catch(() => {}); };
  control.signal.addEventListener("abort", abort, { once: true });
  try {
  check();
  this.peers.set(id, peer);
  control.setState("starting", { file, extra: { fingerprint, usageKnown: harness === "pi" } });
  check();
  await peer.client.initialize(); check();
  if (harness === "pi" && restored) {
   const saved = restored.extra as { childFile?: string; childLeaf?: string | null } | undefined;
   if (saved?.childFile !== restored.sessionId || saved?.childLeaf === undefined) throw new Error("Pi resume checkpoint is missing or inconsistent; start a new run");
  }
  await peer.client.openSession({ cwd: ctx.cwd, mcpServers: [] }, restored?.sessionId); check();
  if (harness !== "pi") {
   await peer.client.setMode(definition.acpMode ?? this.safeMode(harness)); check();
   if (definition.acpModel) { await peer.client.setModel(definition.acpModel); check(); }
  }
  peer.resetBudget = resetBudget;
  if (local?.child) peer.usage = childUsage(local.child.manager);
  const currentModel = peer.client.sessionInfo?.configOptions?.find(option => option.id === "model")?.currentValue;
  control.setState("running", { sessionId: peer.client.sessionId, model: local ? `${local.child!.selection.modelObject.provider}/${local.child!.selection.modelObject.id}` : typeof currentModel === "string" ? currentModel : definition.acpModel,
   extra: { fingerprint, usageKnown: harness === "pi", childFile: local?.child?.manager.getSessionFile(), childLeaf: local?.child?.manager.getLeafId() } });
  return peer;
  } catch (error) {
   try { await this.close(peer); }
   finally { if (this.peers.get(id) === peer) this.peers.delete(id); }
   throw error;
  } finally { control.signal.removeEventListener("abort", abort); }
 }
 private async execute(id: string, task: string, ctx: ExtensionContext, control: RunControl, options: StartOptions, generation: number, fingerprint: string, restored?: RunInfo): Promise<RunOutcome> {
  const info = this.runs.get(id)!;
  const { writer, definition, harness, config } = this.validate(info.agent, ctx, { harness: info.harness as HarnessName });
  const check = () => {
   control.signal.throwIfAborted();
   if (this.stopped || generation !== this.generation || this.key(ctx) !== this.owner) throw new Error("Parent session changed");
   if (this.fingerprint(info.agent, ctx, info.harness as HarnessName) !== fingerprint) throw new Error("Delegate profile or parent constraints changed; start a new run");
  };
  const execute = async (): Promise<RunOutcome> => {
   check();
   let peer = this.peers.get(id);
   const abort = () => { if (peer) void peer.client.cancel().catch(() => {}); };
   control.signal.addEventListener("abort", abort, { once: true });
   let outcome: RunOutcome = {};
   let checkpoint: string | undefined;
   try {
    peer ??= await this.open(id, ctx, control, options, fingerprint, check, restored);
    check();
    peer.answer = ""; peer.control = control; peer.onUpdate = options.onUpdate;
    peer.reportedTokens = undefined; peer.promptTokensBase = 0;
    peer.resetBudget?.();
    control.setState("running");
    const native = peer.local?.child;
    const candidates = native ? this.requests.candidates(resolveSelection(config, definition.role, ctx), ctx) : [undefined];
    let error: string | undefined;
    for (const candidate of candidates) {
     check();
     if (candidate && native) {
      await native.session.setModel(candidate.modelObject); check(); native.session.setThinkingLevel(candidate.thinkingLevel);
     }
     try {
      const handoff = harness === "pi" ? task : `${await agentInstructions(definition)}\n\n<primary-constraints>\n${ctx.getSystemPrompt()}\n</primary-constraints>\n\n${task}`;
      check();
      if (peer.checkpointFile) {
       checkpoint = randomUUID();
       await updateJson(peer.checkpointFile, () => {
        check();
        return { sessionId: peer!.client.sessionId, nonce: checkpoint };
       });
       check();
       control.setState("running", { extra: { fingerprint, usageKnown: false, checkpoint } });
      }
      peer.log.append({ type: "prompt", task: handoff });
      check();
      peer.promptTokensBase = peer.reportedTokens ?? 0;
      const result = await peer.client.prompt([{ type: "text", text: handoff }]);
      if (!native && validTokens(result.usage?.totalTokens)) control.report({ reportedTokens: result.usage.totalTokens });
      peer.log.append({ type: "result", ...result });
      if (result.stopReason !== "end_turn") { error = `ACP prompt stopped: ${result.stopReason}`; break; }
      error = undefined; break;
     } catch (failure) {
      const tail = native?.session.messages.findLast(message => message.role === "assistant");
      error = tail?.role === "assistant" && tail.stopReason === "error" ? tail.errorMessage ?? "Native provider failed" : failure instanceof Error ? failure.message : "ACP prompt failed";
      if (!native || (!isRetryable(error) && !/quota|usage limit|credits/i.test(error))) break;
     }
    }
    outcome = { answer: peer.answer, error, sessionId: peer.client.sessionId };
    if (checkpoint) outcome.extra = { fingerprint, usageKnown: false, checkpoint };
    if (native) {
     const total = childUsage(native.manager), delta = emptyUsage();
     // Usage is cumulative in native storage; only this turn belongs in the result.
     for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) delta[key] = Math.max(0, total[key] - peer.usage[key]);
     for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) delta.cost[key] = Math.max(0, total.cost[key] - peer.usage.cost[key]);
     peer.usage = total;
     const tail = native.session.messages.findLast(message => message.role === "assistant");
     outcome.usage = delta;
     if (validTokens(delta.totalTokens)) control.report({ reportedTokens: delta.totalTokens });
     outcome.extra = { fingerprint, usageKnown: true, childFile: native.manager.getSessionFile(), childLeaf: native.manager.getLeafId() };
     if (tail?.role === "assistant") outcome.model = `${tail.provider}/${tail.model}`;
    }
    await peer.log.flush();
    return outcome;
   } catch (error) {
    peer ??= generation === this.generation ? this.peers.get(id) : undefined;
    if (peer) { try { await this.close(peer); } finally { if (this.peers.get(id) === peer) this.peers.delete(id); } }
    throw error;
   } finally {
    control.signal.removeEventListener("abort", abort);
    if (peer) {
     peer.control = undefined; peer.onUpdate = undefined;
     if (control.signal.aborted || generation !== this.generation) {
      try { await this.close(peer); } finally { if (this.peers.get(id) === peer) this.peers.delete(id); }
     }
    }
   }
  };
  check();
  if (!writer) return execute();
  let entered = false;
  let abort!: () => void;
  const cancelled = new Promise<RunOutcome>((_resolve, reject) => {
   abort = () => { if (!entered) reject(control.signal.reason); };
   control.signal.addEventListener("abort", abort, { once: true });
  });
  // The queued callback must remain behind the lease, even after its caller cancels.
  const queued = withFileMutationQueue(path.join(ctx.cwd, ".hempi-worker-lease"), async () => {
   if (control.signal.aborted) return {};
   entered = true;
   return execute();
  });
  if (control.signal.aborted) abort();
  return Promise.race([queued, cancelled]).finally(() => control.signal.removeEventListener("abort", abort));
 }
 private close(peer: Peer): Promise<void> {
  return peer.closing ??= (async () => {
   await Promise.allSettled([peer.client.shutdown(), peer.local?.close()]);
   await peer.log.flush();
  })();
 }
}
