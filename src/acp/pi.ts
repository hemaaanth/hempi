import * as acp from "@agentclientprotocol/sdk";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Child } from "../agents.ts";
import type { AcpTransport } from "./client.ts";

function visible(value: unknown): string {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) return "";
  return value.content.filter((block): block is { type: "text"; text: string } =>
    block?.type === "text" && typeof block.text === "string").map(block => block.text).join("");
}

/** One local native child, exposed only through ACP byte streams. */
export function createPiAcp(
  create: (sessionId?: string) => Promise<Child>,
  options: { supportsLoad?: boolean } = {},
): { transport: AcpTransport; close(): Promise<void>; readonly child: Child | undefined } {
  let input!: TransformStreamDefaultController<Uint8Array>;
  let output!: TransformStreamDefaultController<Uint8Array>;
  const toAgent = new TransformStream<Uint8Array, Uint8Array>({ start(c) { input = c; } });
  const toClient = new TransformStream<Uint8Array, Uint8Array>({ start(c) { output = c; } });
  let child: Child | undefined;
  let sessionId: string | undefined;
  let initialized = false;
  let opening = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let startup: Promise<void> | undefined;
  let active: { cancelled: boolean } | undefined;

  function check(id?: string) {
    if (closed) throw new Error("Local ACP adapter closed");
    if (!initialized) throw new Error("Initialize ACP first");
    if (id !== undefined && (!child || id !== sessionId)) throw new Error("Unknown ACP session");
  }
  async function open(request: acp.NewSessionRequest, resume?: string) {
    check();
    if (opening || child) throw new Error("ACP session already exists");
    if (request.mcpServers.length) throw new Error("Local ACP does not support MCP servers");
    opening = true;
    startup = (async () => {
      const next = await create(resume);
      if (closed || next.manager.getCwd() !== request.cwd) {
        await next.stop();
        throw new Error(closed ? "Local ACP adapter closed" : "ACP cwd must exactly match child cwd");
      }
      child = next;
      sessionId = resume ?? next.manager.getSessionFile() ?? next.manager.getSessionId();
    })();
    try { await startup; return { sessionId: sessionId! }; }
    finally { opening = false; }
  }
  const connection = new acp.AgentSideConnection(client => ({
    initialize: () => {
      if (closed) throw new Error("Local ACP adapter closed");
      initialized = true;
      return { protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: options.supportsLoad ?? false, promptCapabilities: {} } };
    },
    authenticate: () => { throw new Error("Authentication is managed by the local child factory"); },
    newSession: request => open(request),
    loadSession: async request => {
      if (!options.supportsLoad) throw new Error("Loading sessions is not supported");
      await open(request, request.sessionId);
      return {};
    },
    cancel: async request => {
      check(request.sessionId);
      if (active) { active.cancelled = true; await child!.session.abort(); }
    },
    prompt: async request => {
      check(request.sessionId);
      if (active) throw new Error("ACP prompt already active");
      if (request.prompt.some(block => block.type !== "text")) throw new Error("Local ACP accepts text only");
      const current = child!;
      const run = active = { cancelled: false };
      let delivery = Promise.resolve();
      let deliveryError: unknown;
      let deltas = false;
      let reportedTokens = 0;
      let tail: { stopReason?: string; errorMessage?: string } | undefined;
      const start = current.session.messages.length;
      const send = (update: acp.SessionNotification["update"], _meta?: acp.SessionNotification["_meta"]) => {
        delivery = delivery.then(() => client.sessionUpdate({ sessionId: request.sessionId, update, ...(_meta ? { _meta } : {}) }))
          .catch(error => { deliveryError ??= error; });
      };
      const text = (value: string) => {
        if (value) send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
      };
      const onEvent = (event: AgentSessionEvent) => {
        if (event.type === "message_start" && event.message.role === "assistant") deltas = false;
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          deltas = true;
          text(event.assistantMessageEvent.delta);
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          tail = event.message;
          if (!deltas) text(visible(event.message));
          const tokens = event.message.usage?.totalTokens;
          if (Number.isSafeInteger(tokens) && tokens >= 0 && Number.isSafeInteger(reportedTokens + tokens)) {
            reportedTokens += tokens;
            send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
              { hempi: { reportedTokens } });
          }
          deltas = false;
        } else if (event.type === "tool_execution_start") {
          send({ sessionUpdate: "tool_call", toolCallId: event.toolCallId,
            title: event.toolName, status: "in_progress" });
        } else if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
          const ended = event.type === "tool_execution_end";
          const output = visible(ended ? event.result : event.partialResult).slice(0, 4000);
          send({ sessionUpdate: "tool_call_update", toolCallId: event.toolCallId,
            status: ended ? (event.isError ? "failed" : "completed") : "in_progress",
            content: [{ type: "content", content: { type: "text", text: output } }] });
        }
      };
      const unsubscribe = current.session.subscribe(onEvent);
      let failed: unknown;
      try {
        current.resetBudget();
        await current.session.prompt(request.prompt.map(block => block.type === "text" ? block.text : "").join("\n"),
          { expandPromptTemplates: false });
        const last = current.session.messages.slice(start).findLast(message => message.role === "assistant");
        if (last?.role === "assistant") tail = last;
      } catch (error) { failed = error; }
      finally { unsubscribe(); }
      try {
        await delivery;
        if (deliveryError) throw deliveryError;
        if (run.cancelled || tail?.stopReason === "aborted") return { stopReason: "cancelled" };
        if (failed) throw failed;
        if (tail?.stopReason === "error") throw new Error(tail.errorMessage || "Local ACP provider failed");
        return { stopReason: "end_turn" };
      } finally { if (active === run) active = undefined; }
    },
  }), acp.ndJsonStream(toClient.writable, toAgent.readable));

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    if (active) active.cancelled = true;
    input.error(new Error("Local ACP adapter closed"));
    output.error(new Error("Local ACP adapter closed"));
    closing = (async () => {
      // A factory resolving after shutdown still owns resources that must be stopped.
      await startup?.catch(() => {});
      await child?.stop();
    })();
    return closing;
  }
  connection.signal.addEventListener("abort", () => { void close().catch(() => {}); }, { once: true });
  return { transport: { readable: toClient.readable, writable: toAgent.writable }, close,
    get child() { return child; } };
}
