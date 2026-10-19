import { randomUUID } from "node:crypto";
import { HARNESS_NAMES, type HarnessName } from "./config.ts";
import type { RunState } from "./acp/runs.ts";

export const WORKFLOW_LIMITS = { title: 120, task: 128000, phases: 16, tasksPerPhase: 8, tasks: 64, live: 4, history: 40, answer: 4000, previous: 16000 } as const;
export type WorkflowState = "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
export type PhaseState = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface WorkflowTaskInput { agent: string; task: string; label?: string; harness?: HarnessName }
export interface WorkflowPhaseInput { title: string; tasks: WorkflowTaskInput[] }
export interface WorkflowInput { title: string; phases: WorkflowPhaseInput[]; open?: boolean }
export interface WorkflowTask { agent: string; label: string; harness?: HarnessName; runId?: string; state: RunState | "pending"; answer?: string; error?: string }
export interface WorkflowPhase { id: string; title: string; state: PhaseState; tasks: WorkflowTask[] }
export interface WorkflowSnapshot { id: string; title: string; state: WorkflowState; open: boolean; phases: WorkflowPhase[]; startedAt: number; updatedAt: number; finishedAt?: number; error?: string }
export const activeWorkflow = (state: WorkflowState) => state === "running" || state === "waiting";
export function text(value: unknown, name: string, max: number = WORKFLOW_LIMITS.title): string {
 if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid workflow ${name} (1-${max} characters)`);
 return value;
}
export function object(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workflow object");
 return value as Record<string, unknown>;
}
export function validatePhases(value: unknown): WorkflowPhaseInput[] {
 if (!Array.isArray(value) || !value.length || value.length > WORKFLOW_LIMITS.phases) throw new Error("Invalid workflow phase count");
 let total = 0;
 const phases = value.map(raw => {
  const phase = object(raw);
  const title = text(phase.title, "phase title");
  if (!Array.isArray(phase.tasks) || !phase.tasks.length || phase.tasks.length > WORKFLOW_LIMITS.tasksPerPhase) throw new Error("Invalid workflow phase task count");
  total += phase.tasks.length;
  const tasks = phase.tasks.map(rawTask => {
   const task = object(rawTask);
   const agent = text(task.agent, "agent");
   const prompt = text(task.task, "task", WORKFLOW_LIMITS.task);
   const label = task.label === undefined ? agent : text(task.label, "label");
   if (task.harness !== undefined && !HARNESS_NAMES.includes(task.harness as HarnessName)) throw new Error("Invalid workflow harness");
   return { agent, task: prompt, label, harness: task.harness as HarnessName | undefined };
  });
  return { title, tasks };
 });
 if (total > WORKFLOW_LIMITS.tasks) throw new Error("Workflow total task limit exceeded");
 return phases;
}
export function phaseSnapshots(phases: WorkflowPhaseInput[]): WorkflowPhase[] {
 return phases.map(phase => ({ id: randomUUID(), title: phase.title, state: "pending", tasks: phase.tasks.map(({ agent, label, harness }) => ({ agent, label: label ?? agent, harness, state: "pending" })) }));
}
export function restoreSnapshot(value: unknown): WorkflowSnapshot {
 const raw = object(value);
 const id = (value: unknown) => {
  const result = text(value, "id", 128);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new Error("Invalid workflow id");
  return result;
 };
 const error = (value: unknown) => {
  if (typeof value !== "string" || value.length > 1000) throw new Error("Invalid workflow error");
  return value;
 };
 const timestamp = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid workflow timestamp");
  return value;
 };
 if (typeof raw.open !== "boolean" || !["running", "waiting", "completed", "failed", "cancelled", "interrupted"].includes(raw.state as string)) throw new Error("Invalid workflow state");
 if (!Array.isArray(raw.phases) || !raw.phases.length || raw.phases.length > WORKFLOW_LIMITS.phases) throw new Error("Invalid workflow phases");
 let total = 0;
 const ids = new Set<string>();
 const phases: WorkflowPhase[] = raw.phases.map(value => {
  const phase = object(value), phaseId = id(phase.id);
  if (ids.has(phaseId)) throw new Error("Duplicate workflow phase");
  ids.add(phaseId);
  if (!["pending", "running", "completed", "failed", "cancelled", "interrupted"].includes(phase.state as string)) throw new Error("Invalid workflow phase state");
  if (!Array.isArray(phase.tasks) || !phase.tasks.length || phase.tasks.length > WORKFLOW_LIMITS.tasksPerPhase) throw new Error("Invalid workflow tasks");
  total += phase.tasks.length;
  const tasks: WorkflowTask[] = phase.tasks.map(value => {
   const task = object(value);
   if (!["pending", "queued", "starting", "running", "awaiting_approval", "completed", "failed", "cancelled", "interrupted"].includes(task.state as string)) throw new Error("Invalid workflow task state");
   if (task.harness !== undefined && !HARNESS_NAMES.includes(task.harness as HarnessName)) throw new Error("Invalid workflow harness");
   return { agent: text(task.agent, "agent"), label: text(task.label, "label"), harness: task.harness as HarnessName | undefined,
    runId: task.runId === undefined ? undefined : id(task.runId), state: task.state as WorkflowTask["state"],
    answer: task.answer === undefined ? undefined : typeof task.answer === "string" ? task.answer.slice(0, WORKFLOW_LIMITS.answer) : text(null, "answer"),
    error: task.error === undefined ? undefined : error(task.error) };
  });
  return { id: phaseId, title: text(phase.title, "phase title"), state: phase.state as PhaseState, tasks };
 });
 if (total > WORKFLOW_LIMITS.tasks) throw new Error("Workflow total task limit exceeded");
 const snapshot: WorkflowSnapshot = { id: id(raw.id), title: text(raw.title, "title"), state: raw.state as WorkflowState, open: raw.open,
  phases, startedAt: timestamp(raw.startedAt), updatedAt: timestamp(raw.updatedAt),
  finishedAt: raw.finishedAt === undefined ? undefined : timestamp(raw.finishedAt), error: raw.error === undefined ? undefined : error(raw.error) };
 if (activeWorkflow(snapshot.state)) {
  snapshot.state = "interrupted"; snapshot.open = false; snapshot.finishedAt = snapshot.updatedAt;
  snapshot.error = "Parent session interrupted; tasks are never replayed automatically";
  for (const phase of phases) {
   if (phase.state === "pending" || phase.state === "running") phase.state = "interrupted";
   for (const task of phase.tasks) if (!["completed", "failed", "cancelled", "interrupted"].includes(task.state)) task.state = "interrupted";
  }
 }
 return snapshot;
}
export function displaySnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
 const copy = structuredClone(snapshot);
 for (const phase of copy.phases) for (const task of phase.tasks) delete task.answer;
 return copy;
}
