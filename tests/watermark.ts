import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { mock } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rgbColor, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import registerWatermark from "../src/watermark.ts";
import { renderMark } from "../src/watermark-art.ts";
import testArt from "./watermark-art.ts";

export default function () {
 testArt();
 mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
 const timeouts = mock.method(globalThis, "setTimeout"), intervals = mock.method(globalThis, "setInterval");
 try {
  const handlers = new Map<string, Function>();
  registerWatermark({
   on(name: string, handler: Function) { handlers.set(name, handler); },
   registerShortcut() { assert.fail("static watermark must not register replay shortcuts"); },
  } as unknown as ExtensionAPI);
  let branch: { type: string }[] = [];
  let header!: Component & { dispose(): void };
  let renders = 0, installations = 0, editorText = "";
  const tui = { terminal: { rows: 40 }, requestRender() { renders++; } };
  const theme = {
   colors: { text: rgbColor(226, 234, 228), accent: rgbColor(148, 226, 165), userMessageBg: rgbColor(20, 27, 23) },
   getColorMode: () => "truecolor",
   style: (text: string) => `\x1b[2m${text}\x1b[22m`,
  };
  const ctx = { mode: "tui", sessionManager: { getBranch: () => branch }, ui: {
   setHeader(factory: Function) { installations++; header?.dispose(); header = factory(tui, theme); },
   getEditorText: () => editorText,
  } } as unknown as ExtensionContext;
  const emit = (name: string, event = {}, current = ctx) => handlers.get(name)!(event, current);
  const start = (reason = "new") => emit("session_start", { reason });
  const shown = () => header.render(80).some(line => stripVTControlCharacters(line).trim().length > 0);
  const mouse = (type: TuiMouseEvent["type"], x = 40, y = 15, other = {}) => header.handleMouse?.({
   type, x, y, screenX: x, screenY: y, width: 80, height: 30, button: "left", shift: false, ctrl: false, alt: false, ...other,
  });
  const frame = () => [
   ...Array<string>(4).fill(""), ...renderMark(60, 22, theme).map(line => " ".repeat(10) + line), ...Array<string>(4).fill(""),
  ];
  start(); assert.equal(renders, 0); assert.ok(shown());
  const idle = header.render(80);
  assert.deepEqual(idle, frame(), "static HΠ on first render");
  assert.equal(idle.length, 30);
  assert.ok(idle.some(line => /[\u2801-\u28ff]/.test(line)));
  const ink = idle.map(stripVTControlCharacters);
  const top = ink.findIndex(line => line.trim()), bottom = ink.findLastIndex(line => line.trim());
  assert.ok(Math.abs(top - (29 - bottom)) <= 1, "vertically centered");
  const left = Math.min(...ink.filter(line => line.trim()).map(line => line.search(/\S/)));
  const right = Math.max(...ink.map(line => line.trimEnd().length));
  assert.ok(Math.abs(left - (80 - right)) <= 1, "horizontally centered");
  mock.timers.tick(10000);
  assert.equal(renders, 0, "idle never schedules renders");
  assert.deepEqual(header.render(80), idle, "time never changes the watermark");
  for (const event of ["input", "before_agent_start", "agent_start", "message_start"]) {
   start(); emit(event); assert.deepEqual(header.render(80), [], `${event} hides watermark`);
   emit("session_tree"); assert.ok(shown(), "navigation restores empty branch");
   assert.deepEqual(header.render(80), frame());
  }
  for (const type of ["message", "custom_message", "compaction", "branch_summary", "context_edit"]) {
   branch = [{ type }]; start(); assert.ok(!shown(), `${type} is not an empty branch`);
   emit("session_tree"); assert.ok(!shown());
  }
  branch = [{ type: "message" }];
  for (const reason of ["startup", "resume", "reload", "fork"]) { start(reason); assert.ok(!shown()); }
  branch = [{ type: "model_change" }, { type: "custom" }];
  start("resume"); assert.ok(!shown(), "empty resumed sessions stay quiet");
  editorText = "draft"; start(); assert.ok(!shown());
  editorText = ""; assert.ok(shown(), "clearing initial draft restores static mark");
  start("startup"); assert.ok(shown(), "metadata alone is not a conversation");
  for (const rows of [1, 10, 11, 14, 16, 24, 60]) {
   tui.terminal.rows = rows;
   for (const width of [0, 1, 2, 5, 12, 21, 22, 30, 80]) {
    const lines = header.render(width);
    assert.ok(lines.length <= Math.max(0, rows - 10), `height bounded at ${rows}`);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `width bounded at ${width}`);
    if (width >= 2 && rows > 10) assert.ok(lines.some(line => stripVTControlCharacters(line).trim()));
   }
  }
  tui.terminal.rows = 40;
  const green = header.render(80);
  theme.colors.accent = rgbColor(100, 150, 240); header.invalidate();
  assert.notDeepEqual(header.render(80), green, "theme invalidation rebuilds cached colors");
  editorText = "draft"; assert.deepEqual(header.render(80), []);
  editorText = ""; assert.deepEqual(header.render(80), frame(), "clearing draft restores the same mark");
  const beforeMouse = renders, resting = header.render(80);
  const decorativePress = { handled: true, capture: true, render: true };
  assert.deepEqual(mouse("press", 0, 0), decorativePress, "decoration cannot start text selection");
  assert.deepEqual(mouse("press"), decorativePress);
  assert.equal(mouse("press", 40, 15, { button: "right" }), undefined, "right-click paste stays native");
  assert.deepEqual(mouse("press", 40, 15, { shift: true }), decorativePress);
  for (const type of ["click", "wheel", "drag", "release"] as const) assert.equal(mouse(type), undefined);
  mock.timers.tick(10000);
  assert.equal(renders, beforeMouse, "clicking never starts scheduled renders");
  assert.deepEqual(header.render(80), resting, "clicking cannot change the static mark");
  for (const action of ["session_start", "session_shutdown", "dispose"]) {
   start(); shown();
   if (action === "dispose") header.dispose(); else emit(action, { reason: "new" });
   const count = renders; mock.timers.tick(10000); assert.equal(renders, count);
  }
  for (const mode of ["rpc", "json", "print"]) {
   const before = installations;
   emit("session_start", { reason: "new" }, { ...ctx, mode, ui: {} } as unknown as ExtensionContext);
   emit("session_tree", {}, { ...ctx, mode, ui: {} } as unknown as ExtensionContext);
   assert.equal(installations, before, `${mode} never accesses setHeader`);
  }
  emit("session_start", { reason: "new" }, { ...ctx, ui: {} } as ExtensionContext);
  start(); shown(); emit("session_shutdown"); assert.ok(!shown());
  assert.equal(timeouts.mock.callCount(), 0, "no timeout creation");
  assert.equal(intervals.mock.callCount(), 0, "no interval creation");
  console.error("watermark: static lifecycle, bounds, theme, draft, mouse capture and no timers passed");
 } finally {
  mock.restoreAll(); mock.timers.reset();
 }
}
