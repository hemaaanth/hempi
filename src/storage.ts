import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** Exclusive cross-process update; a crashed lock is reported, never guessed away. */
export async function updateJson(file: string, update: (previous: unknown) => unknown): Promise<void> {
 await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
 const lock = `${file}.lock`;
 let owner: fs.FileHandle | undefined;
 const deadline = Date.now() + 5000;
 while (!owner) {
  try { owner = await fs.open(lock, "wx", 0o600); }
  catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
   if (Date.now() >= deadline) throw new Error(`Configuration is locked: ${lock}. If no other Pi is saving it, inspect and remove the stale lock.`);
   await new Promise((resolve) => setTimeout(resolve, 25));
  }
 }
 const temporary = `${file}.${randomUUID()}.tmp`;
 try {
  await owner.writeFile(JSON.stringify({ pid: process.pid, time: Date.now() }));
  let previous: unknown = {};
  try { previous = JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(update(previous), null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
 } finally {
  await owner.close();
  await fs.rm(temporary, { force: true });
  await fs.rm(lock, { force: true });
 }
}
