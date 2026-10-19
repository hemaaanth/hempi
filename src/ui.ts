/*
 * Panel chrome adapted from oh-my-pi v18.4.2:
 * packages/tui/src/chrome/overlay-box.ts and overlays/ask-dialog.ts.
 * MIT License
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Input, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function panel(theme: Theme, width: number, title: string, body: (string | null)[], footer: string, footerDivider = true): string[] {
	const inner = Math.max(0, width - 2);
	const shown = truncateToWidth(` ${title.replace(/\s+/g, " ").trim()} `, Math.max(0, inner - 2), "");
	const rule = theme.fg("border", "─".repeat(inner));
	const row = (text: string) => {
		const cut = truncateToWidth(text, Math.max(0, width - 4), "");
		return theme.fg("border", "│") + " " + cut + " ".repeat(Math.max(0, width - 4 - visibleWidth(cut))) + " " + theme.fg("border", "│");
	};
	return [
		theme.fg("border", "╭─") + theme.bold(theme.fg("accent", shown)) + theme.fg("border", "─".repeat(Math.max(0, inner - 1 - visibleWidth(shown))) + "╮"),
		...body.map((line) => line === null ? theme.fg("border", "├") + rule + theme.fg("border", "┤") : row(line)),
		...(footerDivider ? [theme.fg("border", "├") + rule + theme.fg("border", "┤")] : []),
		row(theme.fg("muted", footer)),
		theme.fg("border", "╰") + rule + theme.fg("border", "╯"),
	].map((line) => truncateToWidth(line, width, ""));
}

type Option = { label: string; description?: string };
export type Choice = { answer: string; index: number | null; custom: boolean };

/** OMP-style composer panel: no overlay, option descriptions below labels, inline custom input. */
export async function chooseInline(ctx: ExtensionContext, question: string, options: Option[], signal?: AbortSignal, allowCustom = true, title = "Ask"): Promise<Choice | null> {
	if (signal?.aborted) return null;
	return ctx.ui.custom<Choice | null>((tui, theme, kb, done) => {
		let index = 0;
		let editing = false;
		let closed = false;
		const choices: Option[] = [...options, ...(allowCustom ? [{ label: "Other (type your own)" }] : [])];
		const editor = new Editor(tui, {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text),
			},
		});
		const finish = (choice: Choice | null) => { if (!closed) { closed = true; done(choice); } };
		const abort = () => finish(null);
		signal?.addEventListener("abort", abort, { once: true });
		editor.onSubmit = (text) => {
			if (text.trim()) finish({ answer: text.trim(), index: null, custom: true });
		};
		return {
			focused: false,
			dispose() { signal?.removeEventListener("abort", abort); closed = true; },
			invalidate() { editor.invalidate(); },
			render(width: number) {
				editor.focused = "focused" in this && this.focused === true && editing;
				const inner = Math.max(1, width - 4);
				const header = wrapTextWithAnsi(theme.bold(question), inner).slice(0, 4);
				let body: (string | null)[];
				if (editing) body = [...header, null, theme.fg("muted", "Custom answer:"), ...editor.render(inner)];
				else {
					const budget = Math.max(2, Math.floor(tui.terminal.rows * 0.65) - header.length - 5);
					const rows: string[][] = choices.map((option, i) => {
						const prefix = i === index ? "› ○ " : "  ○ ";
						const label = theme.fg(i === index ? "accent" : "text", `${i + 1}. ${option.label}`);
						const lines = wrapTextWithAnsi(label, Math.max(1, inner - 4));
						return [prefix + (lines[0] ?? ""), ...lines.slice(1).map((line) => "    " + line),
							...(option.description ? wrapTextWithAnsi(theme.fg("muted", option.description), Math.max(1, inner - 6)).slice(0, 2).map((line) => "      " + line) : [])];
					});
					const start = rows.slice(0, index).reduce((sum, row) => sum + row.length, 0);
					const all = rows.flat();
					const offset = Math.max(0, Math.min(start, all.length - budget));
					body = [...header, null, ...all.slice(offset, offset + budget)];
				}
				return panel(theme, width, title, body, editing ? "Enter submit · Shift+Enter newline · Esc back" : "↑↓ move · Enter select · Esc cancel");
			},
			handleInput(data: string) {
				if (closed) return;
				if (kb.matches(data, "tui.select.cancel")) {
					if (editing) editing = false;
					else finish(null);
				} else if (editing) editor.handleInput(data);
				else if (kb.matches(data, "tui.select.up")) index = Math.max(0, index - 1);
				else if (kb.matches(data, "tui.select.down")) index = Math.min(choices.length - 1, index + 1);
				else if (kb.matches(data, "tui.select.confirm")) {
					if (index === options.length) editing = true;
					else finish({ answer: options[index].label, index: index + 1, custom: false });
				}
				tui.requestRender();
			},
		};
	});
}

export function safeText(text: string): string {
 return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\t/g, "    ");
}

/** Searchable model/history browser in the composer, not an overlay. */
export async function selectInline(ctx: ExtensionContext, title: string, options: Option[], signal?: AbortSignal): Promise<number | null> {
 if (!options.length || signal?.aborted) return null;
 return ctx.ui.custom<number | null>((tui, theme, kb, done) => {
  const input = new Input();
  const items = options.map((option, index) => ({ value: String(index), label: safeText(option.label), description: option.description && safeText(option.description) }));
  let closed = false;
  const finish = (value: number | null) => { if (!closed) { closed = true; done(value); } };
  const makeList = (filtered: typeof items) => {
   const list = new SelectList(filtered, Math.max(3, Math.min(12, Math.floor(tui.terminal.rows * 0.5))), {
    selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text), description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text),
   });
   list.onSelect = (item) => finish(Number(item.value)); list.onCancel = () => finish(null); return list;
  };
  let list = makeList(items);
  const abort = () => finish(null);
  signal?.addEventListener("abort", abort, { once: true });
  return {
   focused: false,
   dispose() { closed = true; signal?.removeEventListener("abort", abort); },
   invalidate() { input.invalidate(); list.invalidate(); },
   render(width: number) { input.focused = "focused" in this && this.focused === true; const inner = Math.max(1, width - 4); return panel(theme, width, title, [...input.render(inner), null, ...list.render(inner)], "Type to search · ↑↓ move · Enter select · Esc cancel"); },
   handleInput(data: string) {
    if (closed) return;
    if (kb.matches(data, "tui.select.cancel")) finish(null);
    else if ((["tui.select.up", "tui.select.down", "tui.select.confirm"] as const).some((key) => kb.matches(data, key))) list.handleInput(data);
    else { input.handleInput(data); const query = input.getValue().toLowerCase(); list = makeList(items.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(query))); }
    tui.requestRender();
   },
  };
 });
}

/** Free-form follow-up input stays in the framed composer area. */
export async function promptInline(ctx: ExtensionContext, title: string, question: string, signal?: AbortSignal): Promise<string | null> {
 if (signal?.aborted) return null;
 return ctx.ui.custom<string | null>((tui, theme, kb, done) => {
  const editor = new Editor(tui, { borderColor: (text) => theme.fg("accent", text), selectList: {
   selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text), description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text),
  } });
  let closed = false;
  const finish = (value: string | null) => { if (!closed) { closed = true; done(value); } };
  const abort = () => finish(null);
  signal?.addEventListener("abort", abort, { once: true });
  editor.onSubmit = (text) => { if (text.trim()) finish(text.trim()); };
  return {
   focused: false,
   dispose() { closed = true; signal?.removeEventListener("abort", abort); },
   invalidate() { editor.invalidate(); },
   render(width: number) { editor.focused = "focused" in this && this.focused === true; const inner = Math.max(1, width - 4); return panel(theme, width, title, [...wrapTextWithAnsi(safeText(question), inner).slice(0, 3), null, ...editor.render(inner)], "Enter submit · Shift+Enter newline · Esc cancel"); },
   handleInput(data: string) { if (closed) return; if (kb.matches(data, "tui.select.cancel")) finish(null); else editor.handleInput(data); tui.requestRender(); },
  };
 });
}
