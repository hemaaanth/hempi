import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Agents } from "../src/agents.ts";
import { registerRunUi } from "../src/acp/ui.ts";
import { RunRegistry, type RunInfo } from "../src/acp/runs.ts";

function fixture(mode = "rpc", extra?: import("../src/acp/activity-types.ts").AgentActivitySource, workflows?: import("../src/workflows.ts").Workflows) {
 const events = new Map<string, Function[]>(), messages: string[] = [], errors: string[] = [], calls: unknown[][] = [];
 const statuses = new Map<string, string | undefined>(), terminal = { rows: 20 };
 const widgets = new Map<string, any>(), entries: any[] = [], registryListeners = new Set<Function>();
 const commands = new Map<string, Function>();
 let handler: Function, active: any, renders = 0, subscribers = 0;
 const makeRegistry = () => {
  const registry = new RunRegistry(), subscribe = registry.subscribe.bind(registry);
  registry.subscribe = fn => { subscribers++; const off = subscribe(fn); let disposed = false; return () => { if (!disposed) { disposed = true; subscribers--; off(); } }; };
  return registry;
 };
 const agents = { runs: makeRegistry(), restore() {}, owns: (_ctx: unknown) => true,
  subscribeRegistry(fn: Function) { registryListeners.add(fn); return () => registryListeners.delete(fn); }, start(...args: unknown[]) { calls.push(["start", ...args]); if (args[0] === "readonly") throw new Error("backend read-only validation"); return "new-id"; },
  followup(...args: unknown[]) { calls.push(["followup", ...args]); const run = this.runs.get(args[0] as string); if (run?.state === "running") throw new Error("Run is already live"); return args[0]; } };
 const pi = { appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); }, on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); }, registerCommand(name: string, command: any) { commands.set(name, command.handler); if (name === "agent-runs") handler = command.handler; } };
 const theme = { bg: (_color: string, text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text };
 const kb = { matches: (data: string, key: string) => data === ({ "tui.select.cancel": "esc", "tui.select.confirm": "enter", "tui.select.up": "up", "tui.select.down": "down" } as Record<string, string>)[key] };
 const ctx = { mode, sessionManager: { getBranch: () => entries }, ui: {
  setWidget(key: string, factory: Function | undefined, options: unknown) {
   widgets.get(key)?.dispose?.();
   if (!factory) { widgets.delete(key); return; }
   assert.deepEqual(options, { placement: "aboveEditor" });
   widgets.set(key, factory({ mode: "fullscreen", terminal, requestRender() { renders++; } }, theme));
  },
  notify(text: string, kind: string) { messages.push(text); if (kind === "error") errors.push(text); },
  setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
  custom(factory: Function, options?: unknown) { assert.equal(options, undefined); return new Promise(resolve => {
   let component: any; const done = (value: unknown) => { component?.dispose?.(); if (active === component) active = undefined; resolve(value); };
   component = factory({ terminal, requestRender() { renders++; } }, theme, kb, done); active = component;
  }); },
 } };
 registerRunUi(pi as unknown as ExtensionAPI, agents as unknown as Agents, extra, workflows);
 const emit = async (name: string) => { for (const fn of events.get(name) ?? []) await fn({}, ctx); };
 const record = (patch: Partial<RunInfo> = {}) => agents.runs.restore([{ id: "one", agent: "worker", harness: "omp", state: "completed", cwd: "/tmp", task: "task", answer: "answer", progress: "", startedAt: 1, updatedAt: 1, ...patch }]);
 return { agents, calls, commands, messages, errors, statuses, terminal, ctx, emit, record, makeRegistry, widgets, entries, registryListeners,
  replaceRegistry() { agents.runs = makeRegistry(); for (const fn of [...registryListeners]) fn(agents.runs); }, command: (text: string) => handler(text, ctx),
  get active() { return active; }, get renders() { return renders; }, get subscribers() { return subscribers; } };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
test("workflow inspector details, explicit cancellation, selection and lifecycle; RPC stays textual", async t => {
 t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100000 });
 const listeners = new Set<() => void>(), cancelled: string[] = [];
 const snapshot: import("../src/workflows.ts").WorkflowSnapshot = { id: "flow", title: "Release", state: "running", open: false, startedAt: 1, updatedAt: 1,
  phases: [{ id: "plan", title: "Plan", state: "completed", tasks: [{ agent: "worker", label: "Plan task", state: "completed", runId: "one" }] },
   { id: "build", title: "Build", state: "running", tasks: [{ agent: "worker", label: "Build task", state: "running" }] }] };
 const workflows = { list: () => [snapshot], get: () => snapshot, restore() {}, cancel(id: string) { cancelled.push(id); }, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); } } as unknown as import("../src/workflows.ts").Workflows;
 const f = fixture("tui", undefined, workflows); f.record({ answer: "DETAIL ANSWER", workflowId: "flow", label: "Plan task" });
 await f.emit("session_start"); await f.command("panel expand");
 const card = () => f.widgets.get("hempi.agent-panel");
 t.mock.timers.tick(10000);
 assert.match(card().render(100).join("\n"), /Plan.*1\/1/);
 assert.equal(f.widgets.size, 1, "active workflow history does not expire after six seconds");
 const pending = f.commands.get("workflows")!("", f.ctx); await tick();
 assert.equal(listeners.size, 2);
 assert.match(f.active.render(100).join("\n"), /Build task/);
 f.active.handleInput("\x1b[D"); assert.match(f.active.render(100).join("\n"), /Plan task/);
 f.active.handleInput("enter"); assert.match(f.active.render(100).join("\n"), /DETAIL ANSWER/);
 f.active.handleInput("esc");
 const runCancellations: string[] = []; f.agents.runs.cancel = id => { runCancellations.push(id); };
 f.active.handleInput("x"); assert.deepEqual(runCancellations, ["one"]); assert.deepEqual(cancelled, []);
 assert.equal(f.active.handleMouse({ type: "press", button: "left", x: 3, y: 5 })?.focus, false);
 assert.match(f.active.render(100).join("\n"), /Build task/);
 f.active.handleInput("X"); assert.deepEqual(cancelled, ["flow"]);
 await f.emit("session_before_switch"); await pending; assert.equal(listeners.size, 0); assert.equal(f.active, undefined);
 const rpc = fixture("rpc", undefined, workflows); await rpc.emit("session_start");
 await rpc.commands.get("workflows")!("", rpc.ctx); assert.match(rpc.messages.at(-1)!, /Release/);
 await rpc.commands.get("workflows")!("show flow", rpc.ctx); assert.match(rpc.messages.at(-1)!, /Plan task/);
 await rpc.commands.get("workflows")!("cancel flow", rpc.ctx); assert.equal(cancelled.length, 2);
 assert.equal(rpc.active, undefined); assert.equal(rpc.widgets.size, 0);
 await rpc.emit("session_shutdown"); assert.equal(listeners.size, 0);
});
test("dock and inspector interleaved renders keep independent phase hit targets", async t => {
 t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100000 });
 const snapshot: import("../src/workflows.ts").WorkflowSnapshot = { id: "flow", title: "Many phases", state: "running", open: false, startedAt: 1, updatedAt: 1,
  phases: Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, title: `Phase${i}`, state: i === 15 ? "running" : "completed", tasks: [{ agent: "worker", label: `Task${i}`, state: i === 15 ? "running" : "completed" }] })) };
 const workflows = { list: () => [snapshot], restore() {}, subscribe: () => () => {} } as unknown as import("../src/workflows.ts").Workflows;
 const f = fixture("tui", undefined, workflows); f.terminal.rows = 35;
 await f.emit("session_start"); await f.command("panel expand");
 const pending = f.commands.get("workflows")!("", f.ctx); await tick();
 const dock = f.widgets.get("hempi.agent-panel");
 f.active.render(160); dock.render(100);
 assert.equal(f.active.handleMouse({ type: "press", button: "left", x: 3, y: 4 })?.focus, false);
 assert.match(f.active.render(160).join("\n"), /worker · Task0\s/);
 assert.match(dock.render(100).join("\n"), /worker · Task15\s/);
 assert.equal(dock.handleMouse({ type: "press", button: "left", x: 1, y: 4 })?.focus, false);
 assert.match(dock.render(100).join("\n"), /worker · Task6\s/);
 assert.match(f.active.render(160).join("\n"), /worker · Task0\s/);
 await f.emit("session_shutdown"); await pending;
});
test("workflow detail pins run and workflow across phase advances, then Escape follows again", async t => {
 t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100000 });
 const snapshot: import("../src/workflows.ts").WorkflowSnapshot = { id: "flow", title: "Flow", state: "running", open: false, startedAt: 1, updatedAt: 1,
  phases: [{ id: "a", title: "First", state: "running", tasks: ["one", "old"].map(runId => ({ agent: "worker", label: runId, state: "running", runId })) },
   { id: "b", title: "Next", state: "pending", tasks: [{ agent: "worker", label: "next", state: "pending", runId: "next" }] }] };
 const cancelled: string[] = [], runCancelled: string[] = [];
 let all = [snapshot];
 const workflows = { list: () => all, restore() {}, cancel(id: string) { cancelled.push(id); }, subscribe: () => () => {} } as unknown as import("../src/workflows.ts").Workflows;
 const f = fixture("tui", undefined, workflows);
 f.record({ id: "old", answer: "OLD DETAILS" }); f.record({ id: "next", answer: "NEW DETAILS" });
 const get = f.agents.runs.get.bind(f.agents.runs);
 let oldLive = true;
 f.agents.runs.get = id => { const run = get(id); return run ? { ...run, state: id === "old" && !oldLive ? "completed" : "running" } : undefined; };
 f.agents.runs.cancel = id => { runCancelled.push(id); };
 await f.emit("session_start");
 const pending = f.commands.get("workflows")!("", f.ctx); await tick();
 f.active.render(100); f.active.handleInput("down"); f.active.render(100); f.active.handleInput("enter");
 assert.match(f.active.render(100).join("\n"), /OLD DETAILS/);
 snapshot.phases[0].state = "completed"; snapshot.phases[1].state = "running";
 assert.match(f.active.render(100).join("\n"), /OLD DETAILS/);
 f.active.handleInput("x"); assert.deepEqual(runCancelled, ["old"]);
 oldLive = false;
 f.active.handleInput("x"); assert.deepEqual(runCancelled, ["old"], "terminal inspected run must not cancel next run");
 snapshot.state = "completed";
 all = [snapshot, { ...snapshot, id: "other", state: "running" }];
 f.active.handleInput("X"); assert.deepEqual(cancelled, ["flow"]);
 f.active.handleInput("esc"); f.active.render(100); f.active.handleInput("enter");
 assert.match(f.active.render(100).join("\n"), /NEW DETAILS/);
 f.active.handleInput("x"); assert.deepEqual(runCancelled, ["old", "next"]);
 await f.emit("session_shutdown"); await pending;
});
test("workflow table actions target the last render across unseen phase and workflow transitions", async () => {
 const snapshot: import("../src/workflows.ts").WorkflowSnapshot = { id: "flow", title: "Flow", state: "running", open: false, startedAt: 1, updatedAt: 1,
  phases: [{ id: "a", title: "First", state: "running", tasks: [{ agent: "worker", label: "old", state: "running", runId: "old" }] },
   { id: "b", title: "Next", state: "pending", tasks: [{ agent: "worker", label: "next", state: "pending", runId: "next" }] }] };
 const cancelled: string[] = [], runCancelled: string[] = [];
 let all = [snapshot];
 const workflows = { list: () => all, restore() {}, cancel(id: string) { cancelled.push(id); }, subscribe: () => () => {} } as unknown as import("../src/workflows.ts").Workflows;
 const f = fixture("tui", undefined, workflows);
 f.record({ id: "old", answer: "OLD DETAILS" }); f.record({ id: "next", answer: "NEW DETAILS" });
 f.agents.runs.cancel = id => { runCancelled.push(id); };
 await f.emit("session_start");
 const pending = f.commands.get("workflows")!("", f.ctx); await tick();
 f.active.render(100);
 snapshot.phases[0].state = "completed"; snapshot.phases[1].state = "running";
 f.active.handleInput("x"); assert.deepEqual(runCancelled, ["old"]);
 f.active.handleInput("enter"); assert.match(f.active.render(100).join("\n"), /OLD DETAILS/);
 f.active.handleInput("esc"); f.active.render(100);
 snapshot.state = "completed";
 all = [snapshot, { ...snapshot, id: "other", state: "running" }];
 f.active.handleInput("X"); assert.deepEqual(cancelled, ["flow"]);
 await f.emit("session_shutdown"); await pending;
});
test("pending workflow selection has no action target until a run is rendered", async () => {
 const snapshot: import("../src/workflows.ts").WorkflowSnapshot = { id: "flow", title: "Flow", state: "running", open: false, startedAt: 1, updatedAt: 1,
  phases: [{ id: "a", title: "First", state: "pending", tasks: [{ agent: "worker", label: "pending task", state: "pending" }] }] };
 const workflows = { list: () => [snapshot], restore() {}, subscribe: () => () => {} } as unknown as import("../src/workflows.ts").Workflows;
 const f = fixture("tui", undefined, workflows), cancelled: string[] = [];
 f.record({ id: "started", answer: "STARTED DETAILS" });
 f.agents.runs.cancel = id => { cancelled.push(id); };
 await f.emit("session_start");
 const pending = f.commands.get("workflows")!("", f.ctx); await tick();
 f.active.render(120); f.active.handleInput("enter");
 assert.match(f.active.render(120).join("\n"), /pending task/);
 const task = snapshot.phases[0].tasks[0]; task.runId = "started"; task.state = "running";
 f.active.handleInput("x"); assert.deepEqual(cancelled, []);
 f.active.handleInput("enter");
 assert.match(f.active.render(120).join("\n"), /pending task/);
 f.active.handleInput("enter"); assert.match(f.active.render(100).join("\n"), /STARTED DETAILS/);
 await f.emit("session_shutdown"); await pending;
});
test("literal strict commands route through Agents, including backend validation", async () => {
 const f = fixture(); f.record();
 await f.command(""); assert.match(f.messages.at(-1)!, /one.*completed/);
 await f.command("list"); await f.command("show one"); assert.match(f.messages.at(-1)!, /Usage: unknown · Cost: unknown/);
 for (const text of ["show", "list extra", "cancel one extra", "start worker --harness nope task", "start worker --other task", "start worker --harness pi", "followup one"]) {
  await f.command(text); assert.match(f.errors.at(-1)!, /Usage:/);
 }
 await f.command("start worker --harness codex literal $(no shell); text");
 assert.deepEqual(f.calls.at(-1)?.slice(0, 3), ["start", "worker", "literal $(no shell); text"]);
 assert.deepEqual(f.calls.at(-1)?.at(-1), { harness: "codex" });
 await f.command("start readonly task"); assert.match(f.errors.at(-1)!, /backend read-only validation/);
 await f.command("followup one next task"); assert.deepEqual(f.calls.at(-1)?.slice(0, 3), ["followup", "one", "next task"]);
 await f.command("cancel missing"); assert.match(f.errors.at(-1)!, /Unknown run/);
});
test("live roster, safe narrow rendering, detail scrolling, targeted cancel and status cleanup", async () => {
 const f = fixture("tui"); await f.emit("session_start"); assert.equal(f.subscribers, 1);
 let update!: (text: string) => void, finish!: (value: {}) => void;
 const id = f.agents.runs.start({ agent: "worker", harness: "omp", cwd: "/tmp", task: "task" }, control => {
  control.setState("running"); update = control.update;
  return new Promise(resolve => { finish = resolve; control.signal.addEventListener("abort", () => resolve({})); });
 });
 await tick(); assert.equal(f.statuses.get("hempi-runs"), undefined); assert.equal(f.widgets.size, 1);
 const pending = f.command(""); await tick(); assert.equal(f.subscribers, 2);
 const before = f.renders; update("progress\u001b[2J\u001b]52;c;SECRET\u0007\u009b31m\nnew line");
 assert.ok(f.renders > before); f.active.handleInput("enter");
 for (const width of [1, 8, 24, 100]) {
  const lines = f.active.render(width); assert.ok(lines.length <= 19);
  assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
  assert.doesNotMatch(lines.join("\n").replace(/\u001b\[0m/g, ""), /[\u001b\u0007\u009b]|SECRET/);
 }
 assert.match(f.active.render(100).join("\n"), /progress/);
 f.active.invalidate(); f.active.handleInput("down"); f.active.handleInput("\u001b[6~"); f.active.render(8);
 f.active.handleInput("x"); await f.agents.runs.wait(id);
 assert.equal(f.agents.runs.get(id)?.state, "cancelled");
 assert.equal(f.statuses.get("hempi-runs"), undefined);
 f.active.handleInput("esc"); assert.ok(f.active); f.active.handleInput("esc"); await pending;
 assert.equal(f.subscribers, 1); finish({});
 await f.emit("session_shutdown"); assert.equal(f.subscribers, 0);
});
test("completion updates details without auto turns; output is bounded and tiny heights fit", async () => {
 const f = fixture("tui"); await f.emit("session_start");
 let finish!: (value: { answer: string; file: string }) => void;
 const id = f.agents.runs.start({ agent: "worker\nsecond line", harness: "omp", cwd: "/tmp", task: "task" }, control => {
  control.setState("running"); return new Promise(resolve => { finish = resolve; });
 });
 await tick(); await f.command(`followup ${id} task`); assert.match(f.errors.at(-1)!, /already live/);
 const pending = f.command(""); await tick();
 assert.ok(f.active.render(100).every((line: string) => !line.includes("\n")));
 f.active.handleInput("enter"); const count = f.messages.length;
 finish({ answer: "final\u001b]52;c;SECRET\u0007" + "a".repeat(51000), file: "/tmp/full.jsonl" });
 await f.agents.runs.wait(id); assert.equal(f.messages.length, count);
 assert.match(f.active.render(100).join("\n"), /completed/);
 assert.equal(f.statuses.get("hempi-runs"), undefined);
 for (const rows of [1, 2, 4, 8]) { f.terminal.rows = rows; assert.ok(f.active.render(1).length <= Math.max(1, rows - 1)); }
 await f.command(`show ${id}`); const output = f.messages.at(-1)!;
 assert.match(output, /Truncated; see transcript/); assert.match(output, /\/tmp\/full.jsonl/);
 assert.ok(output.length < 51000); assert.doesNotMatch(output, /SECRET|\u001b/);
 await f.emit("session_shutdown"); await pending;
});
test("followup closes roster, prompts, reopens; lifecycle invalidates pending input", async () => {
 const f = fixture("tui"); f.record(); await f.emit("session_start");
 const pending = f.command(""); await tick(); f.active.handleInput("f"); await tick();
 assert.equal(f.subscribers, 1);
 f.active.handleInput("next task"); f.active.handleInput("\r"); await tick();
 assert.deepEqual(f.calls.at(-1)?.slice(0, 3), ["followup", "one", "next task"]);
 assert.equal(f.subscribers, 2); f.active.handleInput("esc"); await pending;
 for (const event of ["session_before_switch", "session_before_tree", "session_before_fork", "session_shutdown"]) {
  const task = f.command(""); await tick(); f.active.handleInput("f"); await tick();
  const old = f.active, count = f.calls.length;
  await f.emit(event); old.handleInput("wrong parent"); old.handleInput("\r");
  await task; assert.equal(f.calls.length, count); assert.equal(f.active, undefined);
 }
 assert.equal(f.subscribers, 0);
});
test("session tree replaces subscriptions and closes open panel", async () => {
 const f = fixture("tui"); await f.emit("session_start");
 const old = f.agents.runs, pending = f.command(""); await tick();
 f.agents.runs = f.makeRegistry(); await f.emit("session_tree"); await pending;
 assert.equal(f.active, undefined); assert.equal(f.subscribers, 1);
 old.restore([{ id: "old", agent: "w", harness: "pi", cwd: "/tmp", task: "t", state: "completed", answer: "", progress: "", startedAt: 0, updatedAt: 0 }]);
 assert.equal(f.statuses.get("hempi-runs"), undefined);
 await f.emit("session_shutdown"); assert.equal(f.subscribers, 0);
});
test("anchored card persists only explicit toggles; ticks, expires, rebinds and disposes", async t => {
 t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100000 });
 const listeners = new Set<Function>();
 let extraRows: any[] = [];
 const extra = { snapshot: () => extraRows, subscribe(fn: Function) { listeners.add(fn); return () => listeners.delete(fn); } };
 const f = fixture("tui", extra), key = "hempi.agent-panel";
 f.record(); const base = f.agents.runs.overview()[0];
 const show = (patch: Partial<RunInfo>) => {
  f.agents.runs.overview = () => [{ ...base, ...patch }];
 };
 assert.equal(listeners.size, 0); assert.equal(f.subscribers, 0);
 await f.emit("session_start"); assert.equal(f.widgets.size, 0);
 const idleRenders = f.renders; t.mock.timers.tick(10000); assert.equal(f.renders, idleRenders);
 show({ state: "running", startedAt: 109000, runningAt: 109000 }); await f.emit("session_tree");
 const card = () => f.widgets.get(key);
 assert.ok(card()); assert.match(card().render(80)[0], /1 active · 1s/);
 t.mock.timers.tick(1000); assert.match(card().render(80)[0], /2s/);
 assert.equal(f.entries.length, 0);
 await f.command("panel expand"); assert.equal(f.entries.length, 1);
 assert.equal(f.entries[0].customType, key); assert.ok(card().render(80).length > 1);
 await f.command("panel collapse"); assert.equal(card().render(80).length, 1);
 await f.command("panel"); assert.equal(f.entries.at(-1).data.expanded, true);
 extraRows = [{ id: "optchat:x", agent: "Planner", harness: "pi", title: "Plan it", state: "paused", startedAt: 110000, updatedAt: 110000 }];
 for (const fn of listeners) fn(); await tick(); assert.match(card().render(80).join("\n"), /Planner/);
 const old = f.agents.runs;
 f.replaceRegistry(); assert.equal(f.subscribers, 1); assert.equal(listeners.size, 1);
 assert.match(card().render(80).join("\n"), /idle/);
 const paused = f.renders; t.mock.timers.tick(10000); assert.equal(f.renders, paused);
 const before = f.renders; old.restore([]); await tick(); assert.equal(f.renders, before);
 extraRows = []; for (const fn of listeners) fn(); await tick(); assert.equal(f.widgets.size, 0);
 show({ state: "completed", startedAt: 119000, runningAt: 119000, finishedAt: 121000, updatedAt: 121000 }); await f.emit("session_tree");
 assert.match(card().render(80).join("\n"), /completed\s+2s/);
 t.mock.timers.tick(5000); assert.match(card().render(80).join("\n"), /completed\s+2s/);
 t.mock.timers.tick(1000); assert.equal(f.widgets.size, 0);
 const entries = f.entries.length;
 await f.emit("session_tree"); assert.equal(f.entries.length, entries);
 show({ state: "running", startedAt: 117000 }); await f.emit("session_tree");
 assert.ok(card().render(80).length > 1);
 const stale = card(); await f.emit("session_shutdown");
 assert.equal(f.widgets.size, 0); assert.equal(f.subscribers, 0); assert.equal(listeners.size, 0); assert.equal(f.registryListeners.size, 0);
 assert.deepEqual(stale.render(80), []);
 const count = f.renders; t.mock.timers.tick(10000); assert.equal(f.renders, count);
});
test("queued activity ticks; paused-only stops, terminal expires and future completions stay hidden", async t => {
 t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 10000 });
 const listeners = new Set<() => void>();
 let rows = [{ id: "optchat:a", agent: "Worker", title: "Task", harness: "pi", state: "paused", startedAt: 1000, updatedAt: 5000 }];
 const f = fixture("tui", { snapshot: () => rows, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } });
 const update = async (state: string, updatedAt = Date.now()) => { rows = [{ ...rows[0], state, updatedAt }]; for (const fn of listeners) fn(); await tick(); };
 await f.emit("session_start"); await f.command("panel expand");
 const card = () => f.widgets.get("hempi.agent-panel");
 assert.match(card().render(80).join("\n"), /idle · 4s/);
 let count = f.renders; t.mock.timers.tick(10000); assert.equal(f.renders, count);
 await update("queued"); assert.match(card().render(80).join("\n"), /wait 19s/);
 count = f.renders; t.mock.timers.tick(1000); assert.ok(f.renders > count); assert.match(card().render(80).join("\n"), /wait 20s/);
 await update("paused"); count = f.renders; t.mock.timers.tick(10000); assert.equal(f.renders, count);
 assert.match(card().render(80).join("\n"), /idle · 20s/);
 await update("completed", Date.now() + 100000); assert.equal(f.widgets.size, 0);
 count = f.renders; t.mock.timers.tick(10000); assert.equal(f.renders, count);
 await update("completed"); assert.ok(card()); t.mock.timers.tick(6000); assert.equal(f.widgets.size, 0);
 await f.emit("session_shutdown"); assert.equal(listeners.size, 0);
});
test("RPC never mounts widgets, subscribes extra activity or ticks", async t => {
 t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 10000 });
 const f = fixture("rpc", { snapshot() { throw new Error("not TUI"); }, subscribe() { throw new Error("not TUI"); } });
 await f.emit("session_start"); f.record({ state: "running" }); await tick();
 assert.equal(f.widgets.size, 0); const n = f.renders; t.mock.timers.tick(10000); assert.equal(f.renders, n);
 await f.command("panel"); assert.match(f.messages.at(-1)!, /requires TUI/);
 await f.emit("session_shutdown"); assert.equal(f.subscribers, 0);
});
test("loss of parent ownership detaches the card even without a session event", async t => {
 t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 10000 });
 const f = fixture("tui"); await f.emit("session_start");
 let report!: (metrics: { reportedTokens: number }) => void;
 f.agents.runs.start({ agent: "worker", harness: "pi", cwd: "/tmp", task: "Work" }, control => {
  report = control.report; control.setState("running");
  return new Promise(resolve => control.signal.addEventListener("abort", () => resolve({}), { once: true }));
 });
 await tick(); assert.equal(f.widgets.size, 1);
 f.agents.owns = () => false; report({ reportedTokens: 20 }); await tick();
 assert.equal(f.widgets.size, 0); assert.equal(f.subscribers, 0); assert.equal(f.registryListeners.size, 0);
 const renders = f.renders; t.mock.timers.tick(10000); assert.equal(f.renders, renders);
 await f.agents.runs.stop();
});
