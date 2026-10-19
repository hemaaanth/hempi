import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, Container, Input, sliceByColumn, stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ActivityPanel, activityElapsed, visibleActivities } from "../src/acp/activity-panel.ts";
import type { AgentActivity } from "../src/acp/activity-types.ts";
const row: AgentActivity = { id: "a", agent: "worker", title: "Review work", harness: "codex", state: "running", startedAt: 1000, runningAt: 2000, updatedAt: 2000 };
const mouse = (patch: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({ type: "press", button: "left", x: 79, y: 0, screenX: 79, screenY: 0, width: 80, height: 5, shift: false, alt: false, ctrl: false, ...patch });
test("compact right alignment, safe Unicode, resize and fresh theme", () => {
 let expanded = false, color = "", fullscreen = true, height = 24;
 const roles: string[] = [];
 const theme = { bg: () => assert.fail("floating panel must not paint a background"), fg: (role: string, text: string) => { roles.push(role); return color + text + (color ? "\x1b[0m" : ""); } } as unknown as Theme;
 const rows = [row, { ...row, id: "b", agent: "审阅者\n\x1b]8;;https://bad\x07\x1b]8;;\x07\u009b", title: "👩‍💻界é\nnew\rline\u0085" }];
 const panel = new ActivityPanel(theme, () => rows, () => expanded, () => { expanded = !expanded; }, () => fullscreen, () => height, () => 7000);
 for (const expand of [false, true]) {
  expanded = expand;
  for (const width of [0, 1, 2, 3, 8, 24, 68, 80, 120]) {
   const lines = panel.render(width);
   if (!width) { assert.deepEqual(lines, []); continue; }
   assert.ok(lines.length <= 7);
   assert.doesNotMatch(lines[0], /[╭╮╰╯│─]/, "summary remains separate from the detail frame");
   if (expand && width >= 3) {
    const left = Math.max(0, width - 68);
    assert.equal(lines[1], " ".repeat(left) + "╭" + "─".repeat(Math.min(68, width) - 2) + "╮");
    assert.equal(lines.at(-1), " ".repeat(left) + "╰" + "─".repeat(Math.min(68, width) - 2) + "╯");
    assert.ok(lines.slice(2, -1).every(line => line[left] === "│" && line.endsWith("│")));
    assert.ok(lines.every(line => visibleWidth(line) === width));
   } else assert.equal(lines.length, 1);
   assert.ok(lines.every(line => visibleWidth(line) <= width && !/[\n\r\u0080-\u009f\x1b]/.test(line.replace(/\x1b\[0m/g, ""))));
   assert.equal(visibleWidth(lines[0]), width);
  }
 }
 assert.match(panel.render(80).join("\n"), /worker · Review work/);
 assert.match(panel.render(80).join("\n"), /tokens —/);
 assert.doesNotMatch(panel.render(80).join("\n"), /https/);
 expanded = false; panel.render(80);
 assert.equal(panel.handleMouse(mouse({ y: 1 })), undefined);
 assert.equal(panel.handleMouse(mouse({ type: "drag" })), undefined);
 assert.equal(panel.handleMouse(mouse({ x: 0 })), undefined);
 fullscreen = false; assert.equal(panel.handleMouse(mouse()), undefined); fullscreen = true;
 assert.deepEqual(panel.handleMouse(mouse()), { handled: true, focus: false, capture: true, render: true });
 assert.equal(expanded, true);
 panel.handleMouse(mouse({ type: "release" })); panel.handleMouse(mouse({ type: "click" }));
 assert.equal(expanded, true);
 for (const modifier of ["shift", "alt", "ctrl"]) assert.equal(panel.handleMouse(mouse({ [modifier]: true })), undefined);
 assert.equal(panel.handleMouse(mouse({ y: 1 })), undefined);
 assert.equal(panel.handleMouse(mouse({ y: 1, type: "drag" })), undefined);
 color = "\x1b[31m"; roles.length = 0; panel.invalidate(); assert.match(panel.render(80)[0], /\x1b\[31m/);
 for (const role of ["accent", "text", "muted", "borderMuted"]) assert.ok(roles.includes(role));
 for (height of [1, 2, 8]) assert.ok(panel.render(2).length <= Math.max(1, height - 4));
});
test("active rows precede old completions; overflow scrolls only the fullscreen body", () => {
 const theme = { bg: (_: string, text: string) => text, fg: (_: string, text: string) => text } as unknown as Theme;
 let rows = [{ ...row, id: "old", agent: "OLD", state: "completed" }, ...Array.from({ length: 4 }, (_, i) => ({ ...row, id: String(i), agent: `ACTIVE${i}` }))];
 let height = 18, fullscreen = true;
 const panel = new ActivityPanel(theme, () => rows, () => true, () => {}, () => fullscreen, () => height, () => 7000);
 let text = panel.render(80).join("\n");
 for (let i = 0; i < 4; i++) assert.match(text, new RegExp(`ACTIVE${i}`));
 assert.doesNotMatch(text, /OLD/); assert.match(text, /4 active/); assert.match(text, /\+1 more · \/agent-runs/);
 const wheel = (patch: Partial<TuiMouseEvent> = {}) => panel.handleMouse(mouse({ type: "wheel", button: "none", y: 1, wheelDelta: 1, ...patch }));
 for (const patch of [{ y: 0 }, { y: 12 }, { x: 0 }, { shift: true }]) assert.equal(wheel(patch), undefined);
 for (const type of ["press", "drag", "release", "click"] as const) assert.equal(panel.handleMouse(mouse({ type, y: 1 })), undefined);
 assert.equal(wheel()?.focus, false); text = panel.render(80).join("\n");
 assert.doesNotMatch(text, /ACTIVE0/); assert.match(text, /OLD/);
 wheel({ wheelDelta: -1 }); assert.match(panel.render(80).join("\n"), /ACTIVE0/);
 fullscreen = false; assert.equal(wheel(), undefined); fullscreen = true;
 rows = rows.slice(1); panel.render(80); assert.equal(wheel(), undefined);
 height = 40; rows = Array.from({ length: 8 }, (_, i) => ({ ...row, id: `optchat:${i}`, agent: `OPT${i}` }));
 const lines = panel.render(80); assert.equal(lines.length, 14);
 assert.match(lines.join("\n"), /OPT4/); assert.doesNotMatch(lines.join("\n"), /OPT5/);
 assert.match(lines.join("\n"), /\/optchat agents/); assert.doesNotMatch(lines.join("\n"), /\/agent-runs/);
});
test("native container dispatch handles header press once without input focus or draft changes", () => {
 let expanded = false, toggles = 0;
 const theme = { bg: (_: string, text: string) => text, fg: (_: string, text: string) => text } as unknown as Theme;
 const panel = new ActivityPanel(theme, () => [row], () => expanded, () => { expanded = !expanded; toggles++; }, () => true, () => 24);
 const root = new Container(), input = new Input(); input.focused = true; input.handleInput("draft");
 root.addChild(panel); root.addChild(input); root.render(80);
 for (const type of ["press", "release", "click"] as const) {
  const result = root.handleMouse(mouse({ type }));
  assert.notEqual(result?.focus, true); root.render(80);
 }
 assert.equal(toggles, 1); assert.equal(input.focused, true); input.handleInput(" more"); assert.equal(input.getValue(), "draft more");
 assert.equal(root.handleMouse(mouse({ y: 1 })), undefined);
 assert.equal(root.handleMouse(mouse({ y: 1, type: "drag" })), undefined);
});
test("border rows mask underlying content with native compositing and obey height budgets", () => {
 const theme = { bg: () => assert.fail("no colored background"), fg: (_: string, text: string) => text } as unknown as Theme;
 const rows = Array.from({ length: 12 }, (_, i) => ({ ...row, id: String(i), agent: `ACTIVE${i}` }));
 let height = 24;
 const panel = new ActivityPanel(theme, () => rows, () => true, () => {}, () => true, () => height);
 for (height of [1, 8, 9, 10, 11, 12, 16, 24, 40]) {
  for (const width of [1, 2, 3, 8, 40, 80, 120]) {
   const lines = panel.render(width), w = Math.min(68, width), left = width - w;
   assert.ok(lines.length <= Math.max(1, Math.min(15, height - 6)));
   if (lines.length === 1) continue;
   assert.match(lines[1].trimStart(), /^╭─+╮$/);
   assert.match(lines.at(-1)!.trimStart(), /^╰─+╯$/);
   for (const line of lines.slice(1)) {
    const overlay = sliceByColumn(line, left, w);
    const composed = stripTerminalSequences(compositeTuiLine("X".repeat(width), overlay, left, w, width));
    assert.equal(composed, "X".repeat(left) + stripTerminalSequences(overlay), "only the complete popup rectangle replaces the transcript");
   }
   const wheel = (x: number, y: number) => panel.handleMouse(mouse({ type: "wheel", button: "none", x, y, wheelDelta: 1 }));
   assert.equal(wheel(left, 0), undefined);
   assert.equal(wheel(left - 1, 1), undefined);
   assert.equal(wheel(width, 1), undefined);
   assert.equal(wheel(left, lines.length), undefined);
   if (lines.some(line => line.includes("ACTIVE"))) {
    assert.equal(wheel(left, 1)?.focus, false, "top border scrolls without focus");
    assert.equal(wheel(width - 1, lines.length - 1)?.focus, false, "bottom/right border scrolls");
   }
  }
 }
});
test("workflow popup retains completed phases, independent agents, safe mouse and bounded borders", () => {
 const theme = { fg: (_: string, text: string) => text, bg: () => assert.fail("no background") } as unknown as Theme;
 const workflow: import("../src/workflows.ts").WorkflowSnapshot = { id: "w", title: "Ship", state: "running", open: true, startedAt: 1, updatedAt: 1,
  phases: [{ id: "p", title: "Plan", state: "completed", tasks: [{ agent: "worker", label: "Review", state: "completed" }] },
   { id: "b", title: "Build", state: "running", tasks: [{ agent: "worker", label: "Implement", state: "running" }] }] };
 let height = 24, fullscreen = true;
 const panel = new ActivityPanel(theme, () => [{ ...row, label: "Independent" }], () => true, () => {}, () => fullscreen, () => height, () => 100000, () => [workflow]);
 let lines = panel.render(100); assert.match(lines[0], /1 workflow/); assert.match(lines.join("\n"), /Independent/);
 assert.match(lines.join("\n"), /Plan\s+1\/1/); assert.match(lines.join("\n"), /Implement/);
 assert.equal(panel.handleMouse(mouse({ x: 1, y: 4 }))?.focus, false);
 assert.match(panel.render(100).join("\n"), /Review/);
 fullscreen = false; assert.equal(panel.handleMouse(mouse({ x: 1, y: 4 })), undefined); fullscreen = true;
 for (height of [1, 8, 10, 15, 24]) for (const width of [1, 3, 8, 30, 60, 100]) {
  lines = panel.render(width); assert.ok(lines.length <= Math.max(1, Math.min(15, height - 6)));
  assert.ok(lines.every(line => visibleWidth(line) <= width));
  if (lines.length > 1) assert.match(lines.at(-1)!, /╯$/);
 }
});
test("mixed independent pane scrolls every ACP/OptChat row only inside its rectangle", () => {
 const theme = { fg: (_: string, text: string) => text } as unknown as Theme;
 const workflow: import("../src/workflows.ts").WorkflowSnapshot = { id: "w", title: "Flow", state: "running", open: false, startedAt: 1, updatedAt: 1,
  phases: [{ id: "p", title: "Phase", state: "running", tasks: [{ agent: "worker", label: "Workflow task", state: "running" }] }] };
 let now = 100000;
 const rows = Array.from({ length: 12 }, (_, i) => ({ ...row, id: i % 2 ? `optchat:${i}` : `acp:${i}`, agent: `Agent${i}`, label: `Independent${i}` }));
 rows[0] = { ...rows[0], state: "paused", updatedAt: 67000 };
 const panel = new ActivityPanel(theme, () => rows, () => true, () => {}, () => true, () => 30, () => now, () => [workflow]);
 let lines = panel.render(120);
 const top = lines.findIndex(line => line.includes("Independent (")) + 1;
 assert.match(lines.join("\n"), /\+\d+ more · \/agent-runs · \/optchat agents/);
 const wheel = (x: number, y: number, wheelDelta = 1) => panel.handleMouse(mouse({ type: "wheel", button: "none", x, y, wheelDelta }));
 for (const [x, y] of [[10, top], [119, top], [9, top], [11, top - 1], [11, lines.length - 1]]) assert.equal(wheel(x, y), undefined);
 const seen = new Set<string>();
 for (let i = 0; i < 15; i++) {
  for (const match of lines.join("\n").matchAll(/Independent\d+/g)) seen.add(match[0]);
  assert.equal(wheel(11, top)?.focus, false);
  lines = panel.render(120);
 }
 assert.equal(seen.size, rows.length);
 const paused = lines.find(line => line.includes("Independent0"));
 assert.ok(paused); assert.match(paused, /1m 5s/);
 now += 60000;
 assert.equal(panel.render(120).find(line => line.includes("Independent0")), paused, "active workflow refresh must not advance paused metrics");
 for (let i = 0; i < 15; i++) { wheel(11, top, -1); panel.render(120); }
 assert.match(panel.render(120).join("\n"), /Independent1/);
});
test("reported consumption distinct from ctx; elapsed freezes, wait labels and recent expiry", () => {
 const done = { ...row, state: "completed", finishedAt: 8000, reportedTokens: 42, contextTokens: 9000 };
 assert.equal(activityElapsed(row, 12000), "10s");
 assert.equal(activityElapsed(done, 100000), "6s");
 assert.equal(visibleActivities([done], 13999).length, 1);
 assert.equal(visibleActivities([done], 14000).length, 0);
 const waiting = { ...row, state: "paused" };
 assert.equal(visibleActivities([waiting], 100000).length, 1);
 const theme = { bg: (_: string, text: string) => text, fg: (_: string, text: string) => text } as unknown as Theme;
 const panel = new ActivityPanel(theme, () => [done, waiting], () => true, () => {}, () => true, () => 24, () => 100000);
 const text = panel.render(80).join("\n");
 assert.match(text, /1 idle/); assert.match(text, /completed · 6s · tokens 42 · ctx 9k/);
 assert.match(text, /idle · 0s · tokens —/);
 assert.equal(activityElapsed(waiting, 999999), "0s");
 assert.equal(visibleActivities([done], 7999).length, 0);
 for (const state of ["queued", "starting", "awaiting_approval", "waiting", "stopping"]) {
  const active = { ...row, state, runningAt: undefined, reportedTokens: 1200, contextTokens: 2300000 };
  const card = new ActivityPanel(theme, () => [active], () => true, () => {}, () => true, () => 24, () => 7000);
  const output = card.render(80).join("\n");
  assert.match(output, /1 active/); assert.match(output, /tokens 1.2k · ctx 2.3M/);
  assert.match(output, ["queued", "starting"].includes(state) ? /wait 6s/ : / · 6s · tokens/);
 }
});
