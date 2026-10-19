import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Agents } from "../agents.ts";
import type { Workflows, WorkflowSnapshot } from "../workflows.ts";
import { activeWorkflow } from "../workflow-types.ts";
import { WorkflowView, workflowText } from "./workflow-view.ts";
import { HARNESS_NAMES, type HarnessName } from "../config.ts";
import { panel, promptInline, safeText } from "../ui.ts";
import type { RunInfo } from "./runs.ts";
import type { AgentActivity, AgentActivitySource } from "./activity-types.ts";
import { ActivityPanel, activityActive, activityLive, visibleActivities } from "./activity-panel.ts";

const clean = (value: unknown) => safeText(stripTerminalSequences(String(value))).replace(/[\u0080-\u009f]/g, "");
const live = (r: Pick<RunInfo, "state">) => ["queued", "starting", "running", "awaiting_approval"].includes(r.state);
const summary = (r: Pick<RunInfo, "id" | "agent" | "harness" | "state">) => clean(`${r.id} · ${r.agent} · ${r.harness} · ${r.state}`).replace(/\s+/g, " ");
function details(r: RunInfo): string {
 const usage = r.usage == null ? "unknown" : JSON.stringify(r.usage);
 const cost = (r.usage as { cost?: unknown } | undefined)?.cost;
 return clean(`${summary(r)}\nModel: ${r.model ?? "unknown"}\nTranscript: ${r.file ?? "unknown"}\nUsage: ${usage} · Cost: ${cost == null ? "unknown" : JSON.stringify(cost)}\nTask: ${r.task}\nProgress:\n${r.progress.slice(-4000)}\nAnswer:\n${r.answer.slice(0, 50000)}${r.answer.length > 50000 ? "\n[Truncated; see transcript]" : ""}\nError: ${r.error ?? "none"}`);
}
const help = "Usage: /agent-runs [panel [expand|collapse] | list | show ID | cancel ID | followup ID MESSAGE | start AGENT [--harness pi|omp|claude|codex|fx] TASK]";
// Tokens are literal, not shell syntax; only the documented option position is parsed.
function parse(raw: string) {
 const text = raw.trim();
 if (!text) return { action: "open" };
 if (text === "list") return { action: "list" };
 const panel = /^panel(?: (expand|collapse))?$/.exec(text);
 if (panel) return { action: "panel", expanded: panel[1] ? panel[1] === "expand" : undefined };
 let m = /^(show|cancel)\s+(\S+)$/.exec(text);
 if (m) return { action: m[1], id: m[2] };
 m = /^followup\s+(\S+)\s+([\s\S]+)$/.exec(text);
 if (m) return { action: "followup", id: m[1], task: m[2] };
 m = /^start\s+([^\s-][^\s]*)(?:\s+--harness\s+(\S+))?\s+([\s\S]+)$/.exec(text);
 if (m && (!m[2] || HARNESS_NAMES.includes(m[2] as HarnessName)) && !m[3].startsWith("--"))
  return { action: "start", agent: m[1], harness: m[2] as HarnessName | undefined, task: m[3] };
 throw new Error(help);
}

export function registerRunUi(pi: ExtensionAPI, agents: Agents, extra?: AgentActivitySource, workflows?: Workflows): void {
 const dockView = new WorkflowView();
 let workflowRows: WorkflowSnapshot[] = [];
 let generation = 0, controller: AbortController | undefined;
 let owner: ExtensionContext | undefined, expanded = false, epoch = 0;
 let off: (() => void)[] = [], timer: ReturnType<typeof setInterval> | undefined;
 let requestRender: (() => void) | undefined, mounted = false, queued = false;
 let rows: readonly AgentActivity[] = [];
 const key = "hempi.agent-panel";
 const close = () => { generation++; controller?.abort(); controller = undefined; };
 const stopTimer = () => { if (timer) clearInterval(timer); timer = undefined; };
 const detach = () => {
  epoch++; queued = false; stopTimer(); for (const unsubscribe of off) unsubscribe(); off = [];
  owner?.ui.setStatus("hempi-runs", undefined);
  if (mounted) owner?.ui.setWidget(key, undefined);
  mounted = false; requestRender = undefined; rows = []; workflowRows = []; owner = undefined;
 };
 const toggle = (value?: boolean) => {
  if (!owner || !agents.owns(owner)) return;
  expanded = value ?? !expanded;
  pi.appendEntry(key, { expanded }); requestRender?.();
 };
 const bind = (ctx: ExtensionContext) => {
  close(); detach(); owner = ctx;
  expanded = false;
  for (const entry of ctx.sessionManager.getBranch()) {
   if (entry.type === "custom" && entry.customType === key && typeof (entry.data as { expanded?: unknown })?.expanded === "boolean")
    expanded = (entry.data as { expanded: boolean }).expanded;
  }
  const registry = agents.runs, token = epoch;
  const valid = () => token === epoch && owner === ctx && agents.owns(ctx);
  const ensureOwner = () => {
   if (valid()) return true;
   if (token === epoch && owner === ctx) { close(); detach(); }
   return false;
  };
  const refresh = () => {
   if (!ensureOwner()) return;
   const overview = registry.overview(), n = overview.filter(live).length;
   ctx.ui.setStatus("hempi-runs", ctx.mode !== "tui" && n ? `${n} agent run${n === 1 ? "" : "s"}` : undefined);
   if (ctx.mode !== "tui") return;
   workflowRows = workflows?.list().filter(w => activeWorkflow(w.state) || Date.now() - (w.finishedAt ?? w.updatedAt) < 6000) ?? [];
   const retained = new Set(workflowRows.filter(w => activeWorkflow(w.state)).map(w => w.id));
   rows = [...overview.filter(row => row.workflowId && retained.has(row.workflowId)), ...visibleActivities(overview.filter(row => !row.workflowId || !retained.has(row.workflowId)), Date.now())]
    .map(row => ({ ...row, title: row.label ?? row.agent, label: row.label ?? row.agent }));
   rows = [...rows, ...visibleActivities(extra?.snapshot() ?? [], Date.now())];
   if (!rows.length && !workflowRows.length) {
    stopTimer(); if (mounted) ctx.ui.setWidget(key, undefined);
    mounted = false; requestRender = undefined; return;
   }
   if (!mounted) {
    mounted = true;
    ctx.ui.setWidget(key, (tui, theme) => {
     if (!valid()) return { render: () => [], invalidate() {} };
     requestRender = () => { if (valid()) tui.requestRender(); };
     return new ActivityPanel(theme, () => valid() ? rows : [], () => expanded, () => toggle(),
      () => tui.mode === "fullscreen", () => tui.terminal.rows, Date.now, () => valid() ? workflowRows : [], dockView);
    }, { placement: "aboveEditor" });
   }
   requestRender?.();
   if (!workflowRows.length && !rows.some(row => activityActive(row) || !activityLive(row))) stopTimer();
   else if (!timer) { timer = setInterval(refresh, 1000); timer.unref(); }
  };
  const schedule = () => {
   if (!ensureOwner() || queued) return;
   queued = true;
   queueMicrotask(() => { if (!valid()) return; queued = false; refresh(); });
  };
  off.push(registry.subscribe(schedule));
  if (workflows) off.push(workflows.subscribe(schedule));
  if (ctx.mode === "tui" && extra) off.push(extra.subscribe(schedule));
  off.push(agents.subscribeRegistry(next => {
   if (token !== epoch || owner !== ctx) return;
   if (!agents.owns(ctx)) { close(); detach(); return; }
   if (next !== registry) bind(ctx);
  }));
  refresh();
 };
 pi.on("session_start", (_e, ctx) => bind(ctx));
 pi.on("session_tree", (_e, ctx) => bind(ctx));
 pi.on("session_before_switch", () => { close(); detach(); });
 pi.on("session_before_tree", () => { close(); detach(); });
 pi.on("session_before_fork", () => { close(); detach(); });
 pi.on("session_shutdown", () => { close(); detach(); });

 async function browse(ctx: ExtensionContext): Promise<void> {
  close(); const epoch = generation, abort = new AbortController(); controller = abort;
  const registry = agents.runs;
  try {
   while (!abort.signal.aborted && epoch === generation) {
    const id = await ctx.ui.custom<string | null>((tui, theme, kb, done) => {
     let selected = 0, detail = false, scroll = 0, page = 1, closed = false;
     const finish = (id: string | null) => { if (!closed) { closed = true; off(); done(id); } };
     const stop = () => finish(null);
     const off = registry.subscribe(() => { if (!closed) tui.requestRender(); });
     abort.signal.addEventListener("abort", stop, { once: true });
     if (abort.signal.aborted) finish(null);
     return {
      invalidate() {},
      dispose() { closed = true; off(); abort.signal.removeEventListener("abort", stop); },
      render(width: number) {
       const rows = registry.overview(); selected = Math.max(0, Math.min(selected, rows.length - 1));
       const height = Math.max(1, tui.terminal.rows - 1); page = Math.max(1, height - 5);
       const lines = detail && rows[selected] ? details(registry.get(rows[selected].id)!).split("\n").flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 4)))
        : rows.map((r, i) => `${i === selected ? "›" : " "} ${summary(r)}`);
       if (!lines.length) lines.push("No agent runs");
       const offset = detail ? (scroll = Math.min(scroll, Math.max(0, lines.length - page))) : Math.max(0, selected - page + 1);
       return panel(theme, width, detail ? "Agent run" : "Agent runs", lines.slice(offset, offset + page),
        detail ? "↑↓/PgUp/PgDn scroll · x cancel · f followup · Esc back" : "↑↓ select · Enter details · x cancel · f followup · Esc close")
        .slice(0, height).map(line => truncateToWidth(line, Math.max(0, width), ""));
      },
      handleInput(data: string) {
       if (closed || abort.signal.aborted || epoch !== generation) return;
       const rows = registry.overview(), run = rows[Math.min(selected, rows.length - 1)];
       if (kb.matches(data, "tui.select.cancel")) { if (detail) { detail = false; scroll = 0; } else finish(null); }
       else if (kb.matches(data, "tui.select.confirm") && run) { detail = true; scroll = 0; }
       else if (kb.matches(data, "tui.select.up")) { if (detail) scroll = Math.max(0, scroll - 1); else selected = Math.max(0, selected - 1); }
       else if (kb.matches(data, "tui.select.down")) { if (detail) scroll++; else selected = Math.min(rows.length - 1, selected + 1); }
       else if (detail && matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - page);
       else if (detail && matchesKey(data, Key.pageDown)) scroll += page;
       else if (data === "f" && run) finish(run.id);
       else if (data === "x" && run) { try { registry.cancel(run.id); } catch (e) { ctx.ui.notify(clean(e), "error"); } }
       tui.requestRender();
      },
     };
    });
    if (epoch !== generation || abort.signal.aborted || !id) return;
    const task = await promptInline(ctx, "Agent followup", clean(`Follow up ${id} (idle runs only)`), abort.signal);
    if (epoch !== generation || abort.signal.aborted) return;
    if (task) { try { agents.followup(id, task, ctx); } catch (e) { ctx.ui.notify(clean(e), "error"); } }
   }
  } finally { if (controller === abort) controller = undefined; }
 }
 async function browseWorkflows(ctx: ExtensionContext) {
  if (!workflows) return;
  close(); const token = generation, abort = new AbortController(); controller = abort;
  const registry = agents.runs;
  try {
   await ctx.ui.custom<void>((tui, theme, kb, done) => {
    const workflowView = new WorkflowView();
    let detail: { workflowId: string; runId: string } | undefined, scroll = 0, page = 1, closed = false;
    let displayed: { workflowId: string; runId?: string } | undefined;
    const finish = () => { if (!closed) { closed = true; cleanup(); done(); } };
    const valid = () => !closed && token === generation && agents.owns(ctx);
    const refresh = () => { if (!valid()) finish(); else tui.requestRender(); };
    const off = [workflows.subscribe(refresh), registry.subscribe(refresh)];
    const cleanup = () => { for (const unsubscribe of off.splice(0)) unsubscribe(); abort.signal.removeEventListener("abort", finish); };
    abort.signal.addEventListener("abort", finish, { once: true });
    return {
     invalidate() {},
     dispose() { closed = true; cleanup(); },
     render(width: number) {
      const all = workflows.list(), workflow = workflowView.current(all);
      const height = Math.max(1, tui.terminal.rows - 1); page = Math.max(1, height - 4);
      let lines = ["No workflows"];
      if (!detail) displayed = undefined;
      if (workflow) {
       const phase = workflow.phases[workflowView.phase(workflow)], task = phase?.tasks[workflowView.task];
       if (!detail) displayed = { workflowId: workflow.id, runId: task?.runId };
       const runId = detail ? detail.runId : task?.runId;
       const run = runId && registry.get(runId);
       lines = detail ? (run ? details(run) : "No run details yet").split("\n").flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 4)))
        : [`Workflow ${all.indexOf(workflow) + 1}/${all.length} · [ ] switch`, ...workflowView.render(workflow, registry.overview(), Math.max(1, width - 4), Math.max(1, page - 1), Date.now(), true)];
      }
      scroll = Math.min(scroll, Math.max(0, lines.length - page));
      return panel(theme, width, "Workflows", lines.slice(detail ? scroll : 0, (detail ? scroll : 0) + page), detail ? "↑↓ scroll · Esc back" : "←→ phase · ↑↓ task · Enter details · x cancel run · X cancel workflow · Esc close")
       .slice(0, height).map(line => truncateToWidth(line, Math.max(0, width), ""));
     },
     handleMouse(event: TuiMouseEvent) {
      if (!valid() || event.shift || event.alt || event.ctrl) return undefined;
      const workflow = workflowView.current(workflows.list());
      if (!workflow || event.y < 2 || event.x < 2) return undefined;
      let handled = false;
      if (detail && event.type === "wheel" && Number.isFinite(event.wheelDelta) && event.wheelDelta) { scroll = Math.max(0, scroll + Math.sign(event.wheelDelta)); handled = true; }
      else if (!detail) handled = workflowView.mouse({ ...event, x: event.x - 2, y: event.y - 2 }, workflow);
      if (handled) { requestRender?.(); return { handled: true, focus: false, capture: false, render: true }; }
      return undefined;
     },
     handleInput(data: string) {
      if (!valid()) { finish(); return; }
      const all = workflows.list(), workflow = workflowView.current(all);
      if (kb.matches(data, "tui.select.cancel")) { if (detail) { detail = undefined; scroll = 0; } else finish(); }
      else if (workflow) {
       const phaseIndex = workflowView.phase(workflow), phase = workflow.phases[phaseIndex];
       if (data === "[" || data === "]") { const index = (all.indexOf(workflow) + (data === "[" ? -1 : 1) + all.length) % all.length; workflowView.selectWorkflow(all[index].id); detail = undefined; }
       else if (!detail && matchesKey(data, Key.left)) workflowView.selectPhase(workflow, phaseIndex - 1);
       else if (!detail && matchesKey(data, Key.right)) workflowView.selectPhase(workflow, phaseIndex + 1);
       else if (kb.matches(data, "tui.select.up")) { if (detail) scroll = Math.max(0, scroll - 1); else workflowView.task = Math.max(0, workflowView.task - 1); }
       else if (kb.matches(data, "tui.select.down")) { if (detail) scroll++; else workflowView.task = Math.min((phase?.tasks.length ?? 1) - 1, workflowView.task + 1); }
       else if (!detail && kb.matches(data, "tui.select.confirm") && displayed?.runId) { detail = { workflowId: displayed.workflowId, runId: displayed.runId }; scroll = 0; }
       else if (detail && matchesKey(data, Key.pageDown)) scroll += page;
       else if (detail && matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - page);
       else if (data === "X" || data === "x") {
        try {
         const target = detail ?? displayed;
         if (data === "X") { if (target) workflows.cancel(target.workflowId); }
         else {
          const id = target?.runId;
          const run = id ? registry.get(id) : undefined;
          if (id && (!detail || (run && live(run)))) registry.cancel(id);
         }
        }
        catch (e) { ctx.ui.notify(clean(e), "error"); }
       }
      }
      tui.requestRender(); requestRender?.();
     },
    };
   });
  } finally { if (controller === abort) controller = undefined; }
 }
 if (workflows) pi.registerCommand("workflows", {
  description: "Inspect workflow phases and agents; list, show ID, cancel ID",
  handler: async (raw, ctx) => {
   try {
    agents.restore(ctx); workflows.restore(ctx);
    const command = raw.trim(), match = /^(show|cancel)\s+(\S+)$/.exec(command);
    if (match) {
     const workflow = workflows.get(match[2]); if (!workflow) throw new Error("Unknown workflow");
     if (match[1] === "cancel") { workflows.cancel(workflow.id); ctx.ui.notify(`Cancellation requested: ${workflow.id}`, "info"); }
     else ctx.ui.notify(clean(JSON.stringify(workflow, null, 2)), "info");
    } else if (command === "list" || (!command && ctx.mode !== "tui")) {
     ctx.ui.notify(workflows.list().map(w => workflowText(`${w.id} · ${w.title} · ${w.state} · ${w.phases.length} phases`)).join("\n") || "No workflows", "info");
    } else if (!command) await browseWorkflows(ctx);
    else throw new Error("Usage: /workflows [list | show ID | cancel ID]");
   } catch (e) { ctx.ui.notify(clean(e instanceof Error ? e.message : e), "error"); }
  },
 });
 pi.registerCommand("agent-runs", {
  description: "Monitor, start, cancel and follow up delegate runs",
  handler: async (raw, ctx) => {
   try {
    const cmd = parse(raw); agents.restore(ctx);
    if (cmd.action === "panel") {
     if (ctx.mode !== "tui") { ctx.ui.notify("Agent panel requires TUI mode", "info"); return; }
     if (owner !== ctx) bind(ctx);
     toggle(cmd.expanded); return;
    }
    if (cmd.action === "open" && ctx.mode === "tui") { await browse(ctx); return; }
    let text: string;
    if (cmd.action === "open" || cmd.action === "list") text = agents.runs.overview().map(summary).join("\n") || "No agent runs";
    else if (cmd.action === "start") text = `Started ${agents.start(cmd.agent!, cmd.task!, ctx, { harness: cmd.harness })}`;
    else if (cmd.action === "followup") text = `Started ${agents.followup(cmd.id!, cmd.task!, ctx)}`;
    else {
     const run = agents.runs.get(cmd.id!); if (!run) throw new Error(`Unknown run: ${cmd.id}`);
     if (cmd.action === "cancel") { agents.runs.cancel(run.id); text = `Cancellation requested: ${run.id}`; }
     else text = details(run);
    }
    ctx.ui.notify(clean(text), "info");
   } catch (e) { ctx.ui.notify(clean(e instanceof Error ? e.message : e), "error"); }
  },
 });
}
