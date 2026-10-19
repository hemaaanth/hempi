import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type Message, type Model, type ModelsSimpleStreamOptions, type Usage } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { convertToLlm, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSelection, type Config, type Selection, type Tier } from "./config.ts";
import { Secrets } from "./safety.ts";

export function emptyUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
export function addUsage(total: Usage, usage: Usage): void {
 for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key] ?? 0;
 for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost?.[key] ?? 0;
 if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
}
export function visibleText(message: AssistantMessage): string { return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim(); }
export function contextFingerprint(messages: AgentMessage[]): string { return createHash("sha256").update(JSON.stringify(messages)).digest("hex"); }
export function isRetryable(message: string): boolean { return /\b(429|500|502|503|504)\b|rate.?limit|overloaded|temporar|timeout|timed out|connection|network|fetch failed|socket/i.test(message) && !/quota|insufficient|billing|usage limit|credits|budget/i.test(message); }
export function isQuota(message: string): boolean { return /quota|insufficient|billing|usage limit|credits|budget/i.test(message); }
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
 signal?.throwIfAborted();
 await new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Aborted")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  signal?.addEventListener("abort", abort, { once: true });
 });
}
export function supportedFast(model: Model<Api>): boolean {
 return model.provider === "openai-codex" || model.provider === "openai" || (model.provider === "anthropic" && /^claude-opus-(?:5(?:-5)?|4-8)(?:-\d{8})?$/.test(model.id));
}
export async function inheritedTier(): Promise<Tier> {
 try {
  const saved: unknown = JSON.parse(await fs.readFile(path.join(getAgentDir(), "fast-mode.json"), "utf8"));
  return saved && typeof saved === "object" && "enabled" in saved && saved.enabled === true ? "priority" : "standard";
 } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "standard"; throw new Error(`Cannot read fast-mode.json: ${error}`); }
}
export function applyPayloadPolicy(payload: unknown, model: Model<Api>, tier: Tier, cacheKey?: string): unknown {
 if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
 const result = { ...payload } as Record<string, unknown>;
 // Cache-key fields are provider contracts. Routing remains isolated via a fresh UUID and SSE.
 if (cacheKey !== undefined) for (const key of ["prompt_cache_key", "promptCacheKey"]) if (Object.hasOwn(result, key)) result[key] = cacheKey;
 if (tier === "priority" && supportedFast(model)) {
  if (model.provider === "anthropic") result.speed = "fast";
  else result.service_tier = "priority";
 } else if (tier === "flex") {
  if (!["openai", "openai-codex"].includes(model.provider)) throw new Error(`Flex tier is not supported by ${model.provider}`);
  result.service_tier = "flex";
 } else if (tier === "standard") {
  // An explicit standard workload must not inherit a stale premium payload.
  if (result.service_tier === "priority" || result.service_tier === "flex") delete result.service_tier;
  if (result.speed === "fast") delete result.speed;
 }
 return result;
}
export interface RequestRecord { kind: string; model: string; usage: Usage; timestamp: number; requestId: string }
/** Shared broker-backed request policy; no direct OAuth refresh or private session access. */
export class Requests {
 readonly records: RequestRecord[] = [];
 readonly totals = emptyUsage();
 readonly #cooldown = new Map<string, number>();
 readonly #pi: ExtensionAPI;
 readonly #config: () => Config;
 #cacheKey?: string;
 #cacheModel?: string;
 #snapshot?: { messages: AgentMessage[]; sourceLength: number; sourceFingerprint: string; sessionId: string };
 #partial?: AssistantMessage;
 #parentSessionId?: string;
 #generation = 0;
 constructor(pi: ExtensionAPI, config: () => Config) {
  this.#pi = pi; this.#config = config;
  pi.on("context_with_system", (event, ctx) => {
   const source = ctx.sessionManager.buildSessionProjection().messages;
   this.#snapshot = { messages: structuredClone(event.messages), sourceLength: source.length, sourceFingerprint: contextFingerprint(source), sessionId: ctx.sessionManager.getSessionId() };
  });
  pi.on("before_provider_request", (event, ctx) => {
   if (!event.payload || typeof event.payload !== "object") return;
   const payload = event.payload as Record<string, unknown>;
   const key = payload.prompt_cache_key ?? payload.promptCacheKey;
   if (typeof key === "string") { this.#cacheKey = key; this.#cacheModel = `${ctx.model?.provider}/${ctx.model?.id}`; }
  });
  pi.on("message_update", (event) => { if (event.message.role === "assistant") this.#partial = event.message; });
  pi.on("message_end", (event) => { if (event.message.role === "assistant") this.#partial = undefined; });
  pi.on("session_start", (_event, ctx) => {
   this.#generation++; this.reset(); this.#parentSessionId = ctx.sessionManager.getSessionId();
   this.records.length = 0; Object.assign(this.totals, emptyUsage());
   for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === "hempi.usage") {
    const record = entry.data as RequestRecord;
    if (record && typeof record.kind === "string" && typeof record.model === "string" && record.usage && typeof record.usage.cost?.total === "number") { this.records.push(record); addUsage(this.totals, record.usage); }
   }
  });
  pi.on("session_compact", () => this.reset());
  pi.on("session_tree", (_event, ctx) => { this.#generation++; this.reset(); this.#parentSessionId = ctx.sessionManager.getSessionId(); this.records.length = 0; Object.assign(this.totals, emptyUsage()); for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === "hempi.usage") { const record = entry.data as RequestRecord; if (record?.usage?.cost && typeof record.kind === "string") { this.records.push(record); addUsage(this.totals, record.usage); } } });
 }
 reset(): void { this.#cacheKey = undefined; this.#cacheModel = undefined; this.#snapshot = undefined; this.#partial = undefined; this.#cooldown.clear(); }
 snapshot(ctx: ExtensionContext): Message[] {
  const source = ctx.sessionManager.buildSessionProjection().messages;
  const saved = this.#snapshot;
  const captured = saved?.sessionId === ctx.sessionManager.getSessionId() && source.length >= saved.sourceLength && contextFingerprint(source.slice(0, saved.sourceLength)) === saved.sourceFingerprint ? saved : undefined;
  let messages = captured ? [...captured.messages, ...source.slice(captured.sourceLength)] : [...source];
  messages = structuredClone(messages);
  if (!messages.some((message) => message.role === "system")) {
   const active = new Set(this.#pi.getActiveTools());
   messages.unshift({ role: "system", content: ctx.getSystemPrompt(), timestamp: 0, toolsAdded: this.#pi.getAllTools().filter((tool) => active.has(tool.name)).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) });
  }
  if (this.#partial) {
   // Partial thinking signatures / half-parsed tools cannot safely be replayed.
   const partial = structuredClone(this.#partial);
   partial.content = partial.content.filter((block) => block.type === "text");
   partial.stopReason = "stop";
   if (partial.content.length) messages.push(partial);
  }
  return repairPendingTools(convertToLlm(messages));
 }
 options(selection: Selection, kind: string, identity: string, ctx: ExtensionContext, overrides: ModelsSimpleStreamOptions = {}, cacheKey?: string): ModelsSimpleStreamOptions {
  const model = selection.modelObject;
  const requestedMax = selection.maxTokens ?? overrides.maxTokens ?? 8192;
  if (!Number.isSafeInteger(requestedMax) || requestedMax <= 0) throw new Error("maxTokens must be a positive safe integer");
  const maxTokens = model.maxTokens > 0 ? Math.min(requestedMax, model.maxTokens) : requestedMax;
  // Codex ignores maxTokens in Pi 1.0; stream() adds a conservative visible-byte limit.
  const thinkingLevel = clampThinkingLevel(model, selection.thinkingLevel);
  const tier = selection.tier ?? (kind === "advisor" ? "standard" : "inherit");
  return {
   ...overrides, apiKey: undefined, headers: undefined, env: undefined,
   sessionId: identity, transport: "sse", maxTokens,
   temperature: selection.temperature ?? overrides.temperature,
   reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
   // Keep token-budget thinking inside the explicit total output cap.
   thinkingBudgets: { minimal: Math.min(1024, Math.floor(maxTokens / 2)), low: Math.min(2048, Math.floor(maxTokens / 2)), medium: Math.min(4096, Math.floor(maxTokens / 2)), high: Math.min(8192, Math.floor(maxTokens / 2)) },
   maxRetries: 0,
   timeoutMs: overrides.timeoutMs ?? 300000,
   onPayload: async (payload, requestModel) => {
    const transformed = overrides.onPayload ? await overrides.onPayload(payload, requestModel) ?? payload : payload;
    const effectiveTier = tier === "inherit" ? await inheritedTier() : tier;
    return applyPayloadPolicy(transformed, requestModel, effectiveTier, cacheKey);
   },
   transformHeaders: async (headers) => {
    const result = { ...headers };
    const effectiveTier = tier === "inherit" ? await inheritedTier() : tier;
    if (effectiveTier === "priority" && model.provider === "anthropic" && supportedFast(model)) {
     const key = Object.keys(result).find((name) => name.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
     const betas = String(result[key] ?? "").split(",").filter(Boolean);
     if (!betas.includes("fast-mode-2026-02-01")) betas.push("fast-mode-2026-02-01");
     result[key] = betas.join(",");
    }
    return result;
   },
  };
 }
 stream(selection: Selection, context: Context, kind: string, identity: string, ctx: ExtensionContext, overrides: ModelsSimpleStreamOptions = {}, reuseMainCache = false): AssistantMessageEventStream {
  const cacheKey = reuseMainCache && this.#cacheModel === `${selection.modelObject.provider}/${selection.modelObject.id}` ? this.#cacheKey : undefined;
  const controller = new AbortController();
  const parent = overrides.signal;
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true }); if (parent?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000); timer.unref?.();
  const localCap = selection.modelObject.api === "openai-codex-responses" || !!(selection.modelObject.compat && "supportsMaxOutputTokens" in selection.modelObject.compat && selection.modelObject.compat.supportsMaxOutputTokens === false);
  const output = createAssistantMessageEventStream();
  const owner = ctx.sessionManager.getSessionId(); const generation = this.#generation;
  const finish = (original: AssistantMessage) => {
   let message = original;
   try { if (generation === this.#generation) this.record(kind, message, randomUUID(), owner); }
   catch (error) { message = { ...message, stopReason: "error", errorMessage: `Could not persist request usage: ${error}` }; }
   output.push(message.stopReason === "error" || message.stopReason === "aborted" ? { type: "error", reason: message.stopReason, error: message } : { type: "done", reason: message.stopReason === "pending" ? "deferred" : message.stopReason, message }); output.end(message);
  };
  void (async () => {
   let partial: AssistantMessage | undefined;
   try {
    const options = this.options(selection, kind, identity, ctx, { ...overrides, signal: controller.signal }, cacheKey);
    const byteLimit = options.maxTokens ?? 8192;
    // Redact every advisor request, including native tool results and compaction context, on a copy only.
    const secrets = kind === "advisor" ? await Secrets.create(ctx, selection.modelObject) : undefined;
    const outbound: Context = secrets ? JSON.parse(JSON.stringify(context, (_key, value) => {
     // Signed replay blocks are opaque contracts; neither their content nor metadata may be rewritten.
     if (value && typeof value === "object" && ["thinkingSignature", "textSignature", "thoughtSignature"].some(key => typeof value[key] === "string")) {
      const original = JSON.stringify(value);
      const redacted = JSON.stringify(value, (_key, part) => typeof part === "string" ? secrets.text(part) : part);
      if (original !== redacted) throw new Error("Advisor context cannot be safely redacted for signed replay");
     }
     return typeof value === "string" ? secrets.text(value) : value;
    })) : context;
    const raw = ctx.modelRegistry.streamSimple(selection.modelObject, outbound, options);
    for await (const event of raw) {
     if ("partial" in event) partial = event.partial;
     if (localCap && partial && Buffer.byteLength(partial.content.map((block) => block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : JSON.stringify(block.arguments)).join(""), "utf8") > byteLimit) {
      controller.abort();
      let reported: AssistantMessage | undefined;
      try { reported = await Promise.race([raw.result(), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1000))]); } catch {}
      const hasCall = partial.content.some((block) => block.type === "toolCall");
      const text = Buffer.from(visibleText(partial)).subarray(0, byteLimit).toString("utf8").replace(/\uFFFD$/, "");
      const message: AssistantMessage = { ...partial, usage: reported?.usage ?? partial.usage, content: [{ type: "text", text }], stopReason: hasCall ? "error" : "length", ...(hasCall ? { errorMessage: "Client output limit reached before tool arguments completed; no tool was dispatched" } : {}) };
      if (event.type === "start") output.push({ type: "start", partial: message });
      finish(message); return;
     }
     if (event.type === "done" || event.type === "error") {
      let message = event.type === "done" ? event.message : event.error;
      if (timedOut) message = { ...message, stopReason: "error", errorMessage: "Side request timed out after 120 seconds" };
      finish(message); return;
     }
     output.push(event);
    }
    finish(await raw.result());
   } catch (error) {
    const message: AssistantMessage = { ...(partial ?? { role: "assistant", api: selection.modelObject.api, provider: selection.modelObject.provider, model: selection.modelObject.id, content: [], usage: emptyUsage(), timestamp: Date.now() }), stopReason: parent?.aborted ? "aborted" : "error", errorMessage: timedOut ? "Side request timed out after 120 seconds" : String(error) };
    finish(message);
   } finally { clearTimeout(timer); parent?.removeEventListener("abort", abort); }
  })();
  return output;
 }
 record(kind: string, message: AssistantMessage, requestId = randomUUID(), parentSessionId?: string): void {
  if (parentSessionId && this.#parentSessionId && parentSessionId !== this.#parentSessionId) return;
  const record = { kind, model: `${message.provider}/${message.model}`, usage: structuredClone(message.usage), timestamp: Date.now(), requestId };
  this.#pi.appendEntry("hempi.usage", record);
  this.records.push(record); addUsage(this.totals, record.usage); this.#pi.events?.emit("hempi:usage", record);
 }
 candidates(selection: Selection, ctx: ExtensionContext): Selection[] {
  const candidates = [selection, ...(selection.fallbacks ?? []).map((selector) => {
   const fallback = resolveSelection(this.#config(), selector, ctx, { model: selection.modelObject, thinkingLevel: selection.thinkingLevel });
   return { ...fallback, tier: fallback.tier ?? selection.tier, maxTokens: fallback.maxTokens ?? selection.maxTokens, temperature: fallback.temperature ?? selection.temperature };
  })];
  const unique = new Map<string, Selection>();
  for (const candidate of candidates) {
   const model = candidate.modelObject;
   const key = `${model.provider}/${model.id}`;
   if (!ctx.modelRegistry.hasConfiguredAuth(model)) continue;
   if (!unique.has(key)) unique.set(key, candidate);
  }
  const all = [...unique.values()];
  if (!all.length) throw new Error("No configured credentials for this role or its fallback models");
  const ready = all.filter((candidate) => (this.#cooldown.get(`${candidate.modelObject.provider}/${candidate.modelObject.id}`) ?? 0) <= Date.now());
  return ready.length ? ready : all;
 }
 /** Single read-only completion, with visible output never silently mixed across retries. */
 async complete(selection: Selection, context: Context, kind: string, identity: string, ctx: ExtensionContext, signal: AbortSignal, onDelta?: (text: string, restart: boolean) => void, reuseMainCache = false): Promise<AssistantMessage> {
  let last: Error | undefined;
  for (const candidate of this.candidates(selection, ctx)) {
   for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    let emitted = false;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
     if (last) onDelta?.("", true);
     const stream = this.stream(candidate, context, kind, identity, ctx, { signal: combined, toolChoice: "none" }, reuseMainCache);
     for await (const event of stream) {
      signal.throwIfAborted();
      if (event.type === "text_delta") { emitted = true; onDelta?.(event.delta, false); }
     }
     const response = await stream.result();
     if (response.stopReason === "aborted") throw signal.reason ?? new Error("Request aborted");
     if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Provider request failed");
     if (response.content.some((block) => block.type === "toolCall")) throw new Error("The read-only side request attempted to call tools; none were executed");
     if (!visibleText(response)) throw new Error("The model returned no visible answer");
     return response;
    } catch (error) {
     controller.abort();
     if (signal.aborted) throw signal.reason ?? error;
     last = error instanceof Error ? error : new Error(String(error));
     if (!isRetryable(last.message) || emitted || attempt === 2) break;
     await delay(250 * 2 ** attempt, signal);
    }
   }
   this.#cooldown.set(`${candidate.modelObject.provider}/${candidate.modelObject.id}`, Date.now() + 60000);
  }
  throw last ?? new Error("No model could answer the side request");
 }
}
/** Preserve finalized native history and make a mid-tool snapshot legal without executing anything. */
export function repairPendingTools(messages: Message[]): Message[] {
 const result: Message[] = [];
 const pending = new Map<string, { name: string; timestamp: number }>();
 for (const message of messages) {
  if (message.role === "toolResult") pending.delete(message.toolCallId);
  else if (message.role !== "system" && pending.size) flush();
  result.push(message);
  if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") pending.set(block.id, { name: block.name, timestamp: message.timestamp });
 }
 flush();
 return result;
 function flush() {
  for (const [id, call] of pending) result.push({ role: "toolResult", toolCallId: id, toolName: call.name, content: [{ type: "text", text: "This tool had not completed at the time of the read-only side snapshot. No result is available yet." }], isError: false, timestamp: call.timestamp });
  pending.clear();
 }
}
