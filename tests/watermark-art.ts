import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import { MAX_COLUMNS, MAX_ROWS, renderMark } from "../src/watermark-art.ts";

const theme = (light = false) => ({
 colors: {
  text: light ? rgbColor(35, 40, 38) : rgbColor(220, 224, 218),
  accent: light ? rgbColor(60, 110, 85) : rgbColor(140, 190, 165),
  userMessageBg: light ? rgbColor(245, 242, 235) : rgbColor(24, 29, 26),
 },
 getColorMode: () => "truecolor",
} as unknown as Theme);
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
function raster(lines: string[], width = 60) {
 const pixels = Array.from({ length: lines.length * 4 }, () => Array<boolean>(width * 2).fill(false));
 lines.map(strip).forEach((line, row) => [...line].forEach((char, col) => {
  const mask = char.charCodeAt(0) - 0x2800;
  if (mask < 0) return;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) pixels[row * 4 + y][col * 2 + x] = !!(mask & bits[y][x]);
 }));
 const spans: [number, number][] = [];
 for (let x = 0; x < width * 2; x++) {
  if (!pixels.some(row => row[x])) continue;
  const left = x;
  while (x + 1 < width * 2 && pixels.some(row => row[x + 1])) x++;
  spans.push([left, x]);
 }
 const ys = pixels.flatMap((row, y) => row.some(Boolean) ? [y] : []);
 const top = Math.min(...ys), bottom = Math.max(...ys), mid = Math.round((top + bottom) / 2);
 return { pixels, spans, top, bottom, mid };
}

export default function () {
 const dark = theme(), frame = renderMark(60, 22, dark);
 assert.equal(frame.length, MAX_ROWS);
 assert.deepEqual(frame, renderMark(60, 22, dark), "static deterministic watermark");
 assert.notDeepEqual(frame, renderMark(60, 22, theme(true)), "theme colors stay live");
 assert.deepEqual(frame.map(strip), renderMark(60, 22, theme(true)).map(strip));
 assert.ok(frame.some(line => /\x1b\[38;2;/.test(line)));
 assert.ok(frame.map(strip).every(line => /^[ \u2801-\u28ff]*$/.test(line)));
 for (const columns of [0, 1, 17, 18, 25, 40, 60, 80, 500]) {
  for (const rows of [0, 1, 5, 6, 12, 22, 50]) {
   const lines = renderMark(columns, rows, dark);
   assert.ok(lines.length <= Math.min(rows, MAX_ROWS));
   assert.ok(lines.every(line => visibleWidth(line) <= Math.min(columns, MAX_COLUMNS)));
   if (columns < 18 || rows < 6) assert.deepEqual(lines, []);
  }
 }
 for (const [columns, rows] of [[NaN, 22], [60, Infinity], [-1, 22]]) assert.deepEqual(renderMark(columns, rows, dark), []);
 const { pixels, spans, top, bottom, mid } = raster(frame);
 assert.equal(spans.length, 2, "original HΠ silhouette, no extra letters");
 const [h, pi] = spans, hx = Math.round((h[0] + h[1]) / 2), px = Math.round((pi[0] + pi[1]) / 2);
 assert.ok(pixels[mid][hx], "H has its midpoint crossbar");
 assert.ok(!pixels[top][hx] && !pixels[bottom][hx]);
 assert.ok(pixels[top][px], "Π has its original top bar");
 assert.ok(!pixels[mid][px] && !pixels[bottom][px]);
 const stems: number[] = [];
 for (const [left, right] of spans) {
  assert.ok(pixels[top][left] && pixels[top][right], "square top corners");
  assert.ok(pixels[bottom][left] && pixels[bottom][right], "square bottom corners");
  let a = left, b = right;
  while (pixels[bottom][a]) a++;
  while (pixels[bottom][b]) b--;
  stems.push(a - left, right - b);
 }
 assert.ok(Math.max(...stems) - Math.min(...stems) <= 1, "four equal stems");
 assert.ok(Math.abs((h[1] - h[0]) - (pi[1] - pi[0])) <= 1, "matched glyph widths");
 assert.ok(Math.abs(spans[0][0] - (119 - spans[1][1])) <= 1, "centered horizontally");
 assert.ok(Math.abs(top - (87 - bottom)) <= 1, "centered vertically");
 const narrow = raster(renderMark(18, 6, dark), 18);
 assert.equal(narrow.spans.length, 2);
 for (const [left, right] of narrow.spans) {
  for (let y = narrow.top; y <= narrow.bottom; y++) assert.ok(narrow.pixels[y][left] && narrow.pixels[y][right], "narrow stems stay continuous");
 }
 console.error("watermark-art: static HΠ silhouette, bounds, centering and themes passed");
}
