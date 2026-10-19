import assert from "node:assert/strict";
import { test } from "node:test";
import { RunRegistry, type RunControl, type RunInfo } from "../src/acp/runs.ts";

const input = { agent: "test", harness: "native", cwd: "/tmp", task: "task" };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => queueMicrotask(resolve));

test("live metrics are validated, transient, reset per turn, and frozen at termination", async () => {
  const saved: RunInfo[] = [], seen: RunInfo[] = [];
  const registry = new RunRegistry(info => { saved.push(info); });
  registry.subscribe(info => { seen.push(info); });
  const gate = deferred();
  let control!: RunControl;
  const id = registry.start({ ...input, task: "\n  First line  \nsecond" }, async current => {
    control = current;
    current.setState("running");
    const runningAt = registry.get(id)!.runningAt;
    current.setState("awaiting_approval"); current.setState("running");
    assert.equal(registry.get(id)!.runningAt, runningAt);
    const writes = saved.length;
    current.report({ reportedTokens: 12, contextTokens: 50 });
    assert.equal(saved.length, writes);
    for (const invalid of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      assert.throws(() => current.report({ reportedTokens: invalid }), /Invalid/);
    }
    assert.equal(registry.get(id)?.reportedTokens, 12);
    await gate.promise;
    return {};
  });
  await turn();
  assert.equal(seen.at(-1)?.reportedTokens, 12);
  assert.equal(registry.overview()[0].title, "First line");
  assert.equal(registry.get(id)?.finishedAt, undefined);
  registry.cancel(id); control.report({ reportedTokens: 100 }); gate.resolve();
  const done = await registry.wait(id);
  assert.equal(done.reportedTokens, 12);
  assert.ok(done.finishedAt! >= done.runningAt!);
  control.report({ reportedTokens: 200 });
  assert.deepEqual(registry.get(id), done);
  registry.submit(id, async () => ({}));
  assert.equal(registry.get(id)?.reportedTokens, undefined);
  assert.equal(registry.get(id)?.contextTokens, undefined);
  assert.equal(registry.get(id)?.runningAt, undefined);
  assert.equal(registry.get(id)?.finishedAt, undefined);
  await registry.wait(id); await registry.stop();
});

test("optional restored metrics validate and interrupted elapsed freezes at last activity", async () => {
  const registry = new RunRegistry();
  const record = { ...input, id: "legacy", state: "completed", answer: "", progress: "", startedAt: 1, updatedAt: 20,
    harness: "pi", usage: { totalTokens: 42 } };
  registry.restore([record, { ...record, id: "active", state: "running", runningAt: 5, reportedTokens: 9, contextTokens: 30 }]);
  assert.equal(registry.overview()[0].reportedTokens, 42);
  assert.equal(registry.get("legacy")?.reportedTokens, undefined);
  assert.equal(registry.get("active")?.finishedAt, 20);
  assert.equal(registry.get("active")?.reportedTokens, 9);
  for (const key of ["reportedTokens", "contextTokens", "runningAt", "finishedAt"]) {
    assert.throws(() => registry.restore([{ ...record, id: key, [key]: -1 }]), /Invalid/);
  }
  registry.restore([{ ...record, id: "unknown", usage: undefined }]);
  assert.equal(registry.overview().at(-1)?.reportedTokens, undefined);
  await registry.stop();
});

test("global concurrency is four; queued cancellation settles without execution", async () => {
  const registry = new RunRegistry();
  const gate = deferred();
  let active = 0, peak = 0, calls = 0;
  const ids = Array.from({ length: 7 }, (_, i) => registry.start({ ...input, harness: i % 2 ? "external" : "native" }, async () => {
    calls++; peak = Math.max(peak, ++active);
    await gate.promise; active--;
    return { answer: "done" };
  }));
  await turn();
  assert.equal(calls, 4);
  registry.cancel(ids[4]);
  assert.equal((await registry.wait(ids[4])).state, "cancelled");
  assert.equal(calls, 4);
  gate.resolve();
  await Promise.all(ids.map(id => registry.wait(id)));
  assert.equal(calls, 6);
  assert.equal(peak, 4);
  await registry.stop();
});

test("cancelled queued followup cannot steal a resubmitted job or its promise", async () => {
  const registry = new RunRegistry();
  const id = registry.start(input, async () => ({ answer: "old", usage: { tokens: 7 } }));
  await registry.wait(id);
  const gate = deferred();
  const blockers = Array.from({ length: 4 }, () => registry.start(input, async () => { await gate.promise; return {}; }));
  await turn();
  let stale = 0, fresh = 0;
  registry.submit(id, async () => { stale++; return {}; });
  const cancelled = registry.wait(id);
  assert.equal(registry.get(id)?.usage, undefined);
  registry.cancel(id);
  registry.submit(id, async () => { fresh++; return { answer: "new" }; });
  const replacement = registry.wait(id);
  gate.resolve();
  await Promise.all(blockers.map(id => registry.wait(id)));
  assert.equal((await cancelled).state, "cancelled");
  assert.equal((await replacement).answer, "new");
  assert.equal(stale, 0); assert.equal(fresh, 1);
  registry.submit(id, async () => { throw new Error("no usage"); });
  assert.equal((await registry.wait(id)).usage, undefined);
  await registry.stop();
});

test("active cancellation signals executor, preserves partial output, waits for cleanup", async () => {
  const registry = new RunRegistry();
  const started = deferred(), aborted = deferred(), cleanup = deferred();
  const id = registry.start(input, async control => {
    control.setState("awaiting_approval", { answer: "partial" });
    control.update("progress");
    control.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    await aborted.promise;
    await cleanup.promise;
    return { error: "backend cancelled" };
  });
  await started.promise;
  const waiting = registry.wait(id);
  const stopping = registry.stop();
  assert.equal(registry.stop(), stopping);
  await aborted.promise;
  assert.throws(() => registry.submit(id, async () => ({})), /stopped/);
  let settled = false;
  void waiting.then(() => { settled = true; });
  await turn(); assert.equal(settled, false);
  cleanup.resolve();
  const result = await waiting;
  await stopping;
  assert.equal(result.state, "cancelled");
  assert.equal(result.answer, "partial");
  assert.equal(result.progress, "progress");
  assert.equal(result.error, "backend cancelled");
  assert.throws(() => registry.start(input, async () => ({})), /stopped/);
});

test("outcomes, empty answer, thrown failures, and explicit abort are distinct", async () => {
  const registry = new RunRegistry();
  const success = registry.start(input, async () => ({ answer: "yes", sessionId: "s", usage: { tokens: 2 } }));
  assert.equal((await registry.wait(success)).answer, "yes");
  assert.equal(registry.get(success)?.state, "completed");
  const empty = registry.start(input, async () => ({}));
  assert.equal((await registry.wait(empty)).answer, "");
  const failed = registry.start(input, async () => { throw new Error("broken"); });
  assert.equal((await registry.wait(failed)).error, "broken");
  const undefinedError = registry.start(input, async () => { throw undefined; });
  assert.equal((await registry.wait(undefinedError)).state, "failed");
  const error = registry.start(input, async () => ({ error: "denied", answer: "partial" }));
  assert.equal((await registry.wait(error)).state, "failed");
  const notCancelled = registry.start(input, async () => { throw new DOMException("unrelated", "AbortError"); });
  assert.equal((await registry.wait(notCancelled)).state, "failed");
  await registry.stop();
});

test("followup uses same id, retains session, and cannot overlap or use stale controls", async () => {
  const registry = new RunRegistry();
  const gate = deferred();
  let old!: RunControl;
  const id = registry.start(input, async control => {
    old = control; await gate.promise;
    return { answer: "first", sessionId: "session", extra: { resume: "ref" } };
  });
  assert.throws(() => registry.submit(id, async () => ({})), /live/);
  gate.resolve(); await registry.wait(id);
  const followup = deferred();
  assert.equal(registry.submit(id, async () => { await followup.promise; return { answer: "second" }; }, "next"), id);
  await turn();
  old.update("stale"); old.setState("running", { answer: "stale" }); old.report({ reportedTokens: 999 });
  assert.equal(registry.get(id)?.reportedTokens, undefined);
  assert.equal(registry.get(id)?.progress, "");
  assert.equal(registry.get(id)?.task, "next");
  followup.resolve();
  const result = await registry.wait(id);
  assert.equal(result.answer, "second");
  assert.equal(result.sessionId, "session");
  assert.deepEqual(result.extra, { resume: "ref" });
  registry.cancel(id);
  assert.equal(registry.get(id)?.state, "completed");
  await registry.stop();
});

test("callbacks and public snapshots cannot mutate records; text is bounded and not persisted", async () => {
  const saved: RunInfo[] = [];
  const registry = new RunRegistry(info => { saved.push(structuredClone(info)); info.answer = "tampered"; });
  registry.subscribe(info => { info.answer = "observer"; throw new Error("ignored"); });
  registry.subscribe(async () => { throw new Error("async observer ignored"); });
  const id = registry.start({ ...input, extra: { ref: 1 } }, async control => {
    control.setState("running", { answer: "partial" });
    control.update("x".repeat(5000));
    return { answer: "final" };
  });
  const result = await registry.wait(id);
  assert.equal(result.answer, "final");
  assert.equal(result.progress.length, 4000);
  assert.deepEqual(saved.map(info => info.state), ["queued", "starting", "running", "completed"]);
  result.answer = "mutated";
  const snapshot = registry.list();
  (snapshot[0].extra as { ref: number }).ref = 99;
  registry.get(id)!.answer = "mutated";
  assert.equal(registry.get(id)?.answer, "final");
  assert.deepEqual(registry.get(id)?.extra, { ref: 1 });
  await registry.stop();
});

test("restore validates records, strips unknown properties, and interrupts only live states", async () => {
  const source = new RunRegistry();
  const id = source.start(input, async () => ({ answer: "saved", sessionId: "s" }));
  const record = await source.wait(id);
  const registry = new RunRegistry();
  const records = ["queued", "starting", "running", "awaiting_approval", "completed", "failed", "cancelled", "interrupted"].map((state, i) => ({
    ...record, id: String(i), state,
  }));
  registry.restore(records);
  assert.deepEqual(registry.list().map(info => info.state), ["interrupted", "interrupted", "interrupted", "interrupted", "completed", "failed", "cancelled", "interrupted"]);
  assert.equal((await registry.wait("0")).answer, "saved");
  assert.throws(() => registry.restore([{ ...record, state: "bogus" }]), /Invalid/);
  for (const unsafe of ["../outside", "a/b", "a\\b", "", "a".repeat(129)]) assert.throws(() => registry.restore([{ ...record, id: unsafe }]), /Invalid/);
  const overview = registry.overview();
  assert.ok(overview.every(row => !("answer" in row) && !("extra" in row)));
  overview[0].agent = "mutated"; assert.notEqual(registry.get("0")!.agent, "mutated");
  assert.throws(() => registry.restore([{ ...record, startedAt: NaN }]), /Invalid/);
  assert.throws(() => registry.restore([Object.create(record)]), /Invalid/);
  assert.throws(() => registry.restore([records[0]]), /Invalid/);
  registry.restore([JSON.parse(JSON.stringify({ ...record, id: "safe" }).replace('"id":"safe"', '"__proto__":{"polluted":true},"id":"safe"'))]);
  assert.equal(Object.hasOwn(registry.get("safe")!, "__proto__"), false);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  await source.stop(); await registry.stop();
});

test("cancellation before execution and during starting notification never invokes executor", async () => {
  const registry = new RunRegistry();
  let calls = 0;
  const execute = async () => { calls++; return {}; };
  const queued = registry.start(input, execute);
  registry.cancel(queued);
  assert.equal((await registry.wait(queued)).state, "cancelled");
  registry.subscribe(info => { if (info.state === "starting") registry.cancel(info.id); });
  const starting = registry.start(input, execute);
  assert.equal((await registry.wait(starting)).state, "cancelled");
  assert.equal(calls, 0);
  await registry.stop();
});

test("persistence failures reject operations, including async callbacks", async () => {
  const startup = new RunRegistry(() => { throw new Error("disk full"); });
  assert.throws(() => startup.start(input, async () => ({})), /disk full/);
  assert.equal(startup.list().length, 0);
  const registry = new RunRegistry(info => { if (info.state === "completed") throw new Error("write failed"); });
  const id = registry.start(input, async () => ({ answer: "not persisted" }));
  await assert.rejects(registry.wait(id), /write failed/);
  assert.equal(registry.get(id)?.state, "failed");
  const transition = new RunRegistry(info => { if (info.state === "running") throw new Error("transition failed"); });
  const changed = transition.start(input, async control => {
    try { control.setState("running"); } catch { /* Executor cannot hide lost persistence. */ }
    return {};
  });
  await assert.rejects(transition.wait(changed), /transition failed/);
  const asynchronous = new RunRegistry(async () => { throw new Error("async failure"); });
  assert.throws(() => asynchronous.start(input, async () => ({})), /synchronous/);
  await registry.stop(); await transition.stop(); await asynchronous.stop(); await startup.stop();
});

test("retention never evicts live runs and evicts the oldest terminal record", async () => {
  const registry = new RunRegistry();
  let calls = 0;
  const ids = Array.from({ length: 200 }, () => registry.start(input, async () => { calls++; return {}; }));
  assert.throws(() => registry.start(input, async () => ({})), /full/);
  assert.equal(registry.list().length, 200);
  registry.cancel(ids[100]);
  const replacement = registry.start(input, async () => ({}));
  assert.equal(registry.get(ids[100]), undefined);
  assert.ok(registry.get(ids[0]));
  await registry.stop();
  assert.equal(calls, 0);
  assert.equal((await registry.wait(replacement)).state, "cancelled");

  const evicted: string[] = [];
  const ordered = new RunRegistry(() => {}, id => evicted.push(id));
  const template = registry.get(replacement)!;
  ordered.restore(Array.from({ length: 200 }, (_, i) => ({ ...template, id: String(i), updatedAt: 200 - i })));
  const next = ordered.start(input, async () => ({}));
  assert.equal(ordered.get("199"), undefined);
  assert.deepEqual(evicted, ["199"]);
  assert.ok(ordered.get("0"));
  await ordered.wait(next); await ordered.stop();
});
