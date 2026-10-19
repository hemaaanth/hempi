import { stripTerminalSequences, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { safeText } from "../ui.ts";
import { activeWorkflow, type WorkflowSnapshot } from "../workflow-types.ts";
import type { AgentActivity } from "./activity-types.ts";

export const workflowText = (value: string) => safeText(stripTerminalSequences(value)).replace(/[\u0080-\u009f]/g, "").replace(/\s+/g, " ").trim();
const cell = (value: string, width: number) => { const text = truncateToWidth(workflowText(value), Math.max(0, width), ""); return text + " ".repeat(Math.max(0, width - visibleWidth(text))); };
const icon = (state: string) => state === "completed" ? "✓" : ["running", "waiting"].includes(state) ? "●" : ["failed", "interrupted"].includes(state) ? "!" : state === "cancelled" ? "×" : "○";
export const compactTokens = (n: number | undefined) => n === undefined ? "—" : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n);
export function agentElapsed(row: AgentActivity, now: number): string {
 const live = ["queued", "starting", "running", "awaiting_approval", "waiting", "stopping"].includes(row.state);
 const end = row.state === "paused" ? row.updatedAt : live ? now : row.finishedAt ?? row.updatedAt;
 const seconds = Math.max(0, Math.floor((end - (row.runningAt ?? row.startedAt)) / 1000));
 return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function agentTable(rows: readonly AgentActivity[], width: number, now: number, selected = -1): string[] {
 const columns: [number, (row: AgentActivity) => string, string][] = [[Math.max(1, width - (width >= 65 ? 47 : width >= 40 ? 28 : width >= 25 ? 17 : 0)), row => width >= 40 ? `${row.agent} · ${row.label ?? row.title}` : row.label ?? row.title, "Agent · Task"]];
 if (width >= 25) columns.push([11, row => row.state, "Status"], [6, row => { if (!Number.isFinite(row.startedAt) || row.state === "pending") return "—"; return agentElapsed(row, now); }, "Time"]);
 if (width >= 40) columns.push([11, row => compactTokens(row.reportedTokens), "Tokens"]);
 if (width >= 65) columns.push([19, row => `${row.harness} ${row.model ?? ""}`, "Harness / Model"]);
 const line = (values: string[]) => truncateToWidth(values.map((v, i) => cell(v, columns[i][0])).join(""), width, "");
 return [line(columns.map(c => c[2])), ...rows.map((row, i) => line(columns.map((c, index) => `${index === 0 && i === selected ? "›" : ""}${c[1](row)}`)))];
}
/** Selection and layout owned by a single rendering surface. */
export class WorkflowView {
 workflowId?: string;
 phaseId?: string;
 task = 0;
 private pinned = false;
 private phaseOffset = 0;
 private taskOffset = 0;
 private split = 0;
 private capacity = 1;
 private phaseCount = 0;
 private taskCount = 0;
 private phaseStart = 1;
 current(workflows: readonly WorkflowSnapshot[]) {
  return workflows.find(w => w.id === this.workflowId) ?? workflows.find(w => activeWorkflow(w.state)) ?? workflows.at(-1);
 }
 selectWorkflow(id: string) { this.workflowId = id; this.phaseId = undefined; this.pinned = false; this.task = this.taskOffset = this.phaseOffset = 0; }
 phase(workflow: WorkflowSnapshot) {
  let index = workflow.phases.findIndex(p => p.id === this.phaseId);
  if (!this.pinned || index < 0) { index = workflow.phases.findIndex(p => p.state === "running" || p.state === "pending"); if (index < 0) index = workflow.phases.length - 1; }
  this.phaseId = workflow.phases[index]?.id;
  this.task = Math.max(0, Math.min(this.task, (workflow.phases[index]?.tasks.length ?? 0) - 1));
  return index;
 }
 selectPhase(workflow: WorkflowSnapshot, index: number) {
  this.phaseId = workflow.phases[Math.max(0, Math.min(index, workflow.phases.length - 1))]?.id;
  this.pinned = true; this.task = this.taskOffset = 0;
 }
 render(workflow: WorkflowSnapshot, runs: readonly AgentActivity[], width: number, height: number, now: number, selected = false): string[] {
  if (height < 1 || width < 1) return [];
  const index = this.phase(workflow), phase = workflow.phases[index];
  if (!phase) return [];
  const phases = workflow.phases.map((p, i) => `${i === index ? "›" : " "}${icon(p.state)} ${p.title} ${p.tasks.filter(t => t.state === "completed").length}/${p.tasks.length}`);
  const tasks = phase.tasks.map(t => ({ ...(runs.find(r => r.id === t.runId) ?? { id: t.runId ?? "", startedAt: NaN, updatedAt: workflow.updatedAt, title: t.label, harness: t.harness ?? "—" }), agent: t.agent, label: t.label, state: t.state }));
  this.phaseCount = phases.length; this.taskCount = tasks.length;
  this.task = Math.max(0, Math.min(this.task, tasks.length - 1));
  this.split = width >= 60 ? Math.min(28, Math.floor(width / 3)) : 0;
  this.capacity = Math.max(1, height - (this.split ? 2 : 3));
  if (!this.pinned) this.phaseOffset = Math.max(0, index - this.capacity + 1);
  this.phaseOffset = Math.max(0, Math.min(this.phaseOffset, Math.max(0, phases.length - this.capacity)));
  this.taskOffset = Math.max(0, Math.min(Math.max(Math.min(this.taskOffset, this.task), this.task - this.capacity + 1), Math.max(0, tasks.length - this.capacity)));
  const table = agentTable(tasks, Math.max(1, width - (this.split ? this.split + 1 : 0)), now, selected ? this.task : -1);
  const title = `${workflowText(workflow.title)} · ${workflow.state} · ${workflow.phases.filter(p => p.state === "completed").length}/${phases.length} phases`;
  this.phaseStart = 2;
  const body = this.split ? [cell("Phases", this.split) + "│" + table[0], ...Array.from({ length: Math.min(this.capacity, Math.max(phases.length, tasks.length)) }, (_, i) => cell(phases[this.phaseOffset + i] ?? "", this.split) + "│" + (table[this.taskOffset + i + 1] ?? ""))]
   : [`Phases ${index + 1}/${phases.length} · ${workflowText(phase.title)} · ${phase.state} (${phase.tasks.filter(t => t.state === "completed").length}/${tasks.length})`, table[0], ...table.slice(this.taskOffset + 1, this.taskOffset + 1 + this.capacity)];
  return [title, ...body].slice(0, height).map(line => truncateToWidth(line, width, ""));
 }
 mouse(event: TuiMouseEvent, workflow: WorkflowSnapshot) {
  if (event.type === "press" && event.button === "left") {
   if (this.split && event.x < this.split && event.y >= this.phaseStart && event.y - this.phaseStart < this.capacity && this.phaseOffset + event.y - this.phaseStart < workflow.phases.length) { this.selectPhase(workflow, this.phaseOffset + event.y - this.phaseStart); return true; }
   if (!this.split && event.y === 1) { this.selectPhase(workflow, (this.phase(workflow) + 1) % workflow.phases.length); return true; }
  }
  if (event.type !== "wheel" || !Number.isFinite(event.wheelDelta) || !event.wheelDelta) return false;
  const delta = Math.sign(event.wheelDelta);
  if (this.split && event.x < this.split) { this.pinned = true; this.phaseOffset = Math.max(0, Math.min(Math.max(0, this.phaseCount - this.capacity), this.phaseOffset + delta)); }
  else { this.taskOffset = Math.max(0, Math.min(Math.max(0, this.taskCount - this.capacity), this.taskOffset + delta)); this.task = this.taskOffset; }
  return true;
 }
}
