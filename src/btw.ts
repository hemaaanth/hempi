import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { CustomEditor, convertToLlm, copyToClipboard, getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, getKeybindings, matchesKey, wrapTextWithAnsi, type TUI, type Component } from "@earendil-works/pi-tui";
import { resolveSelection, type Config } from "./config.ts";
import { contextFingerprint, Requests, visibleText } from "./requests.ts";
import { panel, promptInline, selectInline, safeText } from "./ui.ts";
import { promptFile } from "./agents.ts";

type Status = "running" | "complete" | "cancelled" | "error";
export interface SideTurn { question: string; answer: string; status: Status; createdAt: number; updatedAt: number; assistant?: AssistantMessage; error?: string; usage?: Usage }
export interface Topic { id: string; identity: string; turns: SideTurn[]; mainFingerprint: string; mainModel: string; mainThinking?: string; promotable?: boolean }
interface View { topic: Topic; offset?: number; copied?: boolean }
export class Btw {
 readonly #pi: ExtensionAPI;
 readonly #requests: Requests;
 readonly #config: () => Config;
 #view?: View;
 #active?: { controller: AbortController; promise: Promise<void> };
 #input?: AbortController;
 #ctx?: ExtensionCommandContext;
 #tui?: TUI;
 #unsubscribe?: () => void;
 #topics = new Map<string, Topic>();
 #scrollHeight = 1;
 #saveFailure?: Topic;
 #generation = 0;
 constructor(pi: ExtensionAPI, requests: Requests, config: () => Config) { this.#pi = pi; this.#requests = requests; this.#config = config; }
 #latest(topic: Topic): SideTurn { return topic.turns[topic.turns.length - 1]; }
 #persist(topic: Topic): void {
  try { this.#pi.appendEntry("hempi.btw", structuredClone(topic)); this.#saveFailure = undefined; }
  catch (error) { this.#saveFailure = topic; throw error; }
 }
 #render(ctx: ExtensionContext): void {
  ctx.ui.setWidget("btw", (screen, theme) => {
   this.#tui = screen;
   let markdown: Markdown | undefined;
   let previous = "";
   return {
    invalidate() { markdown = undefined; },
    render: (width: number) => {
     if (!this.#view) return [];
     const view = this.#view;
     const turn = this.#latest(view.topic);
     const inner = Math.max(1, width - 4);
     const answer = safeText(turn.answer.trim());
     if (!markdown || previous !== answer) { markdown = new Markdown(answer, 0, 0, getMarkdownTheme()); previous = answer; }
     const lines = turn.status === "error" ? wrapTextWithAnsi(theme.fg("error", safeText(turn.error ?? "Side request failed")), inner)
      : answer ? markdown.render(inner) : [theme.fg("dim", turn.status === "running" ? "Waiting for response…" : "No text returned.")];
     this.#scrollHeight = Math.max(1, Math.min(14, Math.floor(screen.terminal.rows * 0.4) - 5));
     const maxOffset = Math.max(0, lines.length - this.#scrollHeight);
     const offset = Math.max(0, Math.min(view.offset ?? (turn.status === "running" ? maxOffset : 0), maxOffset));
     let footer = turn.status === "running" ? "Esc cancel"
      : turn.status === "complete" ? `${view.copied ? "✓ Copied · " : ""}f follow-up · c copy · b branch · Esc close${turn.usage ? ` · $${turn.usage.cost.total.toFixed(4)}` : ""}`
      : `${turn.status === "cancelled" ? "Cancelled" : "Error"} · f retry/follow-up · Esc close`;
     if (maxOffset) footer += " · Ctrl+Alt+↑↓ scroll";
     const count = view.topic.turns.length > 1 ? ` [turn ${view.topic.turns.length}]` : "";
     return panel(theme, width, `/btw ${safeText(turn.question)}${count}`, ["", ...lines.slice(offset, offset + this.#scrollHeight), ""], footer, false);
    },
   };
  }, { placement: "aboveEditor" });
 }
 async stop(ctx?: ExtensionContext): Promise<boolean> {
  this.#generation++;
  this.#input?.abort(); this.#input = undefined;
  this.#active?.controller.abort();
  const active = this.#active;
  if (active) await active.promise;
  if (this.#saveFailure) {
   try { this.#persist(this.#saveFailure); } catch (error) { (ctx ?? this.#ctx)?.ui.notify(`BTW history is unsaved; session change stopped: ${error}`, "error"); return false; }
  }
  this.#view = undefined;
  (ctx ?? this.#ctx)?.ui.setWidget("btw", undefined);
  return true;
 }
 #restore(ctx: ExtensionContext): void {
  this.#topics.clear();
  for (const entry of ctx.sessionManager.getBranch()) {
   if (entry.type !== "custom") continue;
   if (entry.customType === "hempi.btw") {
    const topic = entry.data as Topic;
    if (!topic || typeof topic.id !== "string" || !Array.isArray(topic.turns) || !topic.turns.length || !topic.turns.every((turn) => typeof turn.question === "string" && typeof turn.answer === "string")) continue;
    const copy = structuredClone(topic);
    for (const turn of copy.turns) if (turn.status === "running") { turn.status = "cancelled"; turn.error = "The previous process exited before this request completed."; }
    this.#topics.set(copy.id, copy);
   } else if (entry.customType === "btw") {
    const old = entry.data as { question?: string; answer?: string; timestamp?: number; usage?: Usage };
    if (typeof old?.question !== "string" || typeof old?.answer !== "string") continue;
    this.#topics.set(entry.id, { id: entry.id, identity: randomUUID(), mainFingerprint: "", mainModel: "", turns: [{ question: old.question, answer: old.answer, status: "complete", createdAt: old.timestamp ?? 0, updatedAt: old.timestamp ?? 0, usage: old.usage }] });
   }
  }
 }
 async ask(question: string, ctx: ExtensionCommandContext, topicId?: string): Promise<void> {
  if (this.#active) throw new Error("A side question is running; Esc cancels it first");
  question = question.trim(); if (!question) return;
  this.#ctx = ctx;
  const generation = this.#generation;
  const config = this.#config();
  const selection = resolveSelection(config, config.btw.role, ctx);
  selection.maxTokens = selection.maxTokens ?? config.btw.maxTokens;
  const snapshot = this.#requests.snapshot(ctx);
  const prefix = await promptFile("btw");
  if (generation !== this.#generation) return;
  const prior = topicId ? this.#topics.get(topicId) : undefined;
  if (topicId && !prior) throw new Error("The selected side conversation is unavailable");
  const history: Message[] = [];
  for (const turn of prior?.turns ?? []) {
   history.push({ role: "user", content: [{ type: "text", text: `${prefix}\n\n${turn.question}` }], timestamp: turn.createdAt });
   if (turn.answer) history.push(turn.assistant ? { ...structuredClone(turn.assistant), content: [{ type: "text", text: turn.answer }] } : {
    role: "assistant", content: [{ type: "text", text: turn.answer }], provider: selection.modelObject.provider, model: selection.modelObject.id, api: selection.modelObject.api,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: turn.updatedAt,
   });
  }
  const now = Date.now();
  const topic: Topic = prior ? structuredClone(prior) : { id: randomUUID(), identity: randomUUID(), turns: [], mainFingerprint: contextFingerprint(ctx.sessionManager.buildSessionProjection().messages), mainModel: `${ctx.model?.provider}/${ctx.model?.id}`, mainThinking: ctx.thinkingLevel, promotable: ctx.isIdle() };
  if (prior && this.#latest(prior).status !== "complete") topic.identity = randomUUID();
  const turn: SideTurn = { question, answer: "", status: "running", createdAt: now, updatedAt: now };
  topic.turns.push(turn);
  const context = { messages: [...snapshot, ...history, { role: "user" as const, content: [{ type: "text" as const, text: `${prefix}\n\n${question}` }], timestamp: now }] };
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > config.btw.maxContextBytes) throw new Error(`BTW snapshot exceeds ${config.btw.maxContextBytes} bytes. Compact the main conversation or raise btw.maxContextBytes.`);
  if (this.#saveFailure) this.#persist(this.#saveFailure);
  this.#persist(topic); // No billed request before durable initial history succeeds.
  this.#topics.set(topic.id, topic); this.#view = { topic };
  this.#render(ctx);
  const controller = new AbortController();
  const active = { controller, promise: Promise.resolve() };
  this.#active = active;
  active.promise = (async () => {
   try {
    const response = await this.#requests.complete(selection, context, "btw", topic.identity, ctx, controller.signal, (delta, restart) => {
     turn.answer = restart ? "" : turn.answer + delta; turn.updatedAt = Date.now(); this.#tui?.requestRender();
    }, true);
    turn.answer = visibleText(response) + (response.stopReason === "length" ? "\n\n[Output limit reached.]" : "");
    turn.assistant = response; turn.usage = response.usage; turn.status = "complete";
    if (this.#view?.topic === topic) this.#view.offset = 0;
   } catch (error) {
    turn.status = controller.signal.aborted ? "cancelled" : "error";
    turn.error = error instanceof Error ? error.message : String(error);
   } finally {
    turn.updatedAt = Date.now();
    try { this.#persist(topic); } catch (error) { ctx.ui.notify(`BTW answer remains in memory but could not be saved: ${error}`, "error"); }
    if (this.#active === active) this.#active = undefined;
    this.#tui?.requestRender();
   }
  })();
 }
 async history(ctx: ExtensionCommandContext): Promise<void> {
  this.#ctx = ctx;
  const topics = [...this.#topics.values()].reverse();
  if (!topics.length) { ctx.ui.notify("No side answers yet. Use /btw <question>.", "info"); return; }
  const selected = topics.length === 1 ? 0 : await selectInline(ctx, "/btw history", topics.map((topic) => ({ label: topic.turns[0].question, description: `${topic.turns.length} turn(s) · ${this.#latest(topic).status}` })));
  if (selected !== null) { this.#view = { topic: topics[selected] }; this.#render(ctx); }
 }
 async followup(ctx: ExtensionCommandContext, question?: string): Promise<void> {
  const topic = this.#view?.topic ?? [...this.#topics.values()].at(-1);
  if (!topic) throw new Error("Open a saved BTW conversation first");
  this.#input = new AbortController();
  const text = question ?? await promptInline(ctx, "/btw follow-up", `Continue: ${topic.turns[0].question}`, this.#input.signal);
  this.#input = undefined;
  if (text) await this.ask(text, ctx, topic.id);
 }
 async branch(ctx: ExtensionCommandContext): Promise<void> {
  const topic = this.#view?.topic;
  if (!topic || !topic.promotable || topic.turns.length !== 1 || this.#latest(topic).status !== "complete" || this.#latest(topic).assistant?.stopReason !== "stop") throw new Error("Branch promotion requires one completed, unmodified side turn");
  if (!ctx.isIdle()) throw new Error("Wait for the main agent to become idle before branching");
  const messages = structuredClone(ctx.sessionManager.buildSessionProjection().messages);
  if (contextFingerprint(messages) !== topic.mainFingerprint || `${ctx.model?.provider}/${ctx.model?.id}` !== topic.mainModel || ctx.thinkingLevel !== topic.mainThinking) throw new Error("The main conversation changed since this side question; use a new /btw before branching");
  const turn = structuredClone(this.#latest(topic));
  const model = ctx.model;
  const thinking = ctx.thinkingLevel ?? "off";
  const parent = ctx.sessionManager.getSessionFile();
  const primary = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "hempi.primary");
  // Pi exposes cached-message insertion through newSession.setup, not through fork's readonly context.
  await ctx.newSession({ parentSession: parent, setup: async (manager) => {
   if (model) manager.appendModelChange(model.provider, model.id);
   manager.appendThinkingLevelChange(thinking);
   if (primary?.type === "custom") manager.appendCustomEntry(primary.customType, structuredClone(primary.data));
   for (const message of convertToLlm(messages)) manager.appendMessage(message);
   manager.appendMessage({ role: "user", content: turn.question, timestamp: turn.createdAt });
   manager.appendMessage(turn.assistant!);
   manager.appendCustomEntry("hempi.btw-promoted", { topicId: topic.id, sourceSession: parent });
  } });
 }
 register(): void {
  this.#pi.on("session_start", (_event, ctx) => {
   this.#restore(ctx); this.#unsubscribe?.();
   if (ctx.mode !== "tui") return;
   this.#unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!this.#view || this.#tui?.hasOverlay()) return;
    const focus = (this.#tui as TUI & { getFocusedComponent?(): Component | null } | undefined)?.getFocusedComponent?.();
    if (focus && (!(focus instanceof CustomEditor) || focus.isShowingAutocomplete())) return;
    if (getKeybindings().matches(data, "app.interrupt") || matchesKey(data, "escape")) {
     if (this.#active && !this.#active.controller.signal.aborted) { this.#active.controller.abort(); this.#latest(this.#view.topic).status = "cancelled"; this.#tui?.requestRender(); }
     else { this.#view = undefined; ctx.ui.setWidget("btw", undefined); }
     return { consume: true };
    }
    if (matchesKey(data, "ctrl+alt+up") || matchesKey(data, "ctrl+alt+down")) {
     this.#view.offset = Math.max(0, (this.#view.offset ?? 0) + (matchesKey(data, "ctrl+alt+up") ? -this.#scrollHeight : this.#scrollHeight)); this.#tui?.requestRender(); return { consume: true };
    }
    if (ctx.ui.getEditorText().trim() || !this.#ctx || this.#active) return;
    const commandCtx = this.#ctx;
    if (data === "f") { void this.followup(commandCtx).catch((error) => ctx.ui.notify(String(error), "error")); return { consume: true }; }
    if (data === "b") { void this.branch(commandCtx).catch((error) => ctx.ui.notify(String(error), "error")); return { consume: true }; }
    if (data === "c" && this.#latest(this.#view.topic).status === "complete") {
     const view = this.#view;
     void copyToClipboard(this.#latest(view.topic).answer).then(() => { if (this.#view === view) { view.copied = true; this.#tui?.requestRender(); } }).catch((error) => ctx.ui.notify(String(error), "error"));
     return { consume: true };
    }
   });
  });
  this.#pi.on("session_tree", (_event, ctx) => { this.#restore(ctx); });
  this.#pi.on("session_shutdown", () => { this.#unsubscribe?.(); this.#unsubscribe = undefined; });
  this.#pi.registerCommand("btw", {
   description: "Independent cached-prefix side questions. Bare /btw opens history; /btw followup continues the selected topic; /btw branch promotes a single answer.",
   handler: async (args, ctx) => {
    if (ctx.mode !== "tui") { ctx.ui.notify("/btw requires the interactive TUI", "error"); return; }
    try {
     if (!args.trim() || args.trim() === "history") await this.history(ctx);
     else if (args.trim() === "branch") await this.branch(ctx);
     else if (args.trim() === "followup" || args.startsWith("followup ")) await this.followup(ctx, args.slice(8).trim() || undefined);
     else await this.ask(args, ctx);
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
   },
  });
 }
}
