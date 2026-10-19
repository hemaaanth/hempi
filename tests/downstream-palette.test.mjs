import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

const palette = JSON.parse(await readFile(new URL('../pi/theme/hempi.json', import.meta.url), 'utf8'));
function rgb(value, seen = new Set()) {
 if (typeof value !== 'string' || seen.has(value)) throw new Error('Invalid theme color');
 if (/^#[a-f0-9]{6}$/i.test(value)) return [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255);
 seen.add(value); return rgb(palette.vars[value], seen);
}
function luminance(value) {
 const linear = rgb(value).map(component => component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4);
 return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(a, b) {
 const [light, dark] = [luminance(a), luminance(b)].sort((a, b) => b - a);
 return (light + 0.05) / (dark + 0.05);
}

test('compact user palette has readable text/role marker and a distinct neutral strip', () => {
 const background = palette.colors.userMessageBg;
 assert.ok(contrast(background, palette.export.pageBg) >= 1.5, 'input strip must visibly separate from the intended page background');
 assert.ok(contrast(palette.colors.userMessageText, background) >= 7, 'body text must remain highly readable');
 assert.ok(contrast(palette.colors.accent, background) >= 4.5, 'role marker must contrast against the input strip');
 const channels = rgb(background);
 assert.ok(Math.max(...channels) - Math.min(...channels) < 0.05, 'strip should be neutral charcoal, not another green panel');
 assert.equal(palette.colors.customMessageBg, 'panel', 'other panels retain their palette');
});
