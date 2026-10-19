import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { MAX_COLUMNS, MAX_ROWS, renderMark } from "./watermark-art.ts";

class Watermark implements Component {
 private cache: { key: string; lines: string[] } | undefined;
 private ctx: ExtensionContext;
 private tui: TUI;
 private theme: Theme;
 private visible: boolean;
 constructor(ctx: ExtensionContext, tui: TUI, theme: Theme, visible: boolean) {
  this.ctx = ctx; this.tui = tui; this.theme = theme; this.visible = visible;
 }
 setVisible(visible: boolean): void {
  this.visible = visible; this.invalidate(); this.tui.requestRender();
 }
 dispose(): void { this.visible = false; this.invalidate(); }
 invalidate(): void { this.cache = undefined; }
 handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
  if (!this.visible || event.button !== "left" || event.type !== "press") return;
  // The entire header is decorative: capture its gesture, including drags through negative space.
  // A render also clears an existing selection highlight when Pi claims this press.
  return { handled: true, capture: true, render: true };
 }
 render(width: number): string[] {
  // Leave the existing editor, footer and status lines their space in either TUI layout.
  const height = Math.max(0, this.tui.terminal.rows - 10);
  if (!this.visible || width < 2 || !height || this.ctx.ui.getEditorText?.().trim()) {
   this.invalidate(); return [];
  }
  const key = `${width}:${height}`;
  if (this.cache?.key === key) return this.cache.lines;
  const columns = Math.min(MAX_COLUMNS, Math.max(0, width - 4));
  const rows = Math.min(MAX_ROWS, height);
  const art = renderMark(columns, rows, this.theme);
  const compact = !art.length;
  const lines = compact ? [this.theme.style("HΠ", { fg: "dim" })] : art;
  const left = Math.floor((width - (compact ? 2 : columns)) / 2);
  const top = Math.floor((height - lines.length) / 2);
  const output = [...Array<string>(top).fill(""), ...lines.map(line => " ".repeat(left) + line), ...Array<string>(height - top - lines.length).fill("")];
  this.cache = { key, lines: output };
  return output;
 }
}

export default function registerWatermark(pi: ExtensionAPI): void {
 let mark: Watermark | undefined;
 const empty = (ctx: ExtensionContext) => !ctx.sessionManager.getBranch().some((entry) =>
  ["message", "custom_message", "compaction", "branch_summary", "context_edit"].includes(entry.type));
 const hide = () => mark?.setVisible(false);
 pi.on("session_start", (event, ctx) => {
  mark?.dispose(); mark = undefined;
  if (ctx.mode !== "tui" || typeof ctx.ui.setHeader !== "function") return;
  ctx.ui.setHeader((tui, theme) => {
   mark = new Watermark(ctx, tui, theme, event.reason !== "resume" && empty(ctx));
   return mark;
  });
 });
 pi.on("session_tree", (_event, ctx) => { if (ctx.mode === "tui") mark?.setVisible(empty(ctx)); });
 pi.on("input", hide);
 pi.on("before_agent_start", hide);
 pi.on("agent_start", hide);
 pi.on("message_start", hide);
 pi.on("session_shutdown", () => { mark?.dispose(); mark = undefined; });
}
