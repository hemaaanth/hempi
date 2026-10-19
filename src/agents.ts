import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
 createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
 getAgentDir, parseFrontmatter,
 type AgentSession, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { READ_TOOLS, mergeConfig, validName, type AgentDefinition, type Config, type Selection } from "./config.ts";
import { addUsage, emptyUsage, Requests } from "./requests.ts";
import { DelegateRuns } from "./acp/delegates.ts";
import type { RunState } from "./acp/runs.ts";
import { HARNESS_NAMES, type HarnessName } from "./config.ts";

const promptsDir = fileURLToPath(new URL("../prompts/", import.meta.url));
export async function promptFile(name: string): Promise<string> {
 if (!validName(name)) throw new Error("Invalid bundled prompt name");
 return fs.readFile(path.join(promptsDir, `${name}.md`), "utf8");
}
export async function agentInstructions(definition: AgentDefinition): Promise<string> {
 return ["scout", "planner", "reviewer", "worker"].includes(definition.instructions) ? promptFile(definition.instructions) : definition.instructions;
}
/** Native Pi frontmatter parsing, with project files gated by the primary's trust decision. */
export async function discoverAgentFiles(base: Config, directory: string, warn: (message: string) => void): Promise<Config> {
 let files: string[];
 try { files = (await fs.readdir(directory)).filter((name) => name.endsWith(".md")).sort(); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return base; throw error; }
 let config = base;
 for (const filename of files) {
  try {
   const file = path.join(directory, filename);
   if ((await fs.stat(file)).size > 256 * 1024) throw new Error("agent definition exceeds 256 KiB");
   const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(await fs.readFile(file, "utf8"));
   const name = frontmatter.name;
   if (typeof name !== "string" || !validName(name)) throw new Error("valid name required");
   const allowed = ["name", "description", "tools", "role", "model", "thinking", "thinking-level", "maxRequests", "harness", "acpModel", "acpMode"];
   for (const key of Object.keys(frontmatter)) if (!allowed.includes(key)) throw new Error(`unsupported field ${key}`);
   const model = frontmatter.model;
   const modelRole = `agent-${name}`;
   const role = typeof model === "string" ? modelRole : frontmatter.role ?? (config.agents[name]?.role ?? "task");
   config = mergeConfig(config, {
    ...(typeof model === "string" ? { roles: { [modelRole]: { model, ...(frontmatter.thinking ?? frontmatter["thinking-level"] ? { thinkingLevel: frontmatter.thinking ?? frontmatter["thinking-level"] } : {}) } } } : {}),
    agents: { [name]: {
     description: frontmatter.description, role, instructions: body,
     ...(frontmatter.harness !== undefined ? { harness: frontmatter.harness } : {}),
     ...(frontmatter.acpModel !== undefined ? { acpModel: frontmatter.acpModel } : {}),
     ...(frontmatter.acpMode !== undefined ? { acpMode: frontmatter.acpMode } : {}),
     ...(frontmatter.tools !== undefined ? { tools: typeof frontmatter.tools === "string" ? frontmatter.tools.split(",").map((v) => v.trim()).filter(Boolean) : frontmatter.tools } : {}),
     ...(frontmatter.maxRequests !== undefined ? { maxRequests: frontmatter.maxRequests } : {}),
    } },
   }, file);
  } catch (error) { warn(`${filename}: ${error instanceof Error ? error.message : String(error)}`); }
 }
 return config;
}
export function childUsage(manager: SessionManager): Usage {
 const total = emptyUsage();
 for (const entry of manager.getEntries()) {
  if (entry.type === "message" && entry.message.role === "assistant") addUsage(total, entry.message.usage);
  else if ((entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) addUsage(total, entry.usage);
 }
 return total;
}
export async function artifactDirectory(ctx: ExtensionContext, kind: string): Promise<string | undefined> {
 const parent = ctx.sessionManager.getSessionFile();
 if (!parent) return;
 const directory = path.join(path.dirname(parent), `${path.basename(parent, ".jsonl")}.hempi`, kind);
 await fs.mkdir(directory, { recursive: true, mode: 0o700 });
 return directory;
}
export interface Child {
 session: AgentSession;
 manager: SessionManager;
 selection: Selection;
 resetBudget(): void;
 stop(): Promise<void>;
}
export interface ChildOptions {
 ctx: ExtensionContext; requests: Requests; config: Config; selection: Selection;
 kind: string; instructions: string; tools: string[]; maxRequests: number;
 customTools?: ToolDefinition[];
 extensions?: (pi: ExtensionAPI) => void;
 workspaceOnly?: boolean;
 sessionFile?: string;
 sessionLeaf?: string | null;
 beforeRequest?: (model: Model<Api>, contextBytes: number, maxTokens: number) => void;
}
/** An isolated native SDK session. Its provider adapter delegates credentials to the public parent broker. */
export async function createChild(options: ChildOptions): Promise<Child> {
 const { ctx, requests, selection, kind } = options;
 const candidates = requests.candidates(selection, ctx);
 const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
 let requestCount = 0;
 let stopped = false;
 const modelsByProvider = new Map<string, Model<Api>[]>();
 for (const candidate of candidates) {
  const list = modelsByProvider.get(candidate.modelObject.provider) ?? [];
  list.push(candidate.modelObject); modelsByProvider.set(candidate.modelObject.provider, list);
 }
 for (const [provider, models] of modelsByProvider) {
  runtime.registerProvider(provider, {
   apiKey: "hempi-delegated-auth-never-sent", authHeader: false,
   baseUrl: models[0].baseUrl, api: models[0].api,
   models: models.map((model) => ({ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevelMap: model.thinkingLevelMap, compat: model.compat })),
   streamSimple: (model, context, streamOptions) => {
    const physical = candidates.find((candidate) => candidate.modelObject.provider === model.provider && candidate.modelObject.id === model.id) ?? selection;
    const policy = kind === "advisor" ? { ...physical, tier: selection.tier } : physical;
    return requests.stream(policy, context, kind, streamOptions?.sessionId ?? randomUUID(), ctx, {
     ...streamOptions,
     onPayload: async (payload, requestModel) => {
      if (stopped) throw new Error("Agent stopped");
      if (++requestCount > options.maxRequests) throw new Error(`Agent request budget exhausted (${options.maxRequests})`);
      options.beforeRequest?.(requestModel, Buffer.byteLength(JSON.stringify(context), "utf8"), policy.maxTokens ?? 8192);
      return streamOptions?.onPayload?.(payload, requestModel);
     },
    });
   },
  });
 }
 await runtime.refresh({ allowNetwork: false, providers: [...modelsByProvider.keys()] });
 const directory = await artifactDirectory(ctx, kind.replace(/[^a-zA-Z0-9_-]/g, "-"));
 let manager: SessionManager;
 if (options.sessionFile) {
  if (!directory) throw new Error("Cannot resume a child without persistent parent storage");
  const [file, root] = await Promise.all([fs.realpath(options.sessionFile), fs.realpath(directory)]);
  if (!file.startsWith(root + path.sep) || path.extname(file) !== ".jsonl") throw new Error("Child session is outside this parent's artifact directory");
  manager = SessionManager.open(file);
  if (await fs.realpath(manager.getCwd()) !== await fs.realpath(ctx.cwd)) throw new Error("Child session workspace changed");
  if (options.sessionLeaf !== undefined) {
   if (options.sessionLeaf === null) manager.resetLeaf();
   else {
    if (!manager.getEntry(options.sessionLeaf)) throw new Error("Child session checkpoint is missing");
    manager.branch(options.sessionLeaf);
   }
  }
 } else manager = directory ? SessionManager.create(ctx.cwd, directory) : SessionManager.inMemory(ctx.cwd);
 const reserved = Math.min(8192, Math.max(1024, Math.floor(selection.modelObject.contextWindow * 0.1)));
 const settings = SettingsManager.inMemory({
  cacheWarming: "off", transport: "sse", enableInstallTelemetry: false,
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
  compaction: { enabled: true, reserveTokens: reserved, keepRecentTokens: Math.min(12000, Math.max(1024, Math.floor(selection.modelObject.contextWindow * 0.2))) },
 });
 const root = await fs.realpath(ctx.cwd);
 const loader = new DefaultResourceLoader({
  cwd: ctx.cwd, agentDir: getAgentDir(), settingsManager: settings,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  agentsFilesOverride: () => ({ agentsFiles: [] }),
  systemPromptOverride: () => options.instructions,
  appendSystemPromptOverride: () => [],
  extensionFactories: [(pi) => {
   pi.on("tool_call", async (event) => {
    if (stopped) return { block: true, reason: "Agent stopped" };
    if (!options.tools.includes(event.toolName) && !options.customTools?.some((tool) => tool.name === event.toolName)) return { block: true, reason: "Tool is not granted to this agent" };
    if (options.workspaceOnly && READ_TOOLS.includes(event.toolName)) {
     const rawPath = "path" in event.input ? event.input.path : undefined;
     const target = path.resolve(root, typeof rawPath === "string" ? rawPath : ".");
     let real = target;
     try { real = await fs.realpath(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
     if (real !== root && !real.startsWith(root + path.sep)) return { block: true, reason: "Advisor tools are confined to the workspace" };
    }
   });
   options.extensions?.(pi);
  }],
 });
 await loader.reload();
 const { session } = await createAgentSession({
  cwd: ctx.cwd, agentDir: getAgentDir(), modelRuntime: runtime,
  model: selection.modelObject, thinkingLevel: selection.thinkingLevel,
  resourceLoader: loader, sessionManager: manager, settingsManager: settings,
  tools: [...options.tools, ...(options.customTools ?? []).map((tool) => tool.name)], customTools: options.customTools,
 });
 await session.bindExtensions({ mode: "json" });
 return {
  session, manager, selection,
  resetBudget() { requestCount = 0; },
  async stop() { if (stopped) return; stopped = true; try { await session.abort(); } finally { session.dispose(); } },
 };
}
export interface AgentResult { agent: string; answer: string; file?: string; usage: Usage; model: string; error?: string; runId?: string; harness?: HarnessName; status?: RunState; usageKnown?: boolean }
export class Agents extends DelegateRuns {
 readonly #pi: ExtensionAPI;
 readonly #config: () => Config;
 constructor(pi: ExtensionAPI, requests: Requests, config: () => Config) { super(pi, requests, config); this.#pi = pi; this.#config = config; }
 register(): void {
  const agents = this;
  this.#pi.on("session_start", (_event, ctx) => { agents.restore(ctx); });
  this.#pi.on("session_before_switch", async () => { await agents.stop(); });
  this.#pi.on("session_before_fork", async () => { await agents.stop(); });
  this.#pi.on("session_before_tree", async () => { await agents.stop(); });
  this.#pi.on("session_shutdown", async () => { await agents.stop(); });
  this.#pi.on("session_tree", (_event, ctx) => { agents.restore(ctx); });
  this.#pi.registerTool({
   name: "agent_run", label: "Agent run", exposure: "model-only",
   description: "List, inspect, wait, cancel or follow up delegate runs. Cancelling wait only stops waiting, not the background job; use cancel to stop it.",
   parameters: Type.Object({ action: Type.Union(["list", "status", "wait", "cancel", "followup"].map(action => Type.Literal(action))), id: Type.Optional(Type.String()), task: Type.Optional(Type.String({ minLength: 1, maxLength: 128000 })) }),
   execute: async (_id, params, signal, _onUpdate, ctx) => {
    agents.restore(ctx);
    let result: unknown;
    if (params.action === "list") result = agents.runs.overview();
    else {
     if (!params.id) throw new Error("Run id is required");
     if (params.action === "cancel") { agents.runs.cancel(params.id); result = agents.runs.get(params.id); }
     else if (params.action === "followup") {
      if (!params.task) throw new Error("Followup task is required");
      result = { runId: agents.followup(params.id, params.task, ctx) };
     } else if (params.action === "wait") {
      signal?.throwIfAborted();
      let abort: (() => void) | undefined;
      try {
       result = await Promise.race([agents.runs.wait(params.id), new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Stopped waiting; background run continues"));
        signal?.addEventListener("abort", abort, { once: true });
       })]);
      } finally { if (abort) signal?.removeEventListener("abort", abort); }
     } else result = agents.runs.get(params.id);
     if (result === undefined) throw new Error("Unknown run");
    }
    const text = JSON.stringify(result);
    return { content: [{ type: "text", text: text.length > 50000 ? `${text.slice(0, 50000)}\n[Truncated; inspect the run transcript for full output]` : text }], details: { result } };
   },
  });
  this.#pi.registerTool({
   name: "delegate", label: "Delegate",
   description: "Run named agents through ACP with isolated conversations. Optionally select pi, omp, claude, codex or fx per task. Exact tool grants and request budgets apply to Pi; external agents require a writer profile and their own approval policy. Writers share a serialized workspace. background returns run IDs for agent_run controls; external usage can be unknown.",
   exposure: "model-only",
   parameters: Type.Object({
    tasks: Type.Array(Type.Object({ agent: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1, maxLength: 128000 }), label: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Short task-specific table label, e.g. API audit; avoid repeating the agent name." })), harness: Type.Optional(Type.Union(HARNESS_NAMES.map(name => Type.Literal(name)))) }), { minItems: 1, maxItems: 8 }),
    background: Type.Optional(Type.Boolean()),
    mode: Type.Optional(Type.Union([Type.Literal("parallel"), Type.Literal("chain")])),
   }),
   promptGuidelines: ["Delegate concrete independent subtasks, not responsibility for understanding the user's goal. Provide goal, relevant context, scope, and success criteria. Use scout/planner/reviewer for read-only work, and explicitly select worker for edits. Give tasks short, distinct labels describing the work, not repeated agent names."],
   execute: async (_id, params, signal, onUpdate, ctx) => {
    if (params.background && params.mode === "chain") throw new Error("chain+background is not supported");
    agents.restore(ctx);
    const epoch = agents.epoch;
    const assertOwner = () => { if (agents.epoch !== epoch) throw new Error("Delegate invocation belongs to a stopped parent session"); };
    const primaryCanWrite = agents.#pi.getActiveTools().some((tool) => ["bash", "powershell", "edit", "write"].includes(tool));
    for (const task of params.tasks) {
     const definition = agents.#config().agents[task.agent];
     if (!definition) throw new Error(`Unknown agent ${task.agent}`);
     if (!primaryCanWrite && definition.tools.some((tool) => !READ_TOOLS.includes(tool))) throw new Error("The primary read-only loadout cannot delegate to a writer");
     agents.preflight(task.agent, ctx, { harness: task.harness });
    }
    signal?.throwIfAborted();
    if (params.background) {
     const ids = params.tasks.map(task => { assertOwner(); return agents.start(task.agent, task.task, ctx, { harness: task.harness, label: task.label }); });
     return { content: [{ type: "text", text: JSON.stringify(ids) }], details: { runIds: ids } };
    }
    const results: AgentResult[] = new Array(params.tasks.length);
    const progress = (text: string) => onUpdate?.({ content: [{ type: "text", text: text.slice(-4000) }], details: { results: results.filter(Boolean) } });
    let cursor = 0;
    const next = async () => {
     while (cursor < params.tasks.length) {
      if (agents.epoch !== epoch) break;
      const index = cursor++;
      const task = params.tasks[index];
      signal?.throwIfAborted();
      const previous = params.mode === "chain" && index > 0 ? results[index - 1].answer : "";
      try { results[index] = await agents.run(task.agent, params.mode === "chain" ? task.task.replaceAll("{previous}", previous) : task.task, ctx, signal, progress, { harness: task.harness, label: task.label }); }
      catch (error) { results[index] = { agent: task.agent, answer: "", model: "", usage: emptyUsage(), error: error instanceof Error ? error.message : String(error) }; }
      if (params.mode === "chain" && results[index].error) break;
     }
    };
    await Promise.all(Array.from({ length: params.mode === "chain" ? 1 : Math.min(4, params.tasks.length) }, next));
    const finished = results.filter(Boolean);
    const usage = emptyUsage(); for (const result of finished) addUsage(usage, result.usage);
    return {
     content: finished.map((result) => ({ type: "text" as const, text: `${result.agent} [${result.runId ?? ""} ${result.harness ?? ""} ${result.status ?? ""}]${result.error ? ` ERROR: ${result.error}` : ""}\n${result.answer.slice(0, 50000)}${result.answer.length > 50000 ? "\n[Output truncated; see the transcript file.]" : ""}${result.file ? `\nTranscript: ${result.file}` : ""}` })),
     details: { results: finished }, usage, isError: finished.some((result) => !!result.error),
    };
   },
  });
 }
}
