import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HARNESS_NAMES } from "./config.ts";
import type { StartOptions } from "./acp/delegates.ts";
import type { RunRegistry } from "./acp/runs.ts";
import { WORKFLOW_LIMITS as L, activeWorkflow, text, object, validatePhases, phaseSnapshots, displaySnapshot, restoreSnapshot,
 type WorkflowInput, type WorkflowPhaseInput, type WorkflowSnapshot } from "./workflow-types.ts";
export type { WorkflowInput, WorkflowPhaseInput, WorkflowTaskInput, WorkflowSnapshot, WorkflowPhase, WorkflowTask, WorkflowState, PhaseState } from "./workflow-types.ts";
export { WORKFLOW_LIMITS } from "./workflow-types.ts";
/** Structural adapter keeps orchestration tests independent of paid model execution. */
export interface WorkflowAgents {
 readonly epoch: number; readonly runs: RunRegistry;
 restore(ctx: ExtensionContext): void;
 owns(ctx: ExtensionContext): boolean;
 preflight(agent: string, ctx: ExtensionContext, options?: StartOptions): void;
 start(agent: string, task: string, ctx: ExtensionContext, options?: StartOptions): string;
}
type Job = { snapshot: WorkflowSnapshot; prompts: WorkflowPhaseInput[]; ctx: ExtensionContext; epoch: number; generation: number;
 registry: RunRegistry; pumping: boolean; cancelled: boolean; controller: AbortController;
 waiters: Set<() => void>; done: Promise<WorkflowSnapshot>; resolve: (value: WorkflowSnapshot) => void };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000) || "Workflow failed";
export class Workflows {
 private records = new Map<string, WorkflowSnapshot>();
 private jobs = new Map<string, Job>();
 private listeners = new Set<() => void>();
 private generation = 0;
 private owner?: string;
 private ownerEpoch?: number;
 private stopped = true;
 private readonly pi: ExtensionAPI;
 private readonly agents: WorkflowAgents;
 constructor(pi: ExtensionAPI, agents: WorkflowAgents) { this.pi = pi; this.agents = agents; }
 subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
 private notify(): void {
  for (const listener of this.listeners) {
   try { const result: unknown = listener(); void Promise.resolve(result).catch(() => {}); }
   catch { /* Display observers cannot stop work. */ }
  }
 }
 private key(ctx: ExtensionContext): string { return `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getSessionFile() ?? ""}`; }
 private owns(job: Job): boolean {
  return !this.stopped && job.generation === this.generation && job.epoch === this.agents.epoch && this.owner === this.key(job.ctx) && this.agents.owns(job.ctx);
 }
 private assertOwner(job: Job): void { if (!this.owns(job) || job.cancelled) throw new Error("Workflow belongs to a stopped parent session"); }
 private changed(job: Job): void {
  job.snapshot.updatedAt = Date.now();
  if (!this.owns(job)) return;
  this.pi.appendEntry("hempi.workflow", structuredClone(job.snapshot));
  this.notify();
 }
 list(): WorkflowSnapshot[] { return [...this.records.values()].map(displaySnapshot); }
 get(id: string): WorkflowSnapshot | undefined { const value = this.records.get(id); return value && displaySnapshot(value); }
 /** Results are opt-in and limited to one phase; prompts never enter display snapshots. */
 status(id: string, phaseId?: string): WorkflowSnapshot {
  const snapshot = this.records.get(id);
  if (!snapshot) throw new Error("Unknown workflow");
  if (!phaseId) return displaySnapshot(snapshot);
  const phase = snapshot.phases.find(phase => phase.id === phaseId);
  if (!phase) throw new Error("Unknown workflow phase");
  return structuredClone({ ...snapshot, phases: [phase] });
 }
 restore(ctx: ExtensionContext): void {
  const key = this.key(ctx);
  if (!this.stopped && key === this.owner && this.ownerEpoch === this.agents.epoch && this.agents.owns(ctx)) return;
  void this.stop();
  this.agents.restore(ctx);
  this.owner = key; this.ownerEpoch = this.agents.epoch; this.stopped = false; this.records = new Map(); this.jobs = new Map();
  const newest = new Map<string, unknown>();
  for (const entry of ctx.sessionManager.getBranch()) {
   if (entry.type === "custom" && entry.customType === "hempi.workflow" && entry.data && typeof entry.data === "object" && "id" in entry.data && typeof entry.data.id === "string") {
    newest.delete(entry.data.id); newest.set(entry.data.id, entry.data);
   }
  }
  for (const value of [...newest.values()].slice(-L.history)) {
   try { const snapshot = restoreSnapshot(value); this.records.set(snapshot.id, snapshot); }
   catch { /* Malformed historical custom entries are not executable input. */ }
  }
  this.notify();
 }
 private preflight(phases: WorkflowPhaseInput[], ctx: ExtensionContext): void {
  for (const phase of phases) for (const task of phase.tasks) this.agents.preflight(task.agent, ctx, { harness: task.harness });
 }
 start(input: WorkflowInput, ctx: ExtensionContext): string {
  const raw = object(input), title = text(raw.title, "title"), phases = validatePhases(raw.phases);
  if (raw.open !== undefined && typeof raw.open !== "boolean") throw new Error("Invalid workflow open flag");
  this.restore(ctx);
  const epoch = this.agents.epoch, generation = this.generation;
  this.preflight(phases, ctx);
  if (epoch !== this.agents.epoch || generation !== this.generation || !this.agents.owns(ctx)) throw new Error("Parent session changed during preflight");
  if (this.jobs.size >= L.live) throw new Error("Too many live workflows");
  if (this.records.size >= L.history) {
   const oldest = [...this.records.values()].filter(value => !activeWorkflow(value.state)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
   if (!oldest) throw new Error("Workflow history is full");
   this.records.delete(oldest.id);
  }
  const now = Date.now(), id = randomUUID();
  const snapshot: WorkflowSnapshot = { id, title, state: "running", open: raw.open === true, phases: phaseSnapshots(phases), startedAt: now, updatedAt: now };
  let resolve!: Job["resolve"];
  const done = new Promise<WorkflowSnapshot>(yes => { resolve = yes; });
  const job: Job = { snapshot, prompts: phases, ctx, epoch, generation, registry: this.agents.runs, pumping: false, cancelled: false,
   controller: new AbortController(), waiters: new Set(), done, resolve };
  this.records.set(id, snapshot); this.jobs.set(id, job);
  try { this.changed(job); } catch (error) { this.records.delete(id); this.jobs.delete(id); throw error; }
  this.launch(job);
  return id;
 }
 private requireJob(id: string): Job {
  const job = this.jobs.get(id);
  if (!job) throw new Error("Unknown or terminal workflow");
  this.assertOwner(job); return job;
 }
 append(id: string, supplied: WorkflowPhaseInput[], ctx: ExtensionContext): WorkflowSnapshot {
  const phases = validatePhases(supplied), job = this.requireJob(id);
  if (this.key(ctx) !== this.owner || !job.snapshot.open) throw new Error("Workflow is sealed or belongs to another session");
  if (job.prompts.length + phases.length > L.phases || [...job.prompts, ...phases].reduce((sum, phase) => sum + phase.tasks.length, 0) > L.tasks) throw new Error("Workflow phase/total task limit exceeded");
  this.preflight(phases, ctx); this.assertOwner(job);
  const updatedAt = job.snapshot.updatedAt, length = job.prompts.length;
  job.prompts.push(...phases); job.snapshot.phases.push(...phaseSnapshots(phases));
  try { this.changed(job); } catch (error) {
   job.prompts.splice(length); job.snapshot.phases.splice(length); job.snapshot.updatedAt = updatedAt; throw error;
  }
  this.launch(job); return this.status(id);
 }
 seal(id: string): WorkflowSnapshot {
  const job = this.requireJob(id);
  job.snapshot.open = false;
  try { this.changed(job); } catch (error) { job.snapshot.open = true; throw error; }
  this.launch(job); return this.status(id);
 }
 private cancelRuns(job: Job): void {
  for (const phase of job.snapshot.phases) for (const task of phase.tasks) {
   if (task.runId && job.registry.get(task.runId)) job.registry.cancel(task.runId);
  }
 }
 cancel(id: string): void {
  const job = this.jobs.get(id);
  if (!job) { this.status(id); return; }
  job.cancelled = true; job.controller.abort(); this.cancelRuns(job);
  if (!job.pumping) this.finish(job, "cancelled", "Workflow cancelled");
 }
 async stop(): Promise<void> {
  this.generation++; this.stopped = true;
  const jobs = [...this.jobs.values()];
  for (const job of jobs) this.cancel(job.snapshot.id);
  await Promise.all(jobs.map(job => job.done));
 }
 private finish(job: Job, state: WorkflowSnapshot["state"], error?: string): void {
  job.snapshot.state = state; job.snapshot.open = false; job.snapshot.error = error;
  job.snapshot.finishedAt = Date.now();
  for (const phase of job.snapshot.phases) {
   if (phase.state === "running") phase.state = state === "cancelled" ? "cancelled" : "failed";
   if (phase.state === "pending") phase.state = "cancelled";
   for (const task of phase.tasks) if (task.state === "pending") task.state = "cancelled";
  }
  try { this.changed(job); }
  catch (failure) { job.snapshot.state = "failed"; job.snapshot.error = errorText(failure); this.notify(); }
  if (this.jobs.get(job.snapshot.id) === job) this.jobs.delete(job.snapshot.id);
  job.prompts = [];
  job.resolve(displaySnapshot(job.snapshot));
  const waiters = [...job.waiters]; job.waiters.clear();
  for (const complete of waiters) complete();
 }
 private launch(job: Job): void {
  if (job.pumping || this.jobs.get(job.snapshot.id) !== job) return;
  job.pumping = true;
  void Promise.resolve().then(() => this.pump(job)).catch(error => {
   this.cancelRuns(job);
   this.finish(job, job.cancelled || !this.owns(job) ? "cancelled" : "failed", errorText(error));
  }).finally(() => {
   job.pumping = false;
   if (this.jobs.get(job.snapshot.id) === job && job.cancelled) this.finish(job, "cancelled", "Workflow cancelled");
   if (this.jobs.get(job.snapshot.id) === job && this.owns(job) && !job.cancelled
    && (!job.snapshot.open || job.snapshot.phases.some(phase => phase.state === "pending"))) this.launch(job);
  });
 }
 private async pump(job: Job): Promise<void> {
  for (let index = 0; index < job.snapshot.phases.length; index++) {
   this.assertOwner(job);
   const phase = job.snapshot.phases[index];
   if (phase.state === "completed") continue;
   job.snapshot.state = "running"; phase.state = "running"; this.changed(job);
   const previous = index === 0 ? "" : job.snapshot.phases[index - 1].tasks.map(task => `${task.label}:\n${task.answer ?? ""}`).join("\n\n").slice(0, L.previous);
   const waits: Promise<void>[] = [];
   let failure: unknown;
   const unsubscribe = job.registry.subscribe(info => {
    const task = phase.tasks.find(task => task.runId === info.id);
    if (task && this.owns(job)) { task.state = info.state; this.notify(); }
   });
   try {
    for (let n = 0; n < phase.tasks.length; n++) {
     this.assertOwner(job);
     const input = job.prompts[index].tasks[n], task = phase.tasks[n];
     const token = "{previous}";
     let expandedLength = input.task.length;
     for (const _match of input.task.matchAll(/\{previous\}/g)) expandedLength += previous.length - token.length;
     if (expandedLength > L.task) throw new Error(`Invalid workflow expanded task (1-${L.task} characters)`);
     const prompt = text(input.task.replaceAll(token, () => previous), "expanded task", L.task);
     const id = this.agents.start(input.agent, prompt, job.ctx, { harness: input.harness, label: task.label, workflowId: job.snapshot.id, phaseId: phase.id, signal: job.controller.signal });
     task.runId = id; task.state = "queued";
     waits.push(job.registry.wait(id).then(info => {
      task.state = info.state; task.answer = info.answer.slice(0, L.answer); task.error = info.error?.slice(0, 1000);
      if (info.state !== "completed") { failure ??= new Error(info.error || `Task ${task.label} ${info.state}`); this.cancelRuns(job); }
     }).catch(error => { task.state = "failed"; task.error = errorText(error); failure ??= new Error(errorText(error)); this.cancelRuns(job); }));
     // A synchronous queued observer may cancel before start returns its id.
     if (job.cancelled || !this.owns(job)) job.registry.cancel(id);
    }
    this.changed(job);
   } catch (error) { failure ??= new Error(errorText(error)); this.cancelRuns(job); }
   await Promise.all(waits); unsubscribe();
   this.assertOwner(job);
   if (failure !== undefined) { phase.state = "failed"; throw failure; }
   phase.state = "completed"; this.changed(job);
  }
  this.assertOwner(job);
  if (job.snapshot.open) { job.snapshot.state = "waiting"; this.changed(job); }
  else this.finish(job, "completed");
 }
 async wait(id: string, signal?: AbortSignal): Promise<WorkflowSnapshot> {
  signal?.throwIfAborted();
  const job = this.jobs.get(id);
  if (!job) return this.status(id);
  return new Promise<WorkflowSnapshot>((resolve, reject) => {
   const cleanup = () => { job.waiters.delete(complete); signal?.removeEventListener("abort", abort); };
   const complete = () => { cleanup(); resolve(displaySnapshot(job.snapshot)); };
   const abort = () => { cleanup(); reject(new Error("Stopped waiting; workflow continues")); };
   job.waiters.add(complete);
   signal?.addEventListener("abort", abort, { once: true });
   if (signal?.aborted) abort();
  });
 }
 register(): void {
  this.pi.on("session_start", (_event, ctx) => { this.restore(ctx); });
  this.pi.on("session_tree", (_event, ctx) => { this.restore(ctx); });
  this.pi.on("session_before_switch", async () => { await this.stop(); });
  this.pi.on("session_before_fork", async () => { await this.stop(); });
  this.pi.on("session_before_tree", async () => { await this.stop(); });
  this.pi.on("session_shutdown", async () => { await this.stop(); });
  const task = Type.Object({ agent: Type.String({ minLength: 1, maxLength: L.title }), task: Type.String({ minLength: 1, maxLength: L.task }),
   label: Type.Optional(Type.String({ minLength: 1, maxLength: L.title, description: "Short task-specific table label, e.g. API audit; avoid repeating the agent name." })), harness: Type.Optional(Type.Union(HARNESS_NAMES.map(name => Type.Literal(name)))) });
  const phases = Type.Array(Type.Object({ title: Type.String({ minLength: 1, maxLength: L.title }), tasks: Type.Array(task, { minItems: 1, maxItems: L.tasksPerPhase }) }), { minItems: 1, maxItems: L.phases });
  this.pi.registerTool({
   name: "workflow", label: "Workflow", exposure: "model-only",
   description: "Run sequential phases of parallel delegates. start returns an id; open=true waits for append until seal. Failures stop later phases. {previous} inserts bounded previous-phase answers. status is compact; phaseId includes that phase's results. wait abort only stops waiting; cancel stops tasks. No automatic replay after session changes.",
   promptGuidelines: ["Give each task a short, distinct label describing its work rather than repeating worker/scout names. Use phases for dependencies; writers still share the serialized writer lease."],
   parameters: Type.Object({ action: Type.Union(["start", "list", "status", "wait", "append", "seal", "cancel"].map(action => Type.Literal(action))),
    id: Type.Optional(Type.String()), title: Type.Optional(Type.String({ minLength: 1, maxLength: L.title })), phases: Type.Optional(phases),
    open: Type.Optional(Type.Boolean()), phaseId: Type.Optional(Type.String()) }),
   execute: async (_id, params, signal, _onUpdate, ctx) => {
    signal?.throwIfAborted(); this.restore(ctx);
    let result: unknown;
    if (params.action === "start") result = { id: this.start({ title: params.title!, phases: params.phases!, open: params.open }, ctx) };
    else if (params.action === "list") result = this.list().map(({ id, title, state, open, startedAt, updatedAt, finishedAt, error, phases }) => ({ id, title, state, open, startedAt, updatedAt, finishedAt, error,
     phaseCount: phases.length, taskCount: phases.reduce((sum, phase) => sum + phase.tasks.length, 0), currentPhase: phases.find(phase => phase.state === "running" || phase.state === "pending")?.title }));
    else {
     const id = text(params.id, "id", 128);
     if (params.action === "append") result = this.append(id, params.phases!, ctx);
     else if (params.action === "seal") result = this.seal(id);
     else if (params.action === "cancel") { this.cancel(id); result = this.status(id); }
     else if (params.action === "wait") result = await this.wait(id, signal);
     else result = this.status(id, params.phaseId);
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: { result } };
   },
  });
 }
}
