import type { Theme } from "@earendil-works/pi-coding-agent";
import { colorToRgb, foregroundAnsi, rgbColor } from "@earendil-works/pi-tui";

export const MAX_COLUMNS = 60;
export const MAX_ROWS = 22;

// Original HΠ silhouette: four equal stems, a midpoint crossbar, and a square cap.
const rects = [
 { left: -1.75, top: -.9, right: -1.49, bottom: .9 },
 { left: -.46, top: -.9, right: -.2, bottom: .9 },
 { left: -1.49, top: -.13, right: -.46, bottom: .13 },
 { left: .2, top: -.9, right: .46, bottom: .9 },
 { left: .46, top: -.9, right: 1.49, bottom: -.64 },
 { left: 1.49, top: -.9, right: 1.75, bottom: .9 },
];

function ink(theme: Theme): string {
 const fg = colorToRgb(theme.colors.text), accent = colorToRgb(theme.colors.accent);
 const bg = colorToRgb(theme.colors.userMessageBg);
 const sage = { r: 115, g: 151, b: 129 };
 const channel = (key: "r" | "g" | "b") => {
  const pigment = sage[key] * .65 + accent[key] * .15 + fg[key] * .2;
  return Math.round(bg[key] + (pigment - bg[key]) * .665);
 };
 return foregroundAnsi(rgbColor(channel("r"), channel("g"), channel("b")), theme.getColorMode());
}

/** Static, centered HΠ on a bounded, theme-aware Braille canvas. */
export function renderMark(columns: number, rows: number, theme: Theme): string[] {
 if (!Number.isFinite(columns) || !Number.isFinite(rows)) return [];
 const width = Math.min(MAX_COLUMNS, Math.max(0, Math.floor(columns)));
 const height = Math.min(MAX_ROWS, Math.max(0, Math.floor(rows)));
 if (width < 18 || height < 6) return [];
 const w = width * 2, h = height * 4;
 const scale = Math.min((w - 10) / 3.65, (h - 8) / 2.1);
 const pixels = new Uint8Array(w * h);
 for (const rect of rects) {
  const cx = w / 2 + (rect.left + rect.right) / 2 * scale;
  const cy = h / 2 + (rect.top + rect.bottom) / 2 * scale;
  // Keep stems visible between subpixel centers even on the smallest canvas.
  const rx = Math.max(.5, (rect.right - rect.left) * scale / 2);
  const ry = Math.max(.5, (rect.bottom - rect.top) * scale / 2);
  const left = Math.max(0, Math.ceil(cx - rx - .5)), end = Math.min(w - 1, Math.floor(cx + rx - .5));
  const top = Math.max(0, Math.ceil(cy - ry - .5)), bottom = Math.min(h - 1, Math.floor(cy + ry - .5));
  for (let y = top; y <= bottom; y++) pixels.fill(1, y * w + left, y * w + end + 1);
 }
 const color = ink(theme), lines: string[] = [];
 const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
 for (let row = 0; row < height; row++) {
  let line = "", colored = false;
  for (let col = 0; col < width; col++) {
   let mask = 0;
   for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) {
    if (pixels[(row * 4 + y) * w + col * 2 + x]) mask |= bits[y][x];
   }
   if (!mask) { line += " "; continue; }
   if (!colored) { line += color; colored = true; }
   line += String.fromCharCode(0x2800 + mask);
  }
  lines.push(line.trimEnd() + (colored ? "\x1b[39m" : ""));
 }
 return lines;
}
