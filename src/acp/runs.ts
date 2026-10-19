import { randomUUID } from "node:crypto";

export type RunState = "queued" | "starting" | "running" | "awaiting_approval" | "completed" | "cancelled" | "failed" | "interrupted";
export interface RunInfo {
  id: string; agent: string; harness: string; cwd: string; task: string; state: RunState;
  startedAt: number; updatedAt: number; sessionId?: string; model?: string; file?: string;
  label?: string; workflowId?: string; phaseId?: string;
  answer: string; error?: string; usage?: unknown; progress: string;
  reportedTokens?: number; contextTokens?: number; runningAt?: number; finishedAt?: number;
  /** Backend-owned, structured-cloneable resume metadata. Never put secrets here. */
  extra?: unknown;
}
export type RunInput = Pick<RunInfo, "agent" | "harness" | "cwd" | "task"> & Partial<Pick<RunInfo, "sessionId" | "model" | "file" | "extra" | "label" | "workflowId" | "phaseId">>;
export type RunOutcome = Partial<Pick<RunInfo, "answer" | "error" | "usage" | "sessionId" | "model" | "file" | "extra">>;
export interface RunControl {
  signal: AbortSignal;
  setState(state: RunState, patch?: RunOutcome): void;
  update(text: string): void;
  report(metrics: Partial<Pick<RunInfo, "reportedTokens" | "contextTokens">>): void;
}
type Execute = (control: RunControl) => Promise<RunOutcome>;
type Job = { id: string; execute: Execute; controller: AbortController; done: Promise<RunInfo>;
  resolve: (info: RunInfo) => void; reject: (error: unknown) => void };
const validMetric = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const live = (state: RunState) => ["queued", "starting", "running", "awaiting_approval"].includes(state);
const states: RunState[] = ["queued", "starting", "running", "awaiting_approval", "completed", "cancelled", "failed", "interrupted"];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const patchFields = ["answer", "error", "usage", "sessionId", "model", "file", "extra"] as const;

export class RunRegistry {
  private records = new Map<string, RunInfo>();
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private listeners = new Set<(info: RunInfo) => void>();
  private active = 0;
  private stopped = false;
  private stopping?: Promise<void>;
  private readonly persist: (info: RunInfo) => void;
  /** Must be synchronous; throw to reject a transition that could not be persisted. */
  private readonly onEvict: (id: string) => void;
  constructor(persist: (info: RunInfo) => void = () => {}, onEvict: (id: string) => void = () => {}) {
    this.persist = persist; this.onEvict = onEvict;
  }

  subscribe(listener: (info: RunInfo) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  list(): readonly RunInfo[] { return structuredClone([...this.records.values()]); }
  overview() {
    return [...this.records.values()].map(info => {
      const { id, agent, harness, state, model, startedAt, updatedAt, file, runningAt, finishedAt, contextTokens, label, workflowId, phaseId } = info;
      const legacy = harness === "pi" && state === "completed" ? (info.usage as { totalTokens?: unknown } | undefined)?.totalTokens : undefined;
      const reportedTokens = info.reportedTokens ?? (validMetric(legacy) ? legacy : undefined);
      const title = info.task.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 240) ?? "";
      return { id, agent, harness, state, model, startedAt, updatedAt, file, title, runningAt, finishedAt, reportedTokens, contextTokens, label, workflowId, phaseId };
    });
  }
  get(id: string): RunInfo | undefined { return structuredClone(this.records.get(id)); }
  private require(id: string): RunInfo {
    const info = this.records.get(id);
    if (!info) throw new Error(`Unknown run: ${id}`);
    return info;
  }
  private notify(info: RunInfo): void {
    for (const listener of this.listeners) {
      try {
        const result: unknown = listener(structuredClone(info));
        void Promise.resolve(result).catch(() => {});
      } catch { /* Observers cannot break execution. */ }
    }
  }
  private commit(info: RunInfo): void {
    const result: unknown = this.persist(structuredClone(info));
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => {});
      throw new Error("Run persistence callback must be synchronous");
    }
    this.records.set(info.id, info);
    this.notify(info);
  }
  private room(): void {
    if (this.records.size < 200) return;
    const oldest = [...this.records.values()].filter(r => !live(r.state) && !this.jobs.has(r.id))
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!oldest) throw new Error("Run registry is full of live runs");
    this.records.delete(oldest.id);
    this.onEvict(oldest.id);
  }
  start(input: RunInput, execute: Execute): string {
    if (this.stopped) throw new Error("Run registry is stopped");
    this.room();
    const now = Date.now();
    const info: RunInfo = { ...structuredClone(input), id: randomUUID(), state: "queued",
      startedAt: now, updatedAt: now, answer: "", progress: "" };
    return this.schedule(info, execute);
  }
  submit(id: string, execute: Execute, task?: string): string {
    if (this.stopped) throw new Error("Run registry is stopped");
    const previous = this.require(id);
    if (previous.workflowId) throw new Error("Workflow tasks cannot be followed up; start a new run");
    if (live(previous.state) || this.jobs.has(id)) throw new Error("Run is already live");
    return this.schedule({ ...previous, task: task ?? previous.task, state: "queued", answer: "",
      error: undefined, usage: undefined, progress: "", reportedTokens: undefined, contextTokens: undefined,
      runningAt: undefined, finishedAt: undefined, startedAt: Date.now(), updatedAt: Date.now() }, execute);
  }
  private schedule(info: RunInfo, execute: Execute): string {
    let resolve!: Job["resolve"], reject!: Job["reject"];
    const done = new Promise<RunInfo>((yes, no) => { resolve = yes; reject = no; });
    void done.catch(() => {});
    const job = { id: info.id, execute, controller: new AbortController(), done, resolve, reject };
    this.jobs.set(info.id, job);
    try { this.commit(info); } catch (error) { this.jobs.delete(info.id); reject(error); throw error; }
    if (this.jobs.get(info.id) === job) this.queue.push(job);
    queueMicrotask(() => this.pump());
    return info.id;
  }
  wait(id: string): Promise<RunInfo> {
    const job = this.jobs.get(id);
    return job ? job.done.then(info => structuredClone(info)) : Promise.resolve(this.get(id) ?? this.require(id));
  }
  cancel(id: string): void {
    const info = this.require(id), job = this.jobs.get(id);
    if (!job || !live(info.state) || job.controller.signal.aborted) return;
    job.controller.abort(new Error("Run cancelled"));
    if (info.state === "queued") this.finish(job, "cancelled", { error: "Run cancelled" });
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    const jobs = [...this.jobs.values()];
    // Install the promise before cancellation invokes user signal listeners.
    this.stopping = Promise.allSettled(jobs.map(job => job.done)).then(results => {
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    for (const job of jobs) this.cancel(job.id);
    return this.stopping;
  }
  private finish(job: Job, state: RunState, patch: RunOutcome): void {
    if (this.jobs.get(job.id) !== job) return;
    try {
      const info = this.patched(this.require(job.id), patch);
      const now = Date.now();
      this.commit({ ...info, state, updatedAt: now, finishedAt: now });
      this.jobs.delete(job.id);
      job.resolve(this.get(job.id)!);
    } catch (error) {
      // Never report success when the durable transition failed.
      const info = this.require(job.id);
      this.records.set(job.id, { ...info, state: "failed", error: message(error), updatedAt: Date.now(), finishedAt: Date.now() });
      this.jobs.delete(job.id);
      job.reject(error);
    }
  }
  private patched(info: RunInfo, patch: RunOutcome): RunInfo {
    const next = { ...info };
    for (const key of patchFields) {
      if (Object.hasOwn(patch, key)) Object.assign(next, { [key]: structuredClone(patch[key]) });
    }
    if (typeof next.answer !== "string") next.answer = "";
    return next;
  }
  private pump(): void {
    while (this.active < 4 && this.queue.length) {
      const job = this.queue.shift()!;
      if (this.jobs.get(job.id) !== job) continue;
      this.active++;
      void this.run(job).finally(() => { this.active--; this.pump(); });
    }
  }
  private async run(job: Job): Promise<void> {
    if (this.jobs.get(job.id) !== job) return;
    const signal = job.controller.signal;
    let outcome: RunOutcome = {}, failure: unknown, failed = false;
    let persistenceError: unknown;
    const setState = (state: RunState, patch: RunOutcome = {}) => {
      if (signal.aborted || this.jobs.get(job.id) !== job) return;
      if (!["starting", "running", "awaiting_approval"].includes(state)) throw new Error("Invalid executor state");
      const info = this.patched(this.require(job.id), patch);
      try { this.commit({ ...info, state, updatedAt: Date.now(),
        ...(state === "running" && info.runningAt === undefined ? { runningAt: Date.now() } : {}) }); }
      catch (error) { persistenceError = error; throw error; }
    };
    try {
      setState("starting");
      if (!signal.aborted) outcome = await job.execute({ signal, setState, report: metrics => {
        if (signal.aborted || this.jobs.get(job.id) !== job) return;
        const patch: Partial<Pick<RunInfo, "reportedTokens" | "contextTokens">> = {};
        for (const key of ["reportedTokens", "contextTokens"] as const) {
          if (!Object.hasOwn(metrics, key)) continue;
          if (!validMetric(metrics[key])) throw new Error(`Invalid run ${key}`);
          patch[key] = metrics[key];
        }
        if (!Object.keys(patch).length) return;
        const next = { ...this.require(job.id), ...patch, updatedAt: Date.now() };
        this.records.set(job.id, next);
        this.notify(next);
      }, update: text => {
        if (signal.aborted || this.jobs.get(job.id) !== job) return;
        const info = this.require(job.id);
        const next = { ...info, progress: (info.progress + text).slice(-4000), updatedAt: Date.now() };
        this.records.set(job.id, next);
        this.notify(next);
      } });
    } catch (error) { failed = true; failure = error; }
    if (this.jobs.get(job.id) !== job) return;
    if (persistenceError) {
      this.records.set(job.id, { ...this.require(job.id), state: "failed", error: message(persistenceError), updatedAt: Date.now(), finishedAt: Date.now() });
      this.jobs.delete(job.id); job.reject(persistenceError); return;
    }
    const state = signal.aborted ? "cancelled" : failed || outcome.error !== undefined ? "failed" : "completed";
    this.finish(job, state, { ...outcome, ...(state === "completed" ? {} : {
      error: outcome.error ?? message(failed ? failure : signal.reason),
    }) });
  }
  restore(records: readonly unknown[]): void {
    if (this.stopped) throw new Error("Run registry is stopped");
    const ids = new Set(this.records.keys());
    const restored = records.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid run record");
      const record = value as Record<string, unknown>;
      const info: Record<string, unknown> = {};
      for (const key of ["id", "agent", "harness", "cwd", "task", "state", "answer", "progress"]) {
        if (!Object.hasOwn(record, key) || typeof record[key] !== "string") throw new Error(`Invalid run ${key}`);
        info[key] = record[key];
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(info.id as string) || ids.has(info.id as string) || !states.includes(info.state as RunState)) throw new Error("Invalid run id/state");
      ids.add(info.id as string);
      for (const key of ["startedAt", "updatedAt"]) {
        if (!Object.hasOwn(record, key) || typeof record[key] !== "number" || !Number.isFinite(record[key])) throw new Error(`Invalid run ${key}`);
        info[key] = record[key];
      }
      for (const key of ["reportedTokens", "contextTokens", "runningAt", "finishedAt"]) {
        if (!Object.hasOwn(record, key) || record[key] === undefined) continue;
        if (!validMetric(record[key])) throw new Error(`Invalid run ${key}`);
        info[key] = record[key];
      }
      for (const key of ["sessionId", "model", "file", "error"]) {
        if (!Object.hasOwn(record, key) || record[key] === undefined) continue;
        if (typeof record[key] !== "string") throw new Error(`Invalid run ${key}`);
        info[key] = record[key];
      }
      for (const key of ["label", "workflowId", "phaseId"] as const) {
        if (!Object.hasOwn(record, key) || record[key] === undefined) continue;
        const value = record[key];
        if (typeof value !== "string" || !value.trim() || value.length > (key === "label" ? 120 : 128)
          || (key !== "label" && !/^[A-Za-z0-9_-]+$/.test(value))) throw new Error(`Invalid run ${key}`);
        info[key] = value;
      }
      for (const key of ["extra", "usage"]) if (Object.hasOwn(record, key)) info[key] = structuredClone(record[key]);
      info.progress = (info.progress as string).slice(-4000);
      if (live(info.state as RunState)) {
        info.finishedAt = info.updatedAt;
        info.state = "interrupted"; info.updatedAt = Date.now();
      } else if (info.finishedAt === undefined) info.finishedAt = info.updatedAt;
      return info as unknown as RunInfo;
    });
    for (const info of restored) { this.room(); this.commit(info); }
  }
}
