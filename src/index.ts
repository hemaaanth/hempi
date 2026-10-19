import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaults, loadConfig, saveConfigPatch, resolveSelection, LEVELS, validName, delegateCatalog, type Config } from "./config.ts";
import { Agents, agentInstructions, discoverAgentFiles } from "./agents.ts";
import { registerRunUi } from "./acp/ui.ts";
import { Workflows } from "./workflows.ts";
import { Advisor } from "./advisor.ts";
import { Btw } from "./btw.ts";
import { applyPayloadPolicy, inheritedTier, supportedFast, Requests } from "./requests.ts";
import { selectInline } from "./ui.ts";
import { setPrimaryPolicy, clearPrimaryPolicy } from "./primary-policy.ts";
import registerOptchat from "./optchat/index.ts";
import { findModel } from "./model-route.ts";
import registerWatermark from "./watermark.ts";

interface PrimaryState { role: string; agent?: string; baselineTools: string[]; baseModel: string; baseThinking: ThinkingLevel; selectedModel: string; selectedThinking: ThinkingLevel }
/** One root package: no patches to Pi and no recursive child extension discovery. */
export default function hempi(pi: ExtensionAPI) {
 registerWatermark(pi);
 const optchat = registerOptchat(pi);
 let config: Config = defaults();
 let configError: string | undefined;
 let ctx: ExtensionContext | undefined;
 let role = "current";
 let persona: string | undefined;
 let baselineTools: string[] = [];
 let base: { model: Model<Api>; thinkingLevel: ThinkingLevel } | undefined;
 let selecting = false;
 let picker: AbortController | undefined;
 let generation = 0;
 let changing: Promise<void> | undefined;
 const requests = new Requests(pi, () => config);
 const agents = new Agents(pi, requests, () => config);
 const workflows = new Workflows(pi, agents);
 const advisor = new Advisor(pi, requests, () => config);
 const btw = new Btw(pi, requests, () => config);
 const ready = () => { if (configError) throw new Error(`Fix hempi.json and run /hempi reload: ${configError}`); };
 async function reload(current: ExtensionContext): Promise<void> {
  const next = await loadConfig(current, (base, directory) => discoverAgentFiles(base, directory, (message) => current.ui.notify(`Agent definition skipped: ${message}`, "warning")));
  config = next; configError = undefined;
 }
 function status(current: ExtensionContext): void {
  setPrimaryPolicy(current.sessionManager.getSessionId(), resolveSelection(config, role, current, base).tier ?? "inherit");
  pi.events.emit("hempi:primary-policy", current.sessionManager.getSessionId());
  current.ui.setStatus("hempi-role", ["current", "default"].includes(role) && !persona ? undefined : `${role}${persona ? `/${persona}` : ""}`);
 }
 function state(current: ExtensionContext): PrimaryState | undefined {
  if (!base || !current.model) return;
  return { role, agent: persona, baselineTools, baseModel: `${base.model.provider}/${base.model.id}`, baseThinking: base.thinkingLevel, selectedModel: `${current.model.provider}/${current.model.id}`, selectedThinking: current.thinkingLevel ?? "off" };
 }
 function persist(current: ExtensionContext): void { const data = state(current); if (data) pi.appendEntry("hempi.primary", data); }
 async function selectRole(name: string, current: ExtensionContext, save = true): Promise<void> {
  ready();
  if (!current.isIdle()) throw new Error("Change the primary model role after the main agent becomes idle");
  const selection = resolveSelection(config, name, current, base);
  if (selection.tier === "priority" && !supportedFast(selection.modelObject)) throw new Error("This model does not support the configured priority policy");
  if (selection.tier === "flex" && !["openai", "openai-codex"].includes(selection.modelObject.provider)) throw new Error("This provider does not support flex tier");
  selecting = true;
  try {
   if (`${current.model?.provider}/${current.model?.id}` !== `${selection.modelObject.provider}/${selection.modelObject.id}` && !(await pi.setModel(selection.modelObject))) throw new Error("Could not select that model; configure its credentials first");
   pi.setThinkingLevel(selection.thinkingLevel); role = name.replace(/^@/, "");
  } finally { selecting = false; }
  status(current); if (save) persist(current);
 }
 function personaTools(name?: string): string[] {
  const selected = name ? config.agents[name].tools : baselineTools;
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  return [...new Set([...selected, "workflow", ...(name ? ["ask_user", "delegate", "agent_run"] : []),
   ...optchat.tools()])].filter((tool) => available.has(tool));
 }
 async function selectPersona(name: string | undefined, current: ExtensionContext): Promise<void> {
  ready();
  if (!current.isIdle()) throw new Error("Change the primary agent after it becomes idle");
  if (name && !Object.hasOwn(config.agents, name)) throw new Error(`Unknown agent ${name}`);
  if (name && config.agents[name].harness && config.agents[name].harness !== "pi") throw new Error("External profiles are delegates; the primary session remains Pi. Use /agent-runs start instead.");
  await selectRole(name ? config.agents[name].role : "default", current, false);
  persona = name; pi.setActiveTools(personaTools(name)); status(current); persist(current);
 }
 async function choose(current: ExtensionContext, title: string, options: { label: string; description?: string }[]): Promise<number | null> {
  if (current.mode !== "tui") throw new Error("Interactive selection needs the TUI; supply the role/model or agent name explicitly");
  const epoch = generation; picker?.abort(); const controller = new AbortController(); picker = controller;
  try { const selected = await selectInline(current, title, options, controller.signal); return epoch === generation ? selected : null; }
  finally { if (picker === controller) picker = undefined; }
 }
 async function change(operation: Promise<void>): Promise<void> {
  changing = operation; try { await operation; } finally { if (changing === operation) changing = undefined; }
 }
 async function configureRole(name: string, current: ExtensionContext, selector?: string, thinking?: string): Promise<void> {
  const epoch = generation;
  if (!validName(name)) throw new Error("Role names must be lowercase letters, digits, _ or -");
  if (!selector) {
   const models = await current.modelRegistry.getAvailable();
   const index = await choose(current, `Configure ${name}`, models.map((model) => ({ label: `${model.provider}/${model.id}`, description: `${model.reasoning ? "Reasoning" : "No reasoning"} · ${Math.round(model.contextWindow / 1000)}k context` })));
   if (index === null) return;
   selector = `${models[index].provider}/${models[index].id}`;
   const level = await choose(current, `${name}: thinking`, LEVELS.map((label) => ({ label })));
   if (level === null) return;
   thinking = LEVELS[level];
  }
  if (thinking && !LEVELS.includes(thinking as ThinkingLevel)) throw new Error(`Thinking must be ${LEVELS.join("|")}`);
  const patch = { roles: { [name]: { model: selector, ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}) } } };
  // Resolve against the live registry before saving, rather than persisting a misspelled model.
  const candidate = structuredClone(config); candidate.roles[name] = { ...candidate.roles[name], ...patch.roles[name] };
  resolveSelection(candidate, name, current, base);
  await saveConfigPatch(patch); if (epoch !== generation) return; await reload(current);
  current.ui.notify(`Saved ${name}. Activate with /model-role ${name}${name === "advisor" ? "; /advisor on explicitly enables it" : ""}.`, "info");
 }
 async function stop(current: ExtensionContext): Promise<boolean> {
  // Wait for side requests to unwind before another session owns pi.appendEntry/sendMessage.
  generation++; picker?.abort(); picker = undefined;
  if (changing) await changing.catch(() => {});
  persist(current);
  const [saved] = await Promise.all([btw.stop(current), agents.stop(), advisor.halt()]);
  return saved;
 }
 agents.register(); workflows.register(); registerRunUi(pi, agents, optchat.childActivity, workflows); advisor.register(); btw.register();
 pi.registerFlag("role", { description: "Activate a configured hempi primary model role", type: "string" });
 async function initialize(current: ExtensionContext, startup: boolean): Promise<void> {
  ctx = current; if (startup) baselineTools = pi.getActiveTools().filter((name) => !optchat.tools().includes(name)); persona = undefined; role = "current";
  base = current.model ? { model: current.model, thinkingLevel: current.thinkingLevel ?? "off" } : undefined;
  try {
   await reload(current);
   const saved = current.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "hempi.primary");
   const data = saved?.type === "custom" ? saved.data as PrimaryState : undefined;
   if (data && Array.isArray(data.baselineTools)) {
    baselineTools = data.baselineTools.filter((name) => pi.getAllTools().some((tool) => tool.name === name));
    if (`${current.model?.provider}/${current.model?.id}` === data.selectedModel && (current.thinkingLevel ?? "off") === data.selectedThinking) {
     const slash = data.baseModel.indexOf("/"); const model = findModel(current.modelRegistry, data.baseModel.slice(0, slash), data.baseModel.slice(slash + 1));
     if (model) base = { model, thinkingLevel: data.baseThinking };
     persona = data.agent && Object.hasOwn(config.agents, data.agent) ? data.agent : undefined;
     role = data.role;
    }
   }
   const startupRole = startup ? pi.getFlag("role") as string | undefined : undefined;
   if (startupRole) role = startupRole;
   else if (!data && startup) role = "default";
   if (role !== "current" && current.model) await selectRole(role, current, false);
   pi.setActiveTools(personaTools(persona));
   status(current); advisor.restore(current);
  } catch (error) { configError = error instanceof Error ? error.message : String(error); current.ui.notify(`hempi initialization: ${configError}`, "error"); }
 }
 pi.on("session_start", (_event, current) => initialize(current, true));
 pi.on("model_select", (event, current) => {
  if (selecting) return;
  role = "current"; base = { model: event.model, thinkingLevel: current.thinkingLevel ?? "off" }; status(current); persist(current);
 });
 pi.on("before_agent_start", async (event, current) => {
  ready(); ctx = current;
  const sections: Record<string, string> = {
   hempi_agents: delegateCatalog(config),
  };
  if (persona) sections.hempi_persona = await agentInstructions(config.agents[persona]);
  else sections.hempi_persona = "";
  Object.assign(event.systemPromptOptions.sections, sections);
 });
 pi.on("before_provider_request", async (event, current) => {
  const selected = resolveSelection(config, role, current, base);
  const tier = selected.tier === "inherit" || !selected.tier ? await inheritedTier() : selected.tier;
  return applyPayloadPolicy(event.payload, current.model!, tier);
 });
 pi.on("before_provider_headers", async (event, current) => {
  if (!current.model) return;
  const selected = resolveSelection(config, role, current, base);
  const tier = !selected.tier || selected.tier === "inherit" ? await inheritedTier() : selected.tier;
  if (tier === "priority" && current.model.provider === "anthropic" && supportedFast(current.model)) {
   const key = Object.keys(event.headers).find((name) => name.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
   const values = String(event.headers[key] ?? "").split(",").filter(Boolean);
   if (!values.includes("fast-mode-2026-02-01")) values.push("fast-mode-2026-02-01"); event.headers[key] = values.join(",");
  }
 });
 pi.on("session_before_switch", async (_event, current) => { if (!(await stop(current))) return { cancel: true }; });
 pi.on("session_before_fork", async (_event, current) => { if (!(await stop(current))) return { cancel: true }; });
 pi.on("session_before_tree", async (_event, current) => { if (!(await stop(current))) return { cancel: true }; });
 pi.on("session_shutdown", async (_event, current) => { await stop(current); clearPrimaryPolicy(current.sessionManager.getSessionId()); });
 pi.on("session_compact", async (_event, current) => { await advisor.rebase(current); });
 pi.on("session_tree", (_event, current) => initialize(current, false));
 pi.registerCommand("model-role", {
  description: "Primary model/thinking presets: choose a role, list roles, or set ROLE PROVIDER/MODEL[:THINKING] [THINKING]. Native /model and /models remain unchanged.",
  handler: async (args, current) => {
   try {
    ready(); const words = args.trim().split(/\s+/).filter(Boolean);
    if (words[0] === "set") { if (!words[1] || words.length > 4) throw new Error("Usage: /model-role set ROLE [PROVIDER/MODEL[:THINKING] [THINKING]]"); await configureRole(words[1], current, words[2], words[3]); return; }
    if (words[0] === "list") { current.ui.notify(Object.entries(config.roles).map(([name, value]) => `${name}: ${value.model}${value.thinkingLevel ? ` (${value.thinkingLevel})` : ""}`).join("\n"), "info"); return; }
    let name = words[0];
    if (!name) { const names = Object.keys(config.roles); const index = await choose(current, "Model roles", names.map((name) => ({ label: name, description: `${config.roles[name].model} · ${config.roles[name].thinkingLevel ?? "current thinking"}` }))); if (index === null) return; name = names[index]; }
    await change(selectRole(name, current));
   } catch (error) { current.ui.notify(String(error), "error"); }
  },
 });
 pi.registerCommand("agents", { description: "Inspect named specialized agents and their grants", handler: async (_args, current) => { current.ui.notify(Object.entries(config.agents).map(([name, agent]) => `${name}: ${agent.description}\n  harness=${agent.harness ?? "pi"}; role=${agent.role}${agent.acpModel ? `; ACP model=${agent.acpModel}` : ""}; tools=${agent.tools.join(",")}`).join("\n"), "info"); } });
 pi.registerCommand("agent", {
  description: "Switch the primary persona/tool loadout; /agent reset restores your original primary tools.",
  handler: async (args, current) => {
   try {
    ready(); let name = args.trim();
    if (!name) { const names = Object.keys(config.agents); const index = await choose(current, "Primary agent", [{ label: "Default", description: "Restore original primary tools" }, ...names.map((name) => ({ label: name, description: config.agents[name].description }))]); if (index === null) return; name = index === 0 ? "reset" : names[index - 1]; }
    await change(selectPersona(name === "reset" ? undefined : name.replace(/^use\s+/, ""), current));
   } catch (error) { current.ui.notify(String(error), "error"); }
  },
 });
 pi.registerCommand("hempi", {
  description: "Integration status, usage ledger, config reload, and profile paths",
  handler: async (args, current) => {
   try {
    if (args.trim() === "reload") { if (!current.isIdle()) throw new Error("Reload profiles after the main agent becomes idle"); await advisor.halt(); await reload(current); advisor.restore(current); current.ui.notify("Reloaded role/agent configuration.", "info"); return; }
    if (args.trim() === "usage") { const groups = new Map<string, number>(); for (const record of requests.records) groups.set(record.kind, (groups.get(record.kind) ?? 0) + record.usage.cost.total); current.ui.notify([...groups].map(([kind, cost]) => `${kind}: $${cost.toFixed(4)}`).join("\n") || "No reported side/agent usage yet.", "info"); return; }
    current.ui.notify(`Agent directory: ${getAgentDir()}\nConfig: ${path.join(getAgentDir(), "hempi.json")}\nPrimary: ${role}${persona ? ` / ${persona}` : ""}\nAdvisor: ${advisor.state}; ${advisor.pending.length} held notes\n${configError ? `Config error: ${configError}` : "BTW and delegates use isolated request/session identities."}`, "info");
   } catch (error) { current.ui.notify(String(error), "error"); }
  },
 });
 // Small embedding API for host/fake-provider tests, without reaching into Pi session internals.
 return { requests, agents, workflows, advisor, btw, getConfig: () => config };
}
