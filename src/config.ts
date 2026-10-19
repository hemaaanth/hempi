import * as fs from "node:fs/promises";
import * as path from "node:path";
import { updateJson } from "./storage.ts";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findModel } from "./model-route.ts";

export const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const READ_TOOLS = ["read", "grep", "find", "ls"];
export const BUILTIN_TOOLS = [...READ_TOOLS, "bash", "powershell", "edit", "write"];
export type Tier = "inherit" | "standard" | "priority" | "flex";
export interface Role {
 model: string;
 thinkingLevel?: ThinkingLevel;
 tier?: Tier;
 maxTokens?: number;
 temperature?: number;
 fallbacks?: string[];
}
export const HARNESS_NAMES = ["pi", "omp", "claude", "codex", "fx"] as const;
export type HarnessName = typeof HARNESS_NAMES[number];
export type ExternalHarnessName = Exclude<HarnessName, "pi">;
export interface HarnessConfig { command: string; args: string[]; env?: Record<string, string> }
export interface AgentDefinition {
 harness?: HarnessName;
 acpModel?: string;
 acpMode?: string;
 description: string;
 role: string;
 tools: string[];
 instructions: string;
 maxRequests: number;
}
export interface AdvisorConfig {
 enabled: boolean;
 role: string;
 tools: string[];
 immuneTurns: number;
 maxNotesPerUpdate: number;
 maxRequestsPerReview: number;
 syncBacklog: 0 | 1 | 3 | 5;
 maxCost: number;
 instructions: string;
}
export interface Config {
 version: 1;
 harnesses: Partial<Record<ExternalHarnessName, HarnessConfig>>;
 roles: Record<string, Role>;
 agents: Record<string, AgentDefinition>;
 advisor: AdvisorConfig;
 btw: { role: string; maxTokens: number; maxContextBytes: number };
}
export interface Selection extends Role { modelObject: Model<Api>; thinkingLevel: ThinkingLevel }
export function delegateCatalog(config: Config): string {
 return `Named delegates:\n${Object.entries(config.agents).map(([name, agent]) => `- ${name}: ${agent.description}; harness=${agent.harness ?? "pi"}; model role ${agent.role}; tools ${agent.tools.join(", ")}`).join("\n")}\nChild conversations are isolated. Writers share the workspace and are serialized. Never use a writer to bypass a read-only primary profile.\nUse delegate with a per-task harness (pi, omp, claude, codex, fx) to select the engine; external read-only grants are currently unsupported. background=true returns run IDs; agent_run lists, inspects, waits, cancels, or follows up runs. Background work stops on parent shutdown/session change, not ordinary foreground abort. Usage may be unknown for external agents.`;
}
const namePattern = /^[a-z][a-z0-9_-]{0,63}$/;
export function validName(name: string): boolean { return namePattern.test(name) && !["constructor", "prototype", "__proto__"].includes(name); }
function object(value: unknown, where: string): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
 const obj = value as Record<string, unknown>;
 if (Object.keys(obj).some((key) => ["constructor", "prototype", "__proto__"].includes(key))) throw new Error(`${where}: unsafe key`);
 return obj;
}
function keys(obj: Record<string, unknown>, allowed: string[], where: string) {
 for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new Error(`${where}: unknown field ${key}`);
}
function text(value: unknown, where: string, empty = false): string {
 if (typeof value !== "string" || (!empty && !value.trim()) || value.length > 128_000) throw new Error(`${where} must be ${empty ? "a" : "a non-empty"} string (at most 128000 characters)`);
 return value;
}
function processText(value: unknown, where: string, empty = false): string {
 const result = text(value, where, empty);
 if (result.length > 8192 || result.includes("\0")) throw new Error(`${where}: invalid process string`);
 return result;
}
function number(value: unknown, where: string, min: number, max: number, integer = true): number {
 if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) throw new Error(`${where} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
 return value;
}
function strings(value: unknown, where: string): string[] {
 if (!Array.isArray(value) || value.length > 64) throw new Error(`${where} must be an array of at most 64 strings`);
 return value.map((v) => text(v, where));
}
function tools(value: unknown, where: string): string[] {
 const result = strings(value, where);
 for (const tool of result) if (!BUILTIN_TOOLS.includes(tool)) throw new Error(`${where}: unsupported built-in tool ${tool}`);
 return [...new Set(result)];
}
export function defaults(): Config {
 return {
  version: 1,
  harnesses: {
   omp: { command: "omp", args: ["acp"] },
   claude: { command: "claude-agent-acp", args: [] },
   codex: { command: "codex-acp", args: [] },
   fx: { command: "fx", args: ["acp"] },
  },
  roles: {
   default: { model: "@current", tier: "inherit" }, smol: { model: "@default", thinkingLevel: "low" },
   slow: { model: "@default", thinkingLevel: "high" }, plan: { model: "@slow" }, task: { model: "@default" },
  },
  agents: {
   scout: { description: "Read-only repository exploration", role: "smol", tools: [...READ_TOOLS], instructions: "scout", maxRequests: 12 },
   planner: { description: "Read-only implementation planning", role: "plan", tools: [...READ_TOOLS], instructions: "planner", maxRequests: 16 },
   reviewer: { description: "Read-only correctness review", role: "slow", tools: [...READ_TOOLS], instructions: "reviewer", maxRequests: 16 },
   worker: { description: "Implementation and verification", role: "task", tools: ["read", "grep", "find", "ls", "bash", "edit", "write"], instructions: "worker", maxRequests: 40 },
  },
  advisor: { enabled: false, role: "advisor", tools: [...READ_TOOLS], immuneTurns: 3, maxNotesPerUpdate: 4, maxRequestsPerReview: 12, syncBacklog: 0, maxCost: 5, instructions: "" },
  btw: { role: "current", maxTokens: 4096, maxContextBytes: 8 * 1024 * 1024 },
 };
}
/** Validate each layer before merging; typos must not silently enable work or lose restrictions. */
export function mergeConfig(base: Config, raw: unknown, where = "hempi.json"): Config {
 const obj = object(raw, where);
 keys(obj, ["version", "roles", "agents", "advisor", "btw", "harnesses"], where);
 if (obj.version !== undefined && obj.version !== 1) throw new Error(`${where}: unsupported version`);
 const result = structuredClone(base);
 if (obj.harnesses !== undefined) for (const [name, rawHarness] of Object.entries(object(obj.harnesses, `${where}.harnesses`))) {
  if (name === "pi" || !HARNESS_NAMES.includes(name as HarnessName)) throw new Error(`${where}: unsupported external harness`);
  const harness = object(rawHarness, `${where}.harnesses.${name}`);
  keys(harness, ["command", "args", "env"], `harnesses.${name}`);
  const next = { ...result.harnesses[name as ExternalHarnessName] };
  if (harness.command !== undefined) next.command = processText(harness.command, `harnesses.${name}.command`);
  if (harness.args !== undefined) {
   if (!Array.isArray(harness.args) || harness.args.length > 64) throw new Error(`harnesses.${name}.args requires at most 64 strings`);
   next.args = harness.args.map((arg) => processText(arg, `harnesses.${name}.args`, true));
   if (next.args.join("").length > 32768) throw new Error(`harnesses.${name}.args too large`);
  }
  if (harness.env !== undefined) {
   const env = object(harness.env, `harnesses.${name}.env`);
   if (Object.keys(env).length > 128) throw new Error(`harnesses.${name}.env too large`);
   next.env = {};
   for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error(`harnesses.${name}.env invalid key`);
    next.env[key] = processText(value, `harnesses.${name}.env value`, true);
   }
   if (Object.entries(next.env).reduce((size, [key, value]) => size + key.length + value.length, 0) > 65536) throw new Error(`harnesses.${name}.env too large`);
  }
  if (!next.command || !next.args) throw new Error(`harnesses.${name} requires command and args`);
  result.harnesses[name as ExternalHarnessName] = next as HarnessConfig;
 }
 if (obj.roles !== undefined) for (const [name, rawRole] of Object.entries(object(obj.roles, `${where}.roles`))) {
  if (!validName(name) || name === "current") throw new Error(`${where}: invalid/reserved role ${name}`);
  const role = typeof rawRole === "string" ? { model: rawRole } : object(rawRole, `${where}.roles.${name}`);
  keys(role, ["model", "thinkingLevel", "tier", "maxTokens", "temperature", "fallbacks"], `${where}.roles.${name}`);
  const previous = Object.hasOwn(result.roles, name) ? result.roles[name] : undefined;
  const next: Role = { ...(previous ?? { model: "" }) };
  if (role.model !== undefined) {
   next.model = text(role.model, `${name}.model`);
   const selector = splitSelector(next.model).selector;
   if (selector.startsWith("@") ? !validName(selector.slice(1)) : !/^[^\s/*?]+\/[^\s*?]+$/.test(selector)) throw new Error(`${name}.model requires an exact provider/model or @role selector`);
  }
  if (!next.model) throw new Error(`${name}.model is required`);
  if (role.thinkingLevel !== undefined) {
   if (!LEVELS.includes(role.thinkingLevel as ThinkingLevel)) throw new Error(`${name}: invalid thinkingLevel`);
   next.thinkingLevel = role.thinkingLevel as ThinkingLevel;
  }
  if (role.tier !== undefined) {
   if (!["inherit", "standard", "priority", "flex"].includes(String(role.tier))) throw new Error(`${name}: invalid tier`);
   next.tier = role.tier as Tier;
  }
  if (role.maxTokens !== undefined) next.maxTokens = number(role.maxTokens, `${name}.maxTokens`, 1, 262144);
  if (role.temperature !== undefined) next.temperature = number(role.temperature, `${name}.temperature`, 0, 2, false);
  if (role.fallbacks !== undefined) next.fallbacks = strings(role.fallbacks, `${name}.fallbacks`);
  result.roles[name] = next;
 }
 if (obj.agents !== undefined) for (const [name, rawAgent] of Object.entries(object(obj.agents, `${where}.agents`))) {
  if (!validName(name)) throw new Error(`${where}: invalid agent ${name}`);
  const agent = object(rawAgent, `${where}.agents.${name}`);
  keys(agent, ["description", "role", "tools", "instructions", "maxRequests", "harness", "acpModel", "acpMode"], name);
  const next: AgentDefinition = { ...(Object.hasOwn(result.agents, name) ? result.agents[name] : { description: "", role: "task", tools: [...READ_TOOLS], instructions: "", maxRequests: 16 }) };
  for (const key of ["description", "role", "instructions"] as const) if (agent[key] !== undefined) next[key] = text(agent[key], `${name}.${key}`, key === "instructions");
  if (agent.harness !== undefined) {
   if (!HARNESS_NAMES.includes(agent.harness as HarnessName)) throw new Error(`${name}: unsupported harness`);
   next.harness = agent.harness as HarnessName;
  }
  for (const key of ["acpModel", "acpMode"] as const) if (agent[key] !== undefined) next[key] = processText(agent[key], `${name}.${key}`);
  if (!next.description) throw new Error(`${name}.description is required`);
  if (agent.tools !== undefined) next.tools = tools(agent.tools, `${name}.tools`);
  if (agent.maxRequests !== undefined) next.maxRequests = number(agent.maxRequests, `${name}.maxRequests`, 1, 200);
  result.agents[name] = next;
 }
 if (obj.advisor !== undefined) {
  const advisor = object(obj.advisor, `${where}.advisor`);
  keys(advisor, Object.keys(result.advisor), "advisor");
  if (advisor.enabled !== undefined) {
   if (typeof advisor.enabled !== "boolean") throw new Error("advisor.enabled must be boolean");
   result.advisor.enabled = advisor.enabled;
  }
  for (const key of ["role", "instructions"] as const) if (advisor[key] !== undefined) result.advisor[key] = text(advisor[key], `advisor.${key}`, key === "instructions");
  if (advisor.tools !== undefined) {
   result.advisor.tools = tools(advisor.tools, "advisor.tools");
   if (result.advisor.tools.some((tool) => !READ_TOOLS.includes(tool))) throw new Error("Advisor tools must be read-only; use a worker agent for mutations");
  }
  for (const [key, min, max] of [["immuneTurns", 0, 100], ["maxNotesPerUpdate", 1, 32], ["maxRequestsPerReview", 1, 100]] as const) if (advisor[key] !== undefined) result.advisor[key] = number(advisor[key], `advisor.${key}`, min, max);
  if (advisor.syncBacklog !== undefined) {
   if (![0, 1, 3, 5].includes(advisor.syncBacklog as number)) throw new Error("advisor.syncBacklog must be 0, 1, 3 or 5");
   result.advisor.syncBacklog = advisor.syncBacklog as AdvisorConfig["syncBacklog"];
  }
  if (advisor.maxCost !== undefined) result.advisor.maxCost = number(advisor.maxCost, "advisor.maxCost", 0, 10000, false);
 }
 if (obj.btw !== undefined) {
  const btw = object(obj.btw, `${where}.btw`);
  keys(btw, ["role", "maxTokens", "maxContextBytes"], "btw");
  if (btw.role !== undefined) result.btw.role = text(btw.role, "btw.role");
  if (btw.maxTokens !== undefined) result.btw.maxTokens = number(btw.maxTokens, "btw.maxTokens", 1, 262144);
  if (btw.maxContextBytes !== undefined) result.btw.maxContextBytes = number(btw.maxContextBytes, "btw.maxContextBytes", 1024, 64 * 1024 * 1024);
 }
 // Missing aliases can be supplied by a later layer; cycles can never be valid.
 for (const name of Object.keys(result.roles)) {
  try { expandRole(result, name); }
  catch (error) { if (!(error instanceof Error) || !error.message.startsWith("No model configured for role ")) throw error; }
 }
 return result;
}
async function readLayer(file: string): Promise<unknown | undefined> {
 try {
  const stat = await fs.stat(file);
  if (stat.size > 2 * 1024 * 1024) throw new Error(`${file}: config exceeds 2 MiB`);
  return JSON.parse(await fs.readFile(file, "utf8"));
 } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
export async function loadConfig(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, agentFiles?: (config: Config, directory: string) => Promise<Config>): Promise<Config> {
 let config = defaults();
 for (const directory of [getAgentDir(), ...(ctx.isProjectTrusted() ? [path.join(ctx.cwd, ".pi")] : [])]) {
  if (agentFiles) config = await agentFiles(config, path.join(directory, "agents"));
  const file = path.join(directory, "hempi.json");
  const layer = await readLayer(file);
  if (layer !== undefined) config = mergeConfig(config, layer, file);
 }
 return config;
}
export async function saveConfigPatch(patch: unknown, project?: string): Promise<void> {
 const file = project ? path.join(project, ".pi", "hempi.json") : path.join(getAgentDir(), "hempi.json");
 await updateJson(file, (previous) => {
  mergeConfig(mergeConfig(defaults(), previous, file), patch, file);
  const next = { ...object(previous, file) };
  const change = object(patch, "patch");
  for (const [key, value] of Object.entries(change)) {
   if (key === "roles" || key === "agents" || key === "harnesses") {
    const entries = { ...(next[key] === undefined ? {} : object(next[key], key)) };
    for (const [name, entry] of Object.entries(object(value, key))) {
     const old = entries[name];
     const oldObject = typeof old === "string" ? { model: old } : old === undefined ? {} : object(old, name);
     entries[name] = typeof entry === "string" ? { ...oldObject, model: entry } : { ...oldObject, ...object(entry, name) };
    }
    next[key] = entries;
   } else if (key === "advisor" || key === "btw") next[key] = { ...(next[key] === undefined ? {} : object(next[key], key)), ...object(value, key) };
   else next[key] = value;
  }
  return next;
 });
}
export function splitSelector(selector: string): { selector: string; level?: ThinkingLevel } {
 const match = /:(off|minimal|low|medium|high|xhigh|max)$/.exec(selector);
 return match ? { selector: selector.slice(0, match.index), level: match[1] as ThinkingLevel } : { selector };
}
export function expandRole(config: Config, name: string, seen = new Set<string>()): Role {
 const parsed = splitSelector(name.replace(/^@/, ""));
 name = parsed.selector;
 if (name === "current") return { model: "@current", ...(parsed.level ? { thinkingLevel: parsed.level } : {}) };
 if (seen.has(name)) throw new Error(`Model role cycle: ${[...seen, name].join(" → ")}`);
 if (!Object.hasOwn(config.roles, name)) throw new Error(`No model configured for role ${name}. Use /model-role set ${name} provider/model:level`);
 seen.add(name);
 const role = config.roles[name];
 const model = splitSelector(role.model);
 const inherited = model.selector.startsWith("@") ? expandRole(config, model.selector, seen) : { model: model.selector };
 return { ...inherited, ...role, model: inherited.model, thinkingLevel: parsed.level ?? role.thinkingLevel ?? model.level ?? inherited.thinkingLevel };
}
export function resolveSelection(config: Config, selector: string, ctx: Pick<ExtensionContext, "model" | "thinkingLevel" | "modelRegistry">, base?: { model: Model<Api>; thinkingLevel: ThinkingLevel }): Selection {
 const parsed = splitSelector(selector);
 const role: Role = parsed.selector.startsWith("@") || Object.hasOwn(config.roles, parsed.selector) || parsed.selector === "current"
  ? expandRole(config, selector) : { model: parsed.selector, ...(parsed.level ? { thinkingLevel: parsed.level } : {}) };
 let modelObject: Model<Api> | undefined;
 if (role.model === "@current") modelObject = base?.model ?? ctx.model;
 else {
  const slash = role.model.indexOf("/");
  if (slash <= 0 || slash === role.model.length - 1) throw new Error(`Use an exact provider/model selector: ${role.model}`);
  modelObject = findModel(ctx.modelRegistry, role.model.slice(0, slash), role.model.slice(slash + 1));
 }
 if (!modelObject) throw new Error(`Model is unavailable: ${role.model}`);
 return { ...role, modelObject, thinkingLevel: clampThinkingLevel(modelObject, role.thinkingLevel ?? base?.thinkingLevel ?? ctx.thinkingLevel ?? "off") };
}
