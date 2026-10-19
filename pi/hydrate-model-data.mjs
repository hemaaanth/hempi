import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
/** Fetch only the immutable, hash-pinned catalog committed with this upstream tag. */
export async function hydrate(source, { fetcher = fetch, run = exec } = {}) {
 const { revision } = JSON.parse(await fs.readFile(path.join(source, 'nix/model-catalog.json'), 'utf8'));
 if (typeof revision !== 'string' || !/^sha256-[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid upstream model catalog pin');
 const response = await fetcher(`https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`, { signal: AbortSignal.timeout(30000) });
 if (!response.ok) throw new Error(`Pinned model catalog unavailable: ${response.status}`);
 const bytes = Buffer.from(await response.arrayBuffer());
 if (`sha256-${createHash('sha256').update(bytes).digest('hex')}` !== revision) throw new Error('Pinned model catalog checksum mismatch');
 const file = path.join(source, `.hempi-catalog-${randomUUID()}.json`);
 try {
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  await run(process.execPath, [path.join(source, 'packages/ai/scripts/hydrate-model-catalog.ts'), file], { cwd: source, timeout: 60000, env: process.env });
 } finally { await fs.rm(file, { force: true }); }
 return revision;
}
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => undefined) === fileURLToPath(import.meta.url)) {
 if (process.argv.length !== 3) throw new Error('Usage: hydrate-model-data.mjs SOURCE_DIRECTORY');
 console.log(await hydrate(path.resolve(process.argv[2])));
}
