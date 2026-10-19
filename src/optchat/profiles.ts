import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelChoice } from './compactor.ts';
import { record } from './cache.ts';
import { atomicWrite, type Store } from './store.ts';
import { DEFAULT_SETTINGS, readSettings, type Settings } from './settings.ts';

export const isWindows = process.platform === 'win32';
const PIPE_PREFIX = '\\\\.\\pipe\\';

export const dataHome = () => resolve(process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat'));
export interface ProfileConfig extends Settings { compactor: ModelChoice; subagent: ModelChoice }
export const defaults: ProfileConfig = {
  compactor: { provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'low' },
  subagent: { provider: 'openai-codex', model: 'gpt-6-sol', thinking: 'medium' },
  ...DEFAULT_SETTINGS,
};
export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export function profilePath(name: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Profile names: 1–64 lowercase letters, digits, hyphens, or underscores.');
  return join(dataHome(), 'profiles', name);
}
export function listProfiles() {
  const root = join(dataHome(), 'profiles');
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(f => f.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.name)).map(f => f.name).sort() : [];
}
export function createProfile(name: string, text = `Instructions for ${name}.\n`) {
  const dir = profilePath(name);
  if (existsSync(dir)) throw new Error(`Profile already exists: ${name}`);
  mkdirSync(resolve(dir, '..'), { recursive: true, mode: 0o700 });
  // Claim the directory exclusively, so a competing creator cannot have its
  // profile overwritten or removed by this attempt's cleanup.
  mkdirSync(dir, { mode: 0o700 });
  try {
    saveConfig(dir, defaults);
    atomicWrite(join(dir, 'AGENTS.md'), text);
  } catch (error) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
    catch { throw new Error(`Failed to create profile ${name}, and could not remove its incomplete directory: ${dir}`, { cause: error }); }
    throw error;
  }
}
export function saveConfig(dir: string, config: ProfileConfig) { atomicWrite(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n'); }
function modelChoice(value: unknown): value is ModelChoice {
  return record(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    && THINKING.some(level => level === value.thinking);
}
export function loadConfig(dir: string): ProfileConfig {
  const value: unknown = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  if (!record(value) || !modelChoice(value.compactor) || !modelChoice(value.subagent)) throw new Error(`Invalid profile config: ${dir}/config.json`);
  try { return { compactor: value.compactor, subagent: value.subagent, ...readSettings(value) }; }
  catch (error) { throw new Error(`Invalid profile config: ${dir}/config.json: ${error instanceof Error ? error.message : String(error)}`); }
}
export function instructions(dir: string) { return readFileSync(join(dir, 'AGENTS.md'), 'utf8'); }
export function lastProfile() {
  try { const name = readFileSync(join(dataHome(), 'last-profile'), 'utf8').trim(); return listProfiles().includes(name) ? name : undefined; }
  catch { return undefined; }
}
export function rememberProfile(name: string) { atomicWrite(join(dataHome(), 'last-profile'), name); }

export class ProfileBusyError extends Error {
  constructor(readonly owner: string) { super(`Profile already running: ${owner}`); }
}
export const REMOTE_PENDING_FILE = 'remote-pending.json';
export class ProfileRecoveryError extends Error {
  readonly exitCode = 73;
  constructor(profile: string, location: string, cause?: unknown) {
    super(`optchat: profile ${profile} requires remote memory recovery. Retained copy: ${location}. Restore the host connection and resume the remote-memory integration for ${profile} to recover it; do not delete ${REMOTE_PENDING_FILE}.`, { cause });
  }
}
function assertProfileReady(dir: string, profile: string) {
  const file = join(dir, REMOTE_PENDING_FILE);
  let stat: Stats;
  try { stat = lstatSync(file); }
  catch (error) {
    if (record(error) && error.code === 'ENOENT') return;
    throw new ProfileRecoveryError(profile, `unreadable recovery marker ${file}`, error);
  }
  try {
    if (!stat.isFile() || stat.size > 16_384) throw new Error('Invalid recovery marker file.');
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!record(value) || !['hostId', 'operationId', 'directory'].every(key => typeof value[key] === 'string' && value[key].trim())) throw new Error('Invalid recovery marker fields.');
    throw new ProfileRecoveryError(profile, `${value.directory} on ${value.hostId} (operation ${value.operationId})`);
  } catch (error) {
    if (error instanceof ProfileRecoveryError) throw error;
    throw new ProfileRecoveryError(profile, `invalid or unreadable recovery marker ${file}`, error);
  }
}
/** Linux locks use the kernel's abstract namespace: no stale file to mistake for a dead owner in Bun. The private window bridge stays in the profile directory. Windows uses named pipes. */
export function profileSocket(dir: string, purpose: 'lock' | 'windows' = 'lock') {
  let identity = resolve(dir); try { identity = realpathSync.native(identity); } catch {}
  if (process.platform === 'linux' && purpose === 'lock') {
    return `\0optchat-${createHash('sha256').update(identity).digest('hex')}-lock`;
  }
  if (!isWindows) return join(dir, `${purpose}.sock`);
  // Different casing, junctions and symlinks to one Windows profile share a pipe.
  return `${PIPE_PREFIX}optchat-${createHash('sha256').update(identity.toLowerCase()).digest('hex').slice(0, 16)}-${purpose}`;
}

// sun_path is 104 bytes on macOS and 108 elsewhere, both including the NUL; a Windows named pipe path is capped at 259 characters, which for the ASCII names OptChat generates is also its byte length. Node 22 binds a truncated socket instead of failing, so the length is checked before listen.
export const SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 103 : isWindows ? 259 : 107;
export function checkSocketPath(path: string) {
  const length = Buffer.byteLength(path);
  if (length > SOCKET_PATH_LIMIT) throw new Error(`Cannot listen on the profile socket: its path is ${length} bytes, over this system's limit of ${SOCKET_PATH_LIMIT}. Set OPTCHAT_HOME to a shorter directory: ${path}`);
}

/** Only filesystem sockets may be removed. Abstract sockets and Windows pipes live until their owner closes them. */
function existingSocket(path: string): { stat: Stats; removable: true } | { removable: false } | undefined {
  if (isWindows || path.startsWith('\0')) return { removable: false };
  let stat; try { stat = lstatSync(path); } catch { return undefined; }
  if (!stat.isSocket()) throw new Error(`${path} is not an OptChat socket. Move it out of the profile and try again.`);
  return { stat, removable: true };
}
/** Removes a dead socket left by a previous owner. */
export function removeStaleSocket(path: string) { if (existingSocket(path)?.removable) unlinkSync(path); }

/** Asks the current owner; a refused or missing endpoint has no listener. */
function readOwner(path: string) {
  return new Promise<string | undefined>((resolve, reject) => {
    const socket = createConnection(path); let message = '', owner: string | undefined, failure: Error | undefined;
    socket.setTimeout(1500, () => { failure = new Error('Profile lock did not respond; refusing to steal it.'); socket.destroy(); });
    socket.on('data', data => { message += data.toString(); });
    socket.on('end', () => { owner = message || 'another Pi instance'; });
    socket.on('error', error => { if (!('code' in error) || (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT')) failure = error; });
    socket.on('close', () => { if (failure) reject(failure); else resolve(owner); });
  });
}

/** OS-owned socket lifetime, no timeout-based stealing of a busy profile. */
export async function lockProfile(dir: string, description: string) {
  const socketPath = profileSocket(dir); checkSocketPath(socketPath);
  const server = createServer(socket => { socket.on('error', () => socket.destroy()); socket.end(description); });
  const listen = () => new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(socketPath);
  });
  if (existingSocket(socketPath)) {
    const owner = await readOwner(socketPath);
    if (owner !== undefined) throw new ProfileBusyError(owner);
  }
  try { await listen(); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    const before = existingSocket(socketPath);
    if (!before) throw new Error('Profile lock changed; try again.');
    const owner = await readOwner(socketPath);
    if (owner !== undefined) throw new ProfileBusyError(owner);
    if (before.removable) {
      if (statSync(socketPath).ino !== before.stat.ino) throw new Error('Profile lock changed; try again.');
      unlinkSync(socketPath);
    }
    await listen();
  }
  const unlock = () => new Promise<void>(resolve => server.close(() => resolve()));
  if (!isWindows && !socketPath.startsWith('\0')) { try { chmodSync(socketPath, 0o600); } catch (error) { await unlock(); throw error; } }
  return unlock;
}

/** How often a held lease is renewed; a store lets one lapse after about 30 seconds without renewal. */
export const HEARTBEAT_MS = 10_000;
/** Holds the profile until the returned function is called: through the store's lease if it has one, else the machine-local lock. */
export async function holdProfile(store: Pick<Store, 'lock'>, dir: string, profile: string, description: string, warn: (text: string) => void) {
  const { lock } = store;
  let release: () => Promise<void>;
  if (!lock) release = await lockProfile(dir, description);
  else {
    const owner = await lock.lease(profile, description);
    if (owner !== undefined) throw new ProfileBusyError(owner);
    release = () => lock.release();
  }
  // Check under the native lock: a remote-memory worker can leave this marker after it dies.
  try { assertProfileReady(dir, profile); }
  catch (error) { await release(); throw error; }
  if (!lock) return release;
  const beat = setInterval(() => {
    lock.heartbeat().catch((error: unknown) => { warn(`Could not renew the profile lease: ${error instanceof Error ? error.message : String(error)}`); });
  }, HEARTBEAT_MS);
  beat.unref();
  return async () => { clearInterval(beat); await release(); };
}
