import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { WorkflowView, agentTable } from "../src/acp/workflow-view.ts";
import type { WorkflowSnapshot } from "../src/workflows.ts";
const workflow = (): WorkflowSnapshot => ({ id: "w", title: "Ship", state: "running", open: false, startedAt: 1000, updatedAt: 2000,
 phases: ["Plan", "Build", "Check"].map((title, i) => ({ id: String(i), title, state: i === 0 ? "completed" : i === 1 ? "running" : "pending",
 tasks: [{ agent: "worker", label: `${title} task`, state: i === 0 ? "completed" : i === 1 ? "running" : "pending", runId: `r${i}` }] })) });
const mouse = (patch: Partial<TuiMouseEvent>): TuiMouseEvent => ({ type: "press", button: "left", x: 1, y: 2, screenX: 1, screenY: 2, width: 100, height: 20, shift: false, alt: false, ctrl: false, ...patch });
test("counts, history, progress following and explicit phase selection", () => {
 const w = workflow(), view = new WorkflowView();
 let text = view.render(w, [], 100, 10, 100000).join("\n");
 assert.match(text, /1\/3 phases/); assert.match(text, /✓ Plan\s+1\/1/); assert.match(text, /Build task/);
 w.phases[1].state = "completed"; w.phases[2].state = "running";
 assert.match(view.render(w, [], 100, 10, 100000).join("\n"), /Check task/);
 assert.equal(view.mouse(mouse({}), w), true);
 text = view.render(w, [], 100, 10, 100000).join("\n");
 assert.match(text, /Plan task/); assert.match(text, /completed/);
 w.phases[2].state = "completed"; w.state = "waiting";
 assert.match(view.render(w, [], 100, 10, 200000).join("\n"), /Plan task/);
 view.selectWorkflow(w.id); assert.match(view.render(w, [], 30, 8, 200000).join("\n"), /Check task/);
 view.mouse(mouse({ y: 1 }), w); assert.equal(view.phase(w), 0);
});
test("aligned table, short labels, actual metrics, hostile text and terminal budgets", () => {
 const w = workflow(), view = new WorkflowView();
 w.title = "界👩‍💻\x1b]52;c;SECRET\x07\nTitle\u009b";
 w.phases[1].title = "\x1b[2JBuild\n界"; w.phases[1].tasks[0].label = "Fix\x1b[31m界\u0085";
 const rows = [{ id: "r1", agent: "worker", title: "/secret/path long prompt", label: "Fix", state: "running", harness: "codex", model: "model-x", reportedTokens: 42, startedAt: 1000, updatedAt: 2000 }];
 for (const width of [0, 1, 2, 8, 24, 59, 60, 80, 120]) for (const height of [1, 2, 3, 8, 15]) {
  const lines = view.render(w, rows, width, height, 5000);
  assert.ok(lines.length <= height); assert.ok(lines.every(line => visibleWidth(line) <= width));
  assert.doesNotMatch(lines.join("\n").replace(/\x1b\[0m/g, ""), /SECRET|\x1b|[\u0080-\u009f]|secret\/path/);
 }
 const text = agentTable(rows, 100, 5000).join("\n");
 assert.match(text, /worker · Fix/); assert.match(text, /42/); assert.match(text, /codex model-x/);
 assert.doesNotMatch(text, /cost|tools|secret\/path/);
});
test("table metrics freeze paused and terminal rows and compact token counts", () => {
 const rows = ["paused", "completed"].map(state => ({ id: state, agent: state, title: "Task", state, harness: "pi", startedAt: 1000, updatedAt: 66000, reportedTokens: 623200 }));
 const before = agentTable(rows, 100, 100000).join("\n");
 assert.equal(agentTable(rows, 100, 200000).join("\n"), before);
 assert.match(before, /1m 5s/); assert.match(before, /623\.2k/);
});
test("automatic phase following clamps task before a caller picks the run", () => {
 const w = workflow(), view = new WorkflowView();
 w.phases[1].tasks.push({ ...w.phases[1].tasks[0], runId: "last" });
 view.phase(w); view.task = 1;
 w.phases[1].state = "completed"; w.phases[2].state = "running";
 const phase = w.phases[view.phase(w)];
 assert.equal(view.task, 0); assert.equal(phase.tasks[view.task].runId, "r2");
});
test("wheel scrolling targets the correct pane and workflow selection remains explicit", () => {
 const w = workflow(), view = new WorkflowView();
 w.phases.push(...Array.from({ length: 8 }, (_, i) => ({ ...w.phases[0], id: `extra${i}`, title: `Extra${i}` })));
 w.phases[1].tasks = Array.from({ length: 8 }, (_, i) => ({ agent: "worker", label: `Task${i}`, state: "running" }));
 view.render(w, [], 100, 5, 5000);
 view.mouse(mouse({ type: "wheel", wheelDelta: 1, x: 90 }), w);
 assert.match(view.render(w, [], 100, 5, 5000).join("\n"), /Task1/);
 view.mouse(mouse({ type: "wheel", wheelDelta: 1, x: 1 }), w);
 assert.doesNotMatch(view.render(w, [], 100, 5, 5000).join("\n"), /✓ Plan/);
 const other = { ...w, id: "other", title: "Other" };
 view.selectWorkflow(other.id); assert.equal(view.current([w, other])?.id, "other");
 assert.equal(new WorkflowView().current([{ ...w, state: "completed" }, other])?.id, "other");
});
