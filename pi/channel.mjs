#!/usr/bin/env node
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { buildCandidate, inputDigest, latestVersion, stableVersion } from './build.mjs';

const exec = promisify(execFile);
export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = root => path.join(root, '.pi-runtime');
const inside = (base, value) => value.startsWith(base + path.sep);
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function optional(file, read) {
 try { return await read(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function atomicText(file, value) {
 const temporary = `${file}.${randomUUID()}.tmp`;
 try {
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
 } finally { await fs.rm(temporary, { force: true }); }
}
const atomicJson = (file, value) => atomicText(file, JSON.stringify(value, null, 2) + '\n');
async function atomicLink(file, directory) {
 const temporary = `${file}.${randomUUID()}.tmp`;
 try { await fs.symlink(directory, temporary); await fs.rename(temporary, file); }
 finally { await fs.rm(temporary, { force: true }); }
}
async function withLock(root, operation) {
 const directory = runtime(root);
 await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700);
 let compromised;
 const release = await lockfile.lock(directory, { stale: 300000, update: 30000, onCompromised(error) { compromised = error; } });
 try { return await operation(() => { if (compromised) throw compromised; }); }
 finally { await release(); }
}
export async function verifiedRelease(root, directory) {
 directory = await fs.realpath(directory);
 if (!inside(path.join(runtime(root), 'releases'), directory)) throw new Error('Release is outside the managed release directory');
 const manifest = await readJson(path.join(directory, 'build.json'));
 if (manifest.format !== 1 || manifest.validated !== true || !/^[a-f0-9]{40}$/.test(manifest.upstreamCommit) || !/^[a-f0-9]{64}$/.test(manifest.inputDigest)) throw new Error('Release has no valid verification manifest');
 stableVersion(manifest.upstreamVersion);
 const binary = path.join(directory, 'pi/pi'); await fs.access(binary, constants.X_OK);
 if (typeof manifest.binarySha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.binarySha256)) throw new Error('Release has no valid binary checksum');
 const sum = createHash('sha256').update(await fs.readFile(binary)).digest('hex');
 if (sum !== manifest.binarySha256.toLowerCase()) throw new Error('Release binary checksum mismatch');
 return { directory, manifest };
}
async function selected(root, name) {
 const link = path.join(runtime(root), name);
 // A dangling link is damage, not an absent installation.
 if (!(await optional(link, fs.lstat))) return undefined;
 return verifiedRelease(root, link);
}
export async function status(root = ROOT) {
 return { current: await selected(root, 'current'), previous: await selected(root, 'previous'),
  paused: Boolean(await optional(path.join(runtime(root), 'paused'), fs.lstat)),
  lastFailure: await optional(path.join(runtime(root), 'last-failure.json'), readJson) };
}
export async function update(root = ROOT, { version, force = false, scheduled = false, build = buildCandidate, latest = latestVersion, digest = inputDigest } = {}) {
 return withLock(root, async checkLock => {
  if (scheduled && await optional(path.join(runtime(root), 'paused'), fs.lstat)) return { paused: true };
  try {
   const current = await selected(root, 'current');
   const requested = stableVersion(version ?? await latest());
   const inputs = await digest(root);
   if (!force && current?.manifest.upstreamVersion === requested && current.manifest.inputDigest === inputs) return { unchanged: true, ...current };
   const candidate = await build(root, { version: requested, force });
   const checked = await verifiedRelease(root, candidate.directory);
   if (checked.manifest.inputDigest !== await digest(root)) throw new Error('Inputs changed before promotion');
   checkLock();
   if (current) await atomicLink(path.join(runtime(root), 'previous'), current.directory);
   await atomicLink(path.join(runtime(root), 'current'), checked.directory);
   await fs.rm(path.join(runtime(root), 'last-failure.json'), { force: true });
   return { promoted: true, ...checked };
  } catch (error) {
   await atomicJson(path.join(runtime(root), 'last-failure.json'), { at: new Date().toISOString(), error: error.message });
   throw error;
  }
 });
}
const systemdString = value => '"' + value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/[\r\n]/g, '') + '"';
async function commandOnPath(name) {
 for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
  if (!path.isAbsolute(directory)) continue;
  const command = path.join(directory, name);
  try { await fs.access(command, constants.X_OK); return command; } catch {}
 }
 throw new Error(`Required command not found: ${name}`);
}
async function unitPlan(root, commands, home) {
 if (/[\0\r\n]/.test(root)) throw new Error('Repository path contains invalid systemd characters');
 const tools = [...new Set([...commands.map(file => path.dirname(file)), '/usr/bin', '/bin'])].join(':');
 const units = [];
 for (const name of ['hempi-pi-update.service', 'hempi-pi-update.timer']) {
  const target = path.join(home, '.config/systemd/user', name);
  const previous = await optional(target, file => fs.readFile(file, 'utf8'));
  if (previous !== undefined && !previous.startsWith('# Managed by Hempi Pi channel')) throw new Error(`Refusing to overwrite unmanaged unit: ${target}`);
  const template = await fs.readFile(path.join(root, 'pi/systemd', name), 'utf8');
  const content = template.replaceAll('@NODE@', systemdString(commands[0])).replaceAll('@ROOT@', root.replaceAll('%', '%%')).replaceAll('@SCRIPT@', systemdString(path.join(root, 'pi/channel.mjs'))).replaceAll('@PATH@', systemdString(`PATH=${tools}`));
  units.push({ name, target, previous, content });
 }
 return units;
}
async function unitState(run, name, query) {
 let result;
 try { result = await run('systemctl', ['--user', query, name]); }
 catch (error) {
  if (![1, 3, 4].includes(error.code) || !error.stdout) throw error;
  result = error;
 }
 const state = result.stdout.trim();
 const allowed = query === 'is-enabled' ? ['enabled', 'enabled-runtime', 'disabled', 'static', 'not-found'] : ['active', 'inactive', 'failed'];
 if (!allowed.includes(state)) throw new Error(`Unsupported ${query} state for ${name}: ${state}`);
 return state;
}
async function restoreFile(file, content) {
 if (content === undefined) await fs.rm(file, { force: true });
 else await atomicText(file, content);
}
function channelSelection(root) { return `path:${path.join(runtime(root), 'install')}`; }
function normalizeSelection(value, home) {
 if (value.startsWith('path:~/')) return `path:${path.join(home, value.slice(7))}`;
 return value;
}
async function globalPi(run, home) {
 const rows = JSON.parse((await run('mise', ['ls', '--current', '--json', 'pi'])).stdout);
 const active = rows.find(row => row.active);
 if (!active || typeof active.requested_version !== 'string' || !active.requested_version || active.source?.path !== path.join(home, '.config/mise/config.toml')) throw new Error('Pi must be selected in the global mise config before setup');
 return { ...active, requested_version: normalizeSelection(active.requested_version, home) };
}
function validBaseline(saved, channel) {
 return typeof saved?.originalPi === 'string' && saved.originalPi.length > 0 && saved.originalPi !== channel;
}
export async function setup(root = ROOT, { run = (cmd, args) => exec(cmd, args, { cwd: root, timeout: 30000 }), home = os.homedir(), commands: suppliedCommands } = {}) {
 return withLock(root, async checkLock => {
  const current = await selected(root, 'current');
  if (!current) throw new Error('Build and validate Pi with update before setup');
  const savedPath = path.join(runtime(root), 'integration.json');
  const savedText = await optional(savedPath, file => fs.readFile(file, 'utf8'));
  const saved = savedText === undefined ? undefined : JSON.parse(savedText);
  const channel = channelSelection(root);
  const active = await globalPi(run, home);
  const backupPath = path.join(runtime(root), 'mise-before.toml');
  const backup = await optional(backupPath, file => fs.readFile(file, 'utf8'));
  const alreadySelected = active.requested_version === channel;
  if (alreadySelected && (!validBaseline(saved, channel) || backup === undefined)) throw new Error('Channel selection has no valid original mise baseline');
  const baseline = alreadySelected ? saved : { originalPi: active.requested_version, originalVersion: active.version };
  const config = alreadySelected ? backup : await fs.readFile(path.join(home, '.config/mise/config.toml'), 'utf8');
  const commands = suppliedCommands ?? await Promise.all(['node', 'npm', 'bun', 'mise', 'git'].map(commandOnPath));
  const units = await unitPlan(root, commands, home);
  for (const unit of units) {
   unit.enabled = await unitState(run, unit.name, 'is-enabled');
   unit.active = await unitState(run, unit.name, 'is-active');
  }
  // Aqua does not reliably discover bins through a symlinked install root. Keep a
  // real layout directory with just a native-executable symlink, never a wrapper.
  const binDirectory = path.join(runtime(root), 'install/pi');
  await fs.mkdir(binDirectory, { recursive: true, mode: 0o700 });
  const binLink = path.join(binDirectory, 'pi');
  const oldLink = await optional(binLink, fs.lstat);
  if (oldLink && !oldLink.isSymbolicLink()) throw new Error('Managed executable path is not a symlink');
  await atomicLink(binLink, path.join(runtime(root), 'current/pi/pi'));
  const changed = [];
  let miseChanged = false, timerChanged = false, metadataChanged = false;
  checkLock();
  try {
   miseChanged = true;
   await run('mise', ['use', '--global', `pi@${channel}`]);
   const probe = await run('mise', ['exec', '--', 'pi', '--version']);
   if (probe.stdout.trim() !== current.manifest.upstreamVersion) throw new Error('Selected Pi does not match the verified candidate');
   await fs.mkdir(path.dirname(units[0].target), { recursive: true });
   for (const unit of units) {
    if (unit.content === unit.previous) continue;
    await atomicText(unit.target, unit.content);
    changed.push(unit);
   }
   await run('systemctl', ['--user', 'daemon-reload']);
   timerChanged = true;
   await run('systemctl', ['--user', 'enable', '--now', units[1].name]);
   metadataChanged = true;
   if (!alreadySelected) await atomicText(backupPath, config);
   await atomicJson(savedPath, { ...baseline, active: true });
   await fs.rm(path.join(runtime(root), 'paused'), { force: true });
   return { configured: true, ...current };
  } catch (error) {
   const failures = [error];
   const undo = async operation => { try { await operation(); } catch (failure) { failures.push(failure); } };
   for (const unit of changed.reverse()) await undo(() => restoreFile(unit.target, unit.previous));
   if (changed.length) await undo(() => run('systemctl', ['--user', 'daemon-reload']));
   if (timerChanged) {
    for (const unit of [...units].reverse()) {
     await undo(async () => {
      const enabled = await unitState(run, unit.name, 'is-enabled');
      if (enabled.startsWith('enabled') !== unit.enabled.startsWith('enabled') || (enabled.startsWith('enabled') && enabled !== unit.enabled)) {
       // Clear persistent enablement too before restoring a runtime-only timer.
       await run('systemctl', ['--user', 'disable', unit.name]);
       if (unit.enabled.startsWith('enabled')) await run('systemctl', ['--user', 'enable', ...(unit.enabled === 'enabled-runtime' ? ['--runtime'] : []), unit.name]);
      }
     });
     await undo(async () => {
      const active = await unitState(run, unit.name, 'is-active');
      if ((active === 'active') !== (unit.active === 'active')) await run('systemctl', ['--user', unit.active === 'active' ? 'start' : 'stop', unit.name]);
     });
    }
   }
   if (miseChanged) await undo(() => run('mise', ['use', '--global', `pi@${active.requested_version}`]));
   if (metadataChanged) {
    await undo(() => restoreFile(savedPath, savedText));
    await undo(() => restoreFile(backupPath, backup));
   }
   if (failures.length > 1) throw new AggregateError(failures, 'Setup failed and restoration was incomplete', { cause: error });
   throw error;
  }
 });
}
export async function stock(root = ROOT, { run = (cmd, args) => exec(cmd, args, { cwd: root, timeout: 60000 }), home = os.homedir() } = {}) {
 return withLock(root, async () => {
  const saved = await readJson(path.join(runtime(root), 'integration.json'));
  const channel = channelSelection(root);
  if (!validBaseline(saved, channel)) throw new Error('Original mise selection is missing');
  const active = await globalPi(run, home);
  if (active.requested_version !== channel) throw new Error('Pi is no longer selected from this channel; refusing to replace the user selection');
  await run('systemctl', ['--user', 'disable', '--now', 'hempi-pi-update.timer']);
  await run('mise', ['use', '--global', `pi@${saved.originalPi}`]);
  await atomicJson(path.join(runtime(root), 'integration.json'), { ...saved, active: false });
  return { stock: true, selection: saved.originalPi };
 });
}
export async function rollback(root = ROOT) {
 return withLock(root, async checkLock => {
  const previous = await selected(root, 'previous');
  if (!previous) throw new Error('No previous validated build is available; use stock to return to upstream');
  // A damaged current release must not prevent recovery or replace the good previous.
  let current;
  try { current = await selected(root, 'current'); }
  catch (error) {
   if (error.code && !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  }
  checkLock();
  await atomicJson(path.join(runtime(root), 'paused'), { reason: 'Manual rollback', at: new Date().toISOString() });
  await atomicLink(path.join(runtime(root), 'current'), previous.directory);
  if (current) await atomicLink(path.join(runtime(root), 'previous'), current.directory);
  return { rolledBack: true, ...previous };
 });
}

export async function main(args = process.argv.slice(2), root = ROOT) {
 const [action = 'status', ...rest] = args;
 if (action === 'update') {
  let version, force = false;
  for (let i = 0; i < rest.length; i++) {
   if (rest[i] === '--force') force = true;
   else if (rest[i] === '--version' && rest[i + 1]) version = stableVersion(rest[++i]);
   else throw new Error('Usage: update [--version X.Y.Z] [--force]');
  }
  return update(root, { version, force, scheduled: process.env.HEMPI_PI_SCHEDULED === '1' });
 }
 if (rest.length) throw new Error('Unexpected arguments');
 if (action === 'status') return status(root);
 if (action === 'setup') return setup(root);
 if (action === 'rollback') return rollback(root);
 if (action === 'stock') return stock(root);
 if (action === 'resume') {
  await fs.rm(path.join(runtime(root), 'paused'), { force: true }); return { resumed: true };
 }
 throw new Error('Commands: update, status, setup, rollback, resume, stock');
}
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => undefined) === fileURLToPath(import.meta.url)) {
 main().then(result => console.log(JSON.stringify(result, null, 2)), async error => {
  console.error(`Hempi Pi channel: ${error.code === 'ELOCKED' ? 'Another update is already running' : error.message}`);
  if (process.env.HEMPI_PI_SCHEDULED === '1') await exec('notify-send', ['Pi update blocked', 'The last working build is still selected. Check systemctl --user status hempi-pi-update.service and the Hempi Pi channel status.'], { timeout: 3000 }).catch(() => {});
  process.exitCode = error.code === 'ELOCKED' ? 75 : 1;
 });
}
