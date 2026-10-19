import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Workflows, WORKFLOW_LIMITS as L, type WorkflowAgents, type WorkflowPhaseInput } from "../src/workflows.ts";
import { RunRegistry, type RunControl, type RunOutcome } from "../src/acp/runs.ts";
import type { StartOptions } from "../src/acp/delegates.ts";

const phase = (title: string, ...tasks: string[]): WorkflowPhaseInput => ({ title, tasks: tasks.map(task => ({ agent: "scout", task, label: task.slice(0, 20) })) });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } throw new Error("Condition timed out"); }
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(execute: (task: string, control: RunControl) => Promise<RunOutcome> = async task => ({ answer: `answer:${task}` })) {
 let session = "one", owner = "", stopped = false;
 const entries: any[] = [], branch: any[] = [], starts: string[] = [], preflights: string[] = [];
 const tools = new Map<string, any>(), events = new Map<string, any[]>();
 const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => session, getSessionFile: () => undefined, getBranch: () => branch } } as unknown as ExtensionContext;
 const agents: WorkflowAgents & { epoch: number; runs: RunRegistry } = {
  epoch: 0, runs: new RunRegistry(),
  owns: () => owner === session && !stopped,
  restore() { if (owner === session && !stopped) return; void this.runs.stop(); this.epoch++; stopped = false; owner = session; this.runs = new RunRegistry(); },
  preflight(agent) { preflights.push(agent); if (agent === "invalid") throw new Error("Unknown agent"); },
  start(agent, task, _ctx, options: StartOptions = {}) {
   assert.ok(this.owns(ctx)); starts.push(task);
   options.signal?.throwIfAborted();
   const registry = this.runs;
   const id = registry.start({ agent, task, cwd: ctx.cwd, harness: options.harness ?? "pi", label: options.label, workflowId: options.workflowId, phaseId: options.phaseId }, control => execute(task, control));
   const abort = () => registry.cancel(id);
   options.signal?.addEventListener("abort", abort, { once: true });
   if (options.signal?.aborted) abort();
   void registry.wait(id).finally(() => options.signal?.removeEventListener("abort", abort)).catch(() => {});
   return id;
  },
 };
 const pi = { appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
  registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, callback: any) { events.set(name, [...events.get(name) ?? [], callback]); } } as unknown as ExtensionAPI;
 const workflows = new Workflows(pi, agents);
 return { workflows, agents, pi, ctx, entries, branch, starts, preflights, tools, events,
  switchSession() { session = "two"; workflows.restore(ctx); },
  async close() { await workflows.stop(); await agents.runs.stop(); } };
}

test("phase tasks run in parallel, barrier waits for all, previous is bounded and snapshots contain no prompts", async () => {
 const a = gate(), b = gate();
 const f = fixture(async task => { if (task === "a") await a.promise; if (task === "b") await b.promise; return { answer: "$&" + task + "x".repeat(6000) }; });
 try {
  const id = f.workflows.start({ title: "Pipeline", phases: [phase("Read", "a", "b"), phase("Write", "Use {previous}")] }, f.ctx);
  assert.deepEqual(f.preflights, ["scout", "scout", "scout"]);
  await until(() => f.starts.length === 2);
  a.resolve(); await tick(); assert.equal(f.starts.length, 2);
  b.resolve(); const result = await f.workflows.wait(id);
  assert.equal(result.state, "completed"); assert.equal(f.starts.length, 3);
  assert.ok(f.starts[2].includes("$&a")); assert.ok(f.starts[2].length < L.previous + 10);
  assert.ok(result.phases.every(phase => phase.state === "completed"));
  assert.ok(!JSON.stringify(f.workflows.list()).includes('"answer"'));
  assert.ok(!JSON.stringify(f.entries).includes('"task":'));
  const first = result.phases[0];
  assert.equal(f.workflows.status(id, first.id).phases[0].tasks[0].answer?.length, L.answer);
  const run = f.agents.runs.get(first.tasks[0].runId!)!;
  assert.equal(run.workflowId, id); assert.equal(run.phaseId, first.id); assert.equal(run.label, "a");
  assert.equal(f.agents.runs.overview()[0].workflowId, id);
  assert.throws(() => f.agents.runs.submit(run.id, async () => ({})), /Workflow tasks/);
  result.phases[0].title = "tamper"; assert.equal(f.workflows.get(id)?.phases[0].title, "Read");
 } finally { a.resolve(); b.resolve(); await f.close(); }
});

test("all supplied tasks preflight before any starts, including appended batches", async () => {
 const f = fixture();
 try {
  const invalid = phase("bad", "x"); invalid.tasks[0].agent = "invalid";
  assert.throws(() => f.workflows.start({ title: "Bad", phases: [phase("good", "x"), invalid] }, f.ctx), /Unknown agent/);
  await tick(); assert.equal(f.starts.length, 0);
  const id = f.workflows.start({ title: "Open", phases: [phase("first", "x")], open: true }, f.ctx);
  await until(() => f.workflows.get(id)?.state === "waiting");
  assert.throws(() => f.workflows.append(id, [phase("good", "y"), invalid], f.ctx), /Unknown agent/);
  assert.equal(f.workflows.get(id)?.phases.length, 1); assert.equal(f.starts.length, 1);
  f.workflows.seal(id); assert.equal((await f.workflows.wait(id)).state, "completed");
 } finally { await f.close(); }
});

test("open workflows append while running or waiting; aborted wait never cancels tasks", async () => {
 const hold = gate(), f = fixture(async task => { if (task === "hold") await hold.promise; return { answer: task }; });
 try {
  const id = f.workflows.start({ title: "Dynamic", phases: [phase("one", "hold")], open: true }, f.ctx);
  f.workflows.append(id, [phase("two", "next")], f.ctx);
  const abort = new AbortController(), waiting = f.workflows.wait(id, abort.signal);
  abort.abort(); await assert.rejects(waiting, /Stopped waiting/);
  assert.equal(f.workflows.get(id)?.state, "running");
  hold.resolve(); await until(() => f.workflows.get(id)?.state === "waiting");
  assert.deepEqual(f.starts, ["hold", "next"]);
  f.workflows.append(id, [phase("three", "last")], f.ctx); f.workflows.seal(id);
  assert.equal((await f.workflows.wait(id)).state, "completed");
  assert.equal(f.workflows.get(id)?.phases.length, 3);
  assert.throws(() => f.workflows.append(id, [phase("no", "x")], f.ctx), /terminal/);
 } finally { hold.resolve(); await f.close(); }
});

test("failure cancels siblings, retains results and never starts later phases", async () => {
 let cancelled = false;
 const f = fixture(async (task, control) => {
  if (task === "fail") return { error: "broken" };
  await new Promise<void>(resolve => control.signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
  return {};
 });
 try {
  const id = f.workflows.start({ title: "Failure", phases: [phase("one", "fail", "hang"), phase("two", "never")] }, f.ctx);
  const result = await f.workflows.wait(id);
  assert.equal(result.state, "failed"); assert.equal(result.error, "broken"); assert.ok(cancelled);
  assert.deepEqual(f.starts, ["fail", "hang"]);
  assert.deepEqual(result.phases.map(phase => phase.state), ["failed", "cancelled"]);
  assert.equal(result.phases[0].tasks[1].state, "cancelled");
 } finally { await f.close(); }
});

test("global four-run scheduler is shared with delegates and cancel stops running and queued tasks", async () => {
 let active = 0, peak = 0;
 const f = fixture(async (_task, control) => {
  peak = Math.max(peak, ++active);
  await new Promise<void>(resolve => control.signal.addEventListener("abort", () => resolve(), { once: true }));
  active--; return {};
 });
 try {
  const id = f.workflows.start({ title: "Many", phases: [phase("one", ...Array.from({ length: 8 }, (_, i) => `task${i}`))] }, f.ctx);
  await until(() => active === 4);
  assert.equal(peak, 4); f.workflows.cancel(id);
  assert.equal((await f.workflows.wait(id)).state, "cancelled"); assert.equal(active, 0);
  assert.ok(f.agents.runs.list().every(run => run.state === "cancelled"));
  const idle = f.workflows.start({ title: "Idle", phases: [phase("first", "x")], open: true }, f.ctx);
  f.workflows.cancel(idle); assert.equal((await f.workflows.wait(idle)).state, "cancelled");
 } finally { await f.close(); }
});

test("session change cancels old runs, prevents old launches/persistence, and restores without replay", async () => {
 const f = fixture(async (_task, control) => {
  await new Promise<void>(resolve => control.signal.addEventListener("abort", () => resolve(), { once: true })); return {};
 });
 try {
  const id = f.workflows.start({ title: "Old", phases: [phase("one", "hang"), phase("two", "never")], open: true }, f.ctx);
  await until(() => f.starts.length === 1);
  const oldRegistry = f.agents.runs, saved = f.entries.filter(entry => entry.customType === "hempi.workflow").at(-1)!;
  f.branch.push(saved); const writes = f.entries.length; f.switchSession();
  await tick(); await oldRegistry.stop();
  assert.equal(f.entries.length, writes); assert.deepEqual(f.starts, ["hang"]);
  assert.equal(f.workflows.get(id)?.state, "interrupted");
  assert.equal((await f.workflows.wait(id)).state, "interrupted");
  assert.throws(() => f.workflows.append(id, [phase("new", "x")], f.ctx), /terminal/);
  assert.ok(oldRegistry.list().every(run => run.state === "cancelled"));
 } finally { await f.close(); }
});

test("direct API validates bounds; live and terminal retention are bounded", async () => {
 const f = fixture();
 try {
  const valid = { title: "valid", phases: [phase("one", "x")] };
  for (const input of [null, {}, { ...valid, title: " " }, { ...valid, title: "x".repeat(121) }, { ...valid, open: "true" },
   { ...valid, phases: [] }, { ...valid, phases: Array(17).fill(phase("x", "x")) },
   { ...valid, phases: [phase("x", ...Array(9).fill("x"))] }, { ...valid, phases: Array(9).fill(phase("x", ...Array(8).fill("x"))) },
   { ...valid, phases: [phase("x", "x".repeat(L.task + 1))] },
   { ...valid, phases: [{ title: "bad", tasks: [{ agent: "scout", task: "x", harness: "unsafe" }] }] }]) {
   assert.throws(() => f.workflows.start(input as any, f.ctx), /workflow|Workflow/);
  }
  const ids = Array.from({ length: L.live }, () => f.workflows.start({ ...valid, open: true }, f.ctx));
  assert.throws(() => f.workflows.start(valid, f.ctx), /Too many live/);
  for (const id of ids) f.workflows.cancel(id);
  await Promise.all(ids.map(id => f.workflows.wait(id)));
  for (let i = 0; i < L.history + 2; i++) await f.workflows.wait(f.workflows.start(valid, f.ctx));
  assert.equal(f.workflows.list().length, L.history);
  const saved = f.entries.filter(entry => entry.customType === "hempi.workflow").at(-1)!;
  f.branch.push(saved, { ...saved, data: { ...saved.data, id: "corrupt", phases: [{ title: "bad" }] } });
  f.switchSession(); assert.equal(f.workflows.list().length, 1);
  assert.equal(f.workflows.list()[0].state, "completed");
 } finally { await f.close(); }
});

test("subscription can append and seal at the waiting boundary, unsubscribe is effective", async () => {
 const f = fixture(); let notifications = 0, appended = false;
 try {
  const unsubscribe = f.workflows.subscribe(() => {
   notifications++;
   const snapshot = f.workflows.list()[0];
   if (snapshot?.state === "waiting" && !appended) {
    appended = true; f.workflows.append(snapshot.id, [phase("second", "y")], f.ctx); f.workflows.seal(snapshot.id);
   }
  });
  const id = f.workflows.start({ title: "Observed", phases: [phase("first", "x")], open: true }, f.ctx);
  assert.equal((await f.workflows.wait(id)).state, "completed"); assert.deepEqual(f.starts, ["x", "y"]);
  unsubscribe(); const count = notifications;
  await f.workflows.wait(f.workflows.start({ title: "Quiet", phases: [phase("one", "z")] }, f.ctx));
  assert.equal(notifications, count);
 } finally { await f.close(); }
});

test("registered tool supports all actions and lifecycle stops an open workflow", async () => {
 const f = fixture(); f.workflows.register();
 const call = async (params: any, signal?: AbortSignal) => (await f.tools.get("workflow").execute("tool", params, signal, undefined, f.ctx)).details.result;
 try {
  const { id } = await call({ action: "start", title: "Tool", phases: [phase("one", "x")], open: true });
  await until(() => f.workflows.get(id)?.state === "waiting");
  assert.equal((await call({ action: "list" }))[0].id, id);
  assert.equal((await call({ action: "status", id })).state, "waiting");
  await call({ action: "append", id, phases: [phase("two", "y")] }); await call({ action: "seal", id });
  assert.equal((await call({ action: "wait", id })).state, "completed");
  await call({ action: "cancel", id });
  const other = await call({ action: "start", title: "Stop", phases: [phase("one", "z")], open: true });
  await Promise.all(f.events.get("session_shutdown")!.map(callback => callback()));
  assert.equal(f.workflows.get(other.id)?.state, "cancelled");
 } finally { await f.close(); }
});

test("partial launch failure cancels started siblings and persistence failure cannot report success", async () => {
 const f = fixture(async (_task, control) => {
  if (!control.signal.aborted) await new Promise<void>(resolve => control.signal.addEventListener("abort", () => resolve(), { once: true })); return {};
 });
 try {
  const original = f.agents.start;
  f.agents.start = (...args) => { if (args[1] === "bad") throw new Error("Launch failed"); return original.apply(f.agents, args); };
  const id = f.workflows.start({ title: "Partial", phases: [phase("one", "hang", "bad"), phase("two", "never")] }, f.ctx);
  assert.equal((await f.workflows.wait(id)).state, "failed");
  assert.equal(f.agents.runs.list()[0].state, "cancelled"); assert.deepEqual(f.starts, ["hang"]);
  f.pi.appendEntry = () => { throw new Error("Disk full"); };
  assert.throws(() => f.workflows.start({ title: "Disk", phases: [phase("one", "x")] }, f.ctx), /Disk full/);
  assert.equal(f.workflows.list().length, 1); assert.deepEqual(f.starts, ["hang"]);
 } finally { await f.close(); }
 const g = fixture();
 try {
  const append = g.pi.appendEntry;
  g.pi.appendEntry = (type, data) => {
   if (type === "hempi.workflow" && (data as any).state === "completed") throw new Error("Terminal write failed");
   return append(type, data);
  };
  const id = g.workflows.start({ title: "Disk", phases: [phase("one", "x")] }, g.ctx);
  assert.equal((await g.workflows.wait(id)).state, "failed");
  assert.match(g.workflows.get(id)?.error ?? "", /Terminal write failed/);
 } finally { await g.close(); }
});

test("failed append checkpoint preserves running phase and task identities", async () => {
 let executing = false;
 const hold = gate(), f = fixture(async () => { executing = true; await hold.promise; return { answer: "written" }; });
 try {
  const id = f.workflows.start({ title: "Writer", phases: [phase("one", "write")], open: true }, f.ctx);
  await until(() => executing);
  const before = f.workflows.get(id)!, append = f.pi.appendEntry;
  f.pi.appendEntry = () => { throw new Error("Append checkpoint failed"); };
  assert.throws(() => f.workflows.append(id, [phase("rejected", "never")], f.ctx), /Append checkpoint failed/);
  assert.equal(f.workflows.get(id)?.updatedAt, before.updatedAt);
  assert.equal(f.workflows.get(id)?.phases.length, 1);
  f.pi.appendEntry = append;
  hold.resolve(); await until(() => f.workflows.get(id)?.state === "waiting");
  f.workflows.seal(id);
  const result = await f.workflows.wait(id);
  assert.equal(result.state, "completed"); assert.deepEqual(f.starts, ["write"]);
  assert.equal(f.workflows.status(id, result.phases[0].id).phases[0].tasks[0].answer, "written");
 } finally { hold.resolve(); await f.close(); }
});

test("cancel from a synchronous queued observer cancels the just-created run before execution", async () => {
 let executions = 0;
 const f = fixture(async () => { executions++; return {}; });
 try {
  f.workflows.restore(f.ctx);
  const unsubscribe = f.agents.runs.subscribe(info => {
   if (info.state === "queued") f.workflows.cancel(info.workflowId!);
  });
  const id = f.workflows.start({ title: "Cancel", phases: [phase("one", "never")] }, f.ctx);
  const result = await f.workflows.wait(id);
  unsubscribe();
  assert.equal(result.state, "cancelled"); assert.equal(executions, 0);
  assert.deepEqual(f.starts, ["never"]);
  assert.equal(result.phases[0].tasks[0].state, "cancelled");
  assert.ok(f.agents.runs.list().every(run => run.state === "cancelled"));
 } finally { await f.close(); }
});

test("previous expansion checks length before replacement and inserts dollar signs literally", async t => {
 const replace = t.mock.method(String.prototype, "replaceAll");
 const f = fixture(async () => ({ answer: "$&$`$'$" + "x".repeat(L.answer) }));
 try {
  const first = phase("outputs", ...Array.from({ length: L.tasksPerPhase }, (_, i) => `source${i}`));
  const oversized = "{previous}".repeat(Math.floor(L.task / "{previous}".length));
  const id = f.workflows.start({ title: "Bounded", phases: [first, phase("oversized", oversized)] }, f.ctx);
  assert.equal((await f.workflows.wait(id)).state, "failed");
  assert.match(f.workflows.get(id)?.error ?? "", /expanded task/);
  assert.equal(f.starts.length, L.tasksPerPhase);
  assert.equal(replace.mock.callCount(), L.tasksPerPhase);
  const literal = f.workflows.start({ title: "Literal", phases: [first, phase("valid", "{previous}".repeat(7))] }, f.ctx);
  const result = await f.workflows.wait(literal);
  assert.equal(result.state, "completed");
  const previous = f.workflows.status(literal, result.phases[0].id).phases[0].tasks
   .map(task => `${task.label}:\n${task.answer ?? ""}`).join("\n\n").slice(0, L.previous);
  assert.equal(previous.length, L.previous);
  assert.equal(f.starts.at(-1), previous.repeat(7));
 } finally { replace.mock.restore(); await f.close(); }
});

test("blank task errors restore as failed workflows instead of being discarded", async () => {
 for (const error of ["", "   "]) {
  const f = fixture(async () => ({ error }));
  try {
   const id = f.workflows.start({ title: "Failure", phases: [phase("one", "fail")] }, f.ctx);
   const result = await f.workflows.wait(id);
   assert.equal(result.state, "failed");
   const saved = f.entries.at(-1)!;
   f.branch.push(saved); f.switchSession();
   assert.equal(f.workflows.get(id)?.state, "failed");
   assert.equal(f.workflows.status(id, result.phases[0].id).phases[0].tasks[0].error, error);
   // Workflow-level errors follow the same bounded-string contract.
   f.branch.splice(0, 1, { ...saved, data: { ...saved.data, error } });
   await f.workflows.stop(); f.workflows.restore(f.ctx);
   assert.equal(f.workflows.get(id)?.error, error);
  } finally { await f.close(); }
 }
});

test("aborted waits are removable and completion returns independent snapshots", async () => {
 const hold = gate(), f = fixture(async () => { await hold.promise; return {}; });
 try {
  const id = f.workflows.start({ title: "Waiters", phases: [phase("one", "hold")], open: true }, f.ctx);
  await until(() => f.starts.length === 1);
  const job = (f.workflows as any).jobs.get(id);
  for (const state of ["running", "waiting"]) {
   for (let i = 0; i < 100; i++) {
    const controller = new AbortController();
    const waiting = f.workflows.wait(id, controller.signal);
    assert.equal(job.waiters.size, 1);
    controller.abort(); await assert.rejects(waiting, /Stopped waiting/);
    assert.equal(job.waiters.size, 0);
   }
   assert.equal(f.workflows.get(id)?.state, state);
   hold.resolve(); await until(() => f.workflows.get(id)?.state === "waiting");
  }
  const a = f.workflows.wait(id), b = f.workflows.wait(id);
  assert.equal(job.waiters.size, 2);
  f.workflows.seal(id);
  const [one, two] = await Promise.all([a, b]);
  assert.equal(job.waiters.size, 0); assert.equal(one.state, "completed");
  one.phases[0].tasks[0].label = "tampered";
  assert.equal(two.phases[0].tasks[0].label, "hold");
  const terminal = await f.workflows.wait(id);
  terminal.phases[0].title = "tampered";
  assert.equal((await f.workflows.wait(id)).phases[0].title, "one");
 } finally { hold.resolve(); await f.close(); }
});

test("run metadata restores safely and appears in overview", async () => {
 const registry = new RunRegistry();
 const input = { agent: "scout", task: "x", cwd: "/tmp", harness: "pi", label: "Short label", workflowId: "workflow-1", phaseId: "phase-1" };
 const record = await registry.wait(registry.start(input, async () => ({})));
 const restored = new RunRegistry(); restored.restore([record]);
 assert.equal(restored.overview()[0].label, input.label);
 assert.equal(restored.get(record.id)?.phaseId, input.phaseId);
 for (const patch of [{ label: "x".repeat(121) }, { workflowId: "../bad" }, { phaseId: 12 }]) {
  assert.throws(() => new RunRegistry().restore([{ ...record, ...patch }]), /Invalid run/);
 }
 await registry.stop(); await restored.stop();
});
