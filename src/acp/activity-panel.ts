import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { safeText } from "../ui.ts";
import type { AgentActivity } from "./activity-types.ts";
import type { WorkflowSnapshot } from "../workflow-types.ts";
import { WorkflowView, agentTable, agentElapsed, compactTokens } from "./workflow-view.ts";

export const activityLive = (row: AgentActivity) => ["queued", "starting", "running", "awaiting_approval", "waiting", "stopping", "paused"].includes(row.state);
export const activityActive = (row: AgentActivity) => activityLive(row) && row.state !== "paused";
export const visibleActivities = (rows: readonly AgentActivity[], now: number) => rows.filter(row => {
 const age = now - (row.finishedAt ?? row.updatedAt);
 return activityLive(row) || (age >= 0 && age < 6000);
});
const clean = (text: string) => safeText(stripTerminalSequences(text)).replace(/[\u0080-\u009f]/g, "").replace(/\s+/g, " ").trim();
export const activityElapsed = agentElapsed;
const compact = compactTokens;

/** Unfocusable; body gestures remain available for terminal selection. */
export class ActivityPanel implements Component {
 private workflowTop = 0;
 private workflowBottom = 0;
 private left = 0;
 private right = 0;
 private bodyLeft = 0;
 private independentOffset = 0;
 private independentCapacity = 0;
 private independentTop = 0;
 private independentBottom = 0;
 private independentTotal = 0;
 private offset = 0;
 private capacity = 0;
 private bodyEnd = 0;
 private total = 0;
 private headerPressed = false;
 private readonly theme: Theme;
 private readonly rows: () => readonly AgentActivity[];
 private readonly expanded: () => boolean;
 private readonly toggle: () => void;
 private readonly fullscreen: () => boolean;
 private readonly height: () => number;
 private readonly now: () => number;
 private readonly workflows: () => readonly WorkflowSnapshot[];
 private readonly view: WorkflowView;
 constructor(theme: Theme, rows: () => readonly AgentActivity[], expanded: () => boolean,
  toggle: () => void, fullscreen: () => boolean, height: () => number, now: () => number = Date.now,
  workflows: () => readonly WorkflowSnapshot[] = () => [],
  view: WorkflowView = new WorkflowView()) {
  this.workflows = workflows; this.view = view;
  this.theme = theme; this.rows = rows; this.expanded = expanded; this.toggle = toggle;
  this.fullscreen = fullscreen; this.height = height; this.now = now;
 }
 invalidate() {} // Colors are evaluated on every render, never stored in activity state.
 render(width: number): string[] {
  const rank = (row: AgentActivity) => activityActive(row) ? 0 : row.state === "paused" ? 1 : 2;
  const rows = [...this.rows()].sort((a, b) => rank(a) - rank(b)), now = this.now();
  const workflows = this.workflows(), workflow = this.view.current(workflows);
  const w = Math.max(0, Math.min(workflow ? 110 : 68, width)), budget = Math.max(1, Math.min(15, this.height() - 6));
  this.capacity = this.bodyEnd = this.workflowTop = this.workflowBottom = 0; this.total = rows.length;
  this.independentCapacity = this.independentTop = this.independentBottom = this.independentTotal = 0;
  if ((!rows.length && !workflow) || !w) { this.left = this.right = 0; return []; }
  const active = rows.filter(activityActive);
  const elapsed = active.length ? ` · ${activityElapsed(active.reduce((a, b) => a.startedAt < b.startedAt ? a : b), now)}` : "";
  const idle = rows.filter(row => row.state === "paused").length;
  const status = !rows.length && workflow ? workflow.state : active.length ? `${active.length} active${idle ? ` · ${idle} idle` : ""}` : idle ? `${idle} idle` : `${rows.length} finished`;
  const header = `${this.expanded() ? "▾" : "▸"} Agents · ${status}${elapsed}${workflows.length ? ` · ${workflows.length} workflow${workflows.length === 1 ? "" : "s"}` : ""}`;
  this.right = width;
  const line = truncateToWidth(header, w, ""); this.left = width - visibleWidth(line);
  const lines = [" ".repeat(this.left) + this.theme.fg(this.expanded() ? "accent" : "muted", line)];
  if (!this.expanded() || budget < 4 || w < 3) return lines;
  this.bodyLeft = width - w;
  const inner = w - 2, indent = " ".repeat(this.bodyLeft);
  const border = (text: string) => this.theme.fg("borderMuted", text);
  const frame = (text: string, role: "text" | "muted") => {
   const cut = truncateToWidth(safeText(stripTerminalSequences(text)).replace(/[\u0080-\u009f\r\n]/g, ""), inner, "");
   // Complete rows mask the transcript without applying a theme background.
   lines.push(indent + border("│") + this.theme.fg(role, cut) + " ".repeat(inner - visibleWidth(cut)) + border("│"));
  };
  lines.push(indent + border(`╭${"─".repeat(inner)}╮`));
  if (workflow) {
   const independent = rows.filter(row => !row.workflowId);
   const reserve = independent.length ? Math.min(4, Math.max(3, budget - 7)) : 0;
   this.workflowTop = lines.length;
   for (const line of this.view.render(workflow, rows, inner, Math.max(1, budget - 3 - reserve), now)) {
    const cut = truncateToWidth(line, inner, "");
    lines.push(indent + border("│") + this.theme.fg("text", cut) + " ".repeat(inner - visibleWidth(cut)) + border("│"));
   }
   this.workflowBottom = lines.length;
   if (independent.length && lines.length < budget - 1) {
    this.independentTotal = independent.length;
    this.independentCapacity = Math.max(0, budget - lines.length - 3);
    this.independentOffset = Math.max(0, Math.min(this.independentOffset, independent.length - this.independentCapacity));
    const hints = [independent.some(row => !row.id.startsWith("optchat:")) ? "/agent-runs" : "", independent.some(row => row.id.startsWith("optchat:")) ? "/optchat agents" : ""].filter(Boolean).join(" · ");
    const overflow = independent.length > this.independentCapacity ? ` · +${independent.length - this.independentCapacity} more` : "";
    frame(`Independent (${independent.length})${overflow} · ${hints}`, "muted");
    this.independentTop = lines.length;
    for (const line of agentTable(independent.slice(this.independentOffset, this.independentOffset + this.independentCapacity), inner, now).slice(1)) frame(line, "text");
    this.independentBottom = lines.length;
   }
   if (lines.length < budget - 1) frame(`${workflows.length > 1 ? `${workflows.length} workflows · ` : ""}/workflows · ←→ phases in inspector`, "muted");
   lines.push(indent + border(`╰${"─".repeat(inner)}╯`));
   this.bodyEnd = lines.length;
   return lines;
  }
  if (budget >= 5 && rows.length && rows.every(row => row.label && !row.id.startsWith("optchat:"))) {
   this.capacity = Math.max(1, budget - 5);
   this.offset = Math.max(0, Math.min(this.offset, rows.length - this.capacity));
   for (const line of agentTable(rows.slice(this.offset, this.offset + this.capacity), inner, now)) frame(line, "text");
   if (rows.length > this.capacity && lines.length < budget - 1) frame(`${this.offset + 1}–${Math.min(rows.length, this.offset + this.capacity)}/${rows.length} · /agent-runs`, "muted");
   lines.push(indent + border(`╰${"─".repeat(inner)}╯`)); this.bodyEnd = lines.length;
   return lines;
  }
  let count = Math.max(0, Math.min(6, Math.floor((budget - 3) / 2)));
  if (rows.length > count) count = Math.max(0, Math.min(6, Math.floor((budget - 4) / 2)));
  this.capacity = count;
  this.offset = Math.max(0, Math.min(this.offset, rows.length - count));
  const shown = rows.slice(this.offset, this.offset + count);
  for (const row of shown) {
   frame(`${clean(row.agent)} · ${clean(row.title)}`, "text");
   const state = row.state === "paused" ? "idle" : clean(row.state);
   const wait = ["queued", "starting"].includes(row.state) ? "wait " : "";
   frame(`${clean(row.harness)} · ${state} · ${wait}${activityElapsed(row, now)} · tokens ${compact(row.reportedTokens)}${row.contextTokens === undefined ? "" : ` · ctx ${compact(row.contextTokens)}`}`, "muted");
  }
  if (shown.length < rows.length && lines.length < budget - 1) {
   const hints = [rows.some(row => !row.id.startsWith("optchat:")) ? "/agent-runs" : "", rows.some(row => row.id.startsWith("optchat:")) ? "/optchat agents" : ""].filter(Boolean).join(" · ");
   frame(`+${rows.length - shown.length} more · ${hints}`, "muted");
  }
  lines.push(indent + border(`╰${"─".repeat(inner)}╯`));
  this.bodyEnd = lines.length;
  return lines;
 }
 handleMouse(event: TuiMouseEvent) {
  if (!this.fullscreen() || event.shift || event.alt || event.ctrl) return undefined;
  if (event.type === "release" && this.headerPressed) {
   this.headerPressed = false;
   return { handled: true, focus: false, capture: false, render: false };
  }
  const inside = event.x >= this.left && event.x < this.right;
  if (event.type === "press" && event.button === "left" && event.y === 0 && inside) {
   this.headerPressed = true; this.toggle();
   return { handled: true, focus: false, capture: true, render: true };
  }
  if (event.type === "wheel" && this.expanded() && event.x > this.bodyLeft && event.x < this.right - 1 && event.y >= this.independentTop && event.y < this.independentBottom && this.independentCapacity > 0 && this.independentTotal > this.independentCapacity && Number.isFinite(event.wheelDelta) && event.wheelDelta) {
   this.independentOffset = Math.max(0, Math.min(this.independentTotal - this.independentCapacity, this.independentOffset + Math.sign(event.wheelDelta)));
   return { handled: true, focus: false, capture: false, render: true };
  }
  if (this.expanded() && event.x > this.bodyLeft && event.x < this.right - 1 && event.y >= this.workflowTop && event.y < this.workflowBottom) {
   const workflow = this.view.current(this.workflows());
   if (workflow && this.view.mouse({ ...event, x: event.x - this.bodyLeft - 1, y: event.y - this.workflowTop }, workflow))
    return { handled: true, focus: false, capture: false, render: true };
  }
  if (event.type === "wheel" && event.x >= this.bodyLeft && event.x < this.right && this.expanded() && this.capacity > 0 && this.total > this.capacity && event.y > 0 && event.y < this.bodyEnd && Number.isFinite(event.wheelDelta) && event.wheelDelta) {
   this.offset = Math.max(0, Math.min(this.total - this.capacity, this.offset + Math.sign(event.wheelDelta)));
   return { handled: true, focus: false, capture: false, render: true };
  }
  return undefined;
 }
}
