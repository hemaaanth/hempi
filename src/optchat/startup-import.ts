import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { record } from './cache.ts';
import { type Memory, type Compressor } from './memory.ts';
import { prepareImport, runImport } from './import/job.ts';
import { readConversation } from './import/sources.ts';

export class ImportError extends Error {}

/** Startup imports fail closed; the interactive importer may instead skip damaged rows. */
export async function importSession(dir: string, memory: Memory, file: string, compress: Compressor) {
  try {
    const path = resolve(file);
    const rows: unknown[] = readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const header = rows[0];
    if (!record(header) || header.type !== 'session' || typeof header.id !== 'string'
      || typeof header.timestamp !== 'string' || !rows.every(record)) throw new Error('not a Pi session file');
    if (rows.some(row => row.type === 'custom' && String(row.customType).startsWith('optchat.')))
      throw new Error('session already belongs to OptChat');
    const { entries, warnings } = await readConversation({ source: 'pi', id: header.id, file: path,
      title: header.id, project: typeof header.cwd === 'string' ? header.cwd : '', date: header.timestamp, size: 0 });
    if (warnings.length) throw new Error(warnings.join('; '));
    await memory.close();
    if (!prepareImport(dir, memory, entries, 'append')) return;
    const controller = new AbortController();
    // The interactive path retries until cancelled. Startup must report a failed compressor instead.
    await runImport(dir, compress, controller.signal, undefined, state => {
      if (state.error) controller.abort(new Error(state.error));
    });
  } catch (error) {
    throw new ImportError(error instanceof Error ? error.message : String(error));
  }
}
