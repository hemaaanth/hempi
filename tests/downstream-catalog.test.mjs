import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { hydrate } from '../pi/hydrate-model-data.mjs';

test('model hydration uses the tagged immutable catalog and verifies bytes before invoking upstream code', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hempi-catalog-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
 await fs.mkdir(path.join(root, 'nix'));
 const bytes = Buffer.from('{"fixture":[]}'), revision = `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
 await fs.writeFile(path.join(root, 'nix/model-catalog.json'), JSON.stringify({ revision }));
 let calls = 0, file;
 const fetcher = async (url, options) => {
  assert.equal(url, `https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`);
  assert.ok(options.signal instanceof AbortSignal); return { ok: true, arrayBuffer: async () => bytes };
 };
 const run = async (command, args, options) => {
  calls++; assert.equal(command, process.execPath); assert.equal(options.cwd, root);
  assert.equal(args[0], path.join(root, 'packages/ai/scripts/hydrate-model-catalog.ts'));
  file = args[1]; assert.deepEqual(await fs.readFile(file), bytes);
 };
 assert.equal(await hydrate(root, { fetcher, run }), revision); assert.equal(calls, 1);
 await assert.rejects(fs.access(file), { code: 'ENOENT' });
 await assert.rejects(hydrate(root, { fetcher: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('bad') }), run }), /checksum/);
 await assert.rejects(hydrate(root, { fetcher: async () => ({ ok: false, status: 404 }), run }), /404/);
 assert.equal(calls, 1);
 await fs.writeFile(path.join(root, 'nix/model-catalog.json'), '{"revision":"latest"}');
 await assert.rejects(hydrate(root, { fetcher, run }), /Invalid/);
});
