import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { update, status, rollback, setup, stock, verifiedRelease, main } from '../pi/channel.mjs';

const digest = 'a'.repeat(64);
async function fixture(t, suffix = '') {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), `hempi-channel-${suffix}`));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 const runtime = path.join(root, '.pi-runtime');
 await fs.mkdir(path.join(runtime, 'releases'), { recursive: true });
 async function release(id, input = digest) {
  const directory = path.join(runtime, 'releases', id);
  await fs.mkdir(path.join(directory, 'pi'), { recursive: true });
  const bytes = '#!/bin/sh\nexit 0\n';
  await fs.writeFile(path.join(directory, 'pi/pi'), bytes, { mode: 0o700 });
  const manifest = { format: 1, validated: true, upstreamVersion: '1.3.0', upstreamCommit: 'a'.repeat(40), inputDigest: input, binarySha256: createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(path.join(directory, 'build.json'), JSON.stringify(manifest));
  return { directory, manifest };
 }
 return { root, runtime, release, options: { version: '1.3.0', digest: async () => digest } };
}

test('only verified candidates are promoted; previous is retained and matching builds skip', async t => {
 const f = await fixture(t), first = await f.release('first'), second = await f.release('second');
 await update(f.root, { ...f.options, build: async () => first });
 let state = await status(f.root);
 assert.equal(state.current.directory, first.directory); assert.equal(state.previous, undefined);
 const skipped = await update(f.root, { ...f.options, build: () => { throw new Error('must skip'); } });
 assert.equal(skipped.unchanged, true);
 await update(f.root, { ...f.options, force: true, build: async () => second });
 state = await status(f.root);
 assert.equal(state.current.directory, second.directory); assert.equal(state.previous.directory, first.directory);
 assert.equal(await fs.readFile(path.join(first.directory, 'pi/pi'), 'utf8'), '#!/bin/sh\nexit 0\n');
});

test('failed builds, tampered binaries and changed inputs cannot replace the working build', async t => {
 const f = await fixture(t), first = await f.release('first'), broken = await f.release('broken');
 await update(f.root, { ...f.options, build: async () => first });
 await assert.rejects(update(f.root, { ...f.options, force: true, build: async () => { throw new Error('patch conflict'); } }), /patch conflict/);
 assert.equal((await status(f.root)).current.directory, first.directory);
 assert.match((await status(f.root)).lastFailure.error, /patch conflict/);
 await fs.appendFile(path.join(broken.directory, 'pi/pi'), 'tampered');
 await assert.rejects(update(f.root, { ...f.options, force: true, build: async () => broken }), /checksum/);
 const changed = await f.release('changed', 'b'.repeat(64));
 await assert.rejects(update(f.root, { ...f.options, force: true, build: async () => changed }), /Inputs changed/);
 assert.equal((await status(f.root)).current.directory, first.directory);
 assert.equal((await fs.stat(path.join(f.runtime, 'last-failure.json'))).mode & 0o777, 0o600);
});

test('concurrent updates lock out; the winning build alone may promote', async t => {
 const f = await fixture(t), candidate = await f.release('winner');
 let entered, complete;
 const started = new Promise(resolve => { entered = resolve; });
 const wait = new Promise(resolve => { complete = resolve; });
 const pending = update(f.root, { ...f.options, build: async () => { entered(); await wait; return candidate; } });
 await started;
 try { await assert.rejects(update(f.root, f.options), error => error.code === 'ELOCKED'); }
 finally { complete(); await pending; }
 assert.equal((await status(f.root)).current.directory, candidate.directory);
});

test('rollback swaps validated builds and pauses only scheduled updates', async t => {
 const f = await fixture(t), first = await f.release('first'), second = await f.release('second');
 await update(f.root, { ...f.options, build: async () => first });
 await assert.rejects(rollback(f.root), /No previous/);
 await update(f.root, { ...f.options, force: true, build: async () => second });
 await rollback(f.root);
 const state = await status(f.root);
 assert.equal(state.current.directory, first.directory); assert.equal(state.previous.directory, second.directory); assert.equal(state.paused, true);
 assert.equal((await update(f.root, { scheduled: true, latest: () => { throw new Error('must not fetch'); } })).paused, true);
 assert.equal((await update(f.root, f.options)).unchanged, true);
 await main(['resume'], f.root); assert.equal((await status(f.root)).paused, false);
});

test('verification requires a well-formed checksum and always compares it', async t => {
 const f = await fixture(t);
 for (const hash of [undefined, '', 'garbage', '0'.repeat(64)]) {
  const candidate = await f.release(`hash-${String(hash).slice(0, 8)}`);
  candidate.manifest.binarySha256 = hash;
  await fs.writeFile(path.join(candidate.directory, 'build.json'), JSON.stringify(candidate.manifest));
  await assert.rejects(verifiedRelease(f.root, candidate.directory), /checksum/);
 }
});

test('rollback recovers a missing or corrupt current without sacrificing previous', async t => {
 for (const damage of ['missing', 'dangling', 'binary', 'manifest']) {
  const f = await fixture(t), first = await f.release('first'), second = await f.release('second');
  await update(f.root, { ...f.options, build: async () => first });
  await update(f.root, { ...f.options, force: true, build: async () => second });
  if (damage === 'missing') await fs.unlink(path.join(f.runtime, 'current'));
  if (damage === 'dangling') await fs.rm(second.directory, { recursive: true });
  if (damage === 'binary') await fs.appendFile(path.join(second.directory, 'pi/pi'), 'corrupt');
  if (damage === 'manifest') await fs.writeFile(path.join(second.directory, 'build.json'), '{}');
  await rollback(f.root);
  const result = await status(f.root);
  assert.equal(result.current.directory, first.directory);
  assert.equal(result.previous.directory, first.directory);
  assert.equal(result.paused, true);
 }
});

test('foreign releases, dangling pointers and invalid CLI arguments fail closed', async t => {
 const f = await fixture(t);
 await assert.rejects(verifiedRelease(f.root, f.root), /outside/);
 await fs.symlink(path.join(f.runtime, 'missing'), path.join(f.runtime, 'current'));
 await assert.rejects(status(f.root));
 for (const args of [['wat'], ['status', 'extra'], ['update', '--version'], ['update', '--version', '../x'], ['update', '--wrong']]) await assert.rejects(main(args, f.root));
});

async function setupFixture(t, suffix = '') {
 const f = await fixture(t, suffix), candidate = await f.release('verified');
 await update(f.root, { ...f.options, build: async () => candidate });
 const home = path.join(f.root, 'home'), config = path.join(home, '.config/mise/config.toml');
 await fs.mkdir(path.dirname(config), { recursive: true }); await fs.writeFile(config, '[tools]\npi="latest"\nother="keep"\n');
 await fs.mkdir(path.join(f.root, 'pi/systemd'), { recursive: true });
 for (const name of ['hempi-pi-update.service', 'hempi-pi-update.timer']) await fs.copyFile(new URL(`../pi/systemd/${name}`, import.meta.url), path.join(f.root, 'pi/systemd', name));
 const calls = [], state = { selection: 'latest', source: config, enabled: 'disabled', active: 'inactive' };
 const run = async (command, args) => {
  calls.push([command, ...args]);
  if (command === 'mise') {
   if (args[0] === 'ls') return { stdout: JSON.stringify([{ active: true, version: '1.3.0', requested_version: state.selection, source: { path: state.source } }]) };
   if (args[0] === 'use') state.selection = args[2].slice(3);
   if (args[0] === 'exec') return { stdout: '1.3.0\n' };
  }
  if (command === 'systemctl' && args.at(-1) === 'hempi-pi-update.timer') {
   if (args[1] === 'is-enabled') return { stdout: state.enabled };
   if (args[1] === 'is-active') return { stdout: state.active };
   if (args[1] === 'enable') state.enabled = args.includes('--runtime') ? 'enabled-runtime' : 'enabled';
   if (args[1] === 'disable') state.enabled = 'disabled';
   if (args.includes('--now') || args[1] === 'start' || args[1] === 'stop') state.active = args[1] === 'disable' || args[1] === 'stop' ? 'inactive' : 'active';
  }
  return { stdout: args[1] === 'is-enabled' ? 'disabled' : args[1] === 'is-active' ? 'inactive' : '' };
 };
 return { ...f, home, config, calls, state, run, setupOptions: { home, run, commands: Array(5).fill(process.execPath) } };
}

test('setup installs direct mise selection and managed timer; stock restores original channel', async t => {
 const f = await setupFixture(t);
 await setup(f.root, f.setupOptions);
 assert.ok(f.calls.some(args => args.includes(`pi@path:${path.join(f.runtime, 'install')}`)));
 assert.equal(await fs.readlink(path.join(f.runtime, 'install/pi/pi')), path.join(f.runtime, 'current/pi/pi'));
 const units = path.join(f.home, '.config/systemd/user');
 const service = await fs.readFile(path.join(units, 'hempi-pi-update.service'), 'utf8');
 assert.ok(service.includes(`ExecStart=:"${process.execPath}" "${f.root}/pi/channel.mjs" update`));
 assert.doesNotMatch(service, /@ROOT@|@NODE@|@SCRIPT@|@PATH@/);
 assert.match(service, /HEMPI_PI_SCHEDULED=1/);
 assert.ok(f.calls.some(args => args.join(' ') === 'systemctl --user enable --now hempi-pi-update.timer'));
 assert.match(await fs.readFile(path.join(f.runtime, 'mise-before.toml'), 'utf8'), /other="keep"/);
 await setup(f.root, f.setupOptions);
 await stock(f.root, { run: f.run, home: f.home });
 assert.ok(f.calls.some(args => args.join(' ') === 'mise use --global pi@latest'));
 assert.ok(f.calls.some(args => args.join(' ') === 'systemctl --user disable --now hempi-pi-update.timer'));
});

test('a fresh activation preserves a new user pin and failed setup restores that attempt', async t => {
 const f = await setupFixture(t);
 await setup(f.root, f.setupOptions);
 await setup(f.root, f.setupOptions);
 let saved = JSON.parse(await fs.readFile(path.join(f.runtime, 'integration.json'), 'utf8'));
 assert.equal(saved.originalPi, 'latest');
 await stock(f.root, { run: f.run, home: f.home });
 assert.equal(JSON.parse(await fs.readFile(path.join(f.runtime, 'integration.json'), 'utf8')).active, false);
 f.state.selection = '1.2.3';
 await fs.writeFile(f.config, '[tools]\npi="1.2.3"\n');
 const fail = async (cmd, args) => {
  const result = await f.run(cmd, args);
  if (args[1] === 'enable' && args.includes('--now')) throw new Error('enable failed');
  return result;
 };
 await assert.rejects(setup(f.root, { ...f.setupOptions, run: fail }), /enable failed/);
 assert.equal(f.state.selection, '1.2.3');
 saved = JSON.parse(await fs.readFile(path.join(f.runtime, 'integration.json'), 'utf8'));
 assert.equal(saved.originalPi, 'latest');
 await setup(f.root, f.setupOptions);
 saved = JSON.parse(await fs.readFile(path.join(f.runtime, 'integration.json'), 'utf8'));
 assert.equal(saved.originalPi, '1.2.3');
 assert.equal(await fs.readFile(path.join(f.runtime, 'mise-before.toml'), 'utf8'), '[tools]\npi="1.2.3"\n');
 f.state.selection = '1.2.4';
 const count = f.calls.length;
 await assert.rejects(stock(f.root, { run: f.run, home: f.home }), /refusing/);
 assert.equal(f.state.selection, '1.2.4');
 assert.ok(f.calls.slice(count).every(call => call[1] === 'ls'));
 f.state.selection = `path:${path.join(f.runtime, 'install')}`;
 await stock(f.root, { run: f.run, home: f.home });
 assert.equal(f.state.selection, '1.2.3');
});

test('effective service disables ExecStart expansion while keeping literal dollar paths and spaces', async t => {
 const f = await setupFixture(t, '$USER ${HOME} space % ');
 const node = path.join(f.root, 'node $USER ${HOME}');
 await setup(f.root, { ...f.setupOptions, commands: [node] });
 const service = await fs.readFile(path.join(f.home, '.config/systemd/user/hempi-pi-update.service'), 'utf8');
 const escapedRoot = f.root.replaceAll('%', '%%');
 assert.ok(service.includes(`ExecStart=:"${node.replaceAll('%', '%%')}" "${escapedRoot}/pi/channel.mjs" update`));
 assert.ok(service.includes(`WorkingDirectory=${escapedRoot}\n`));
 // The ':' command prefix disables both $VAR and ${VAR} expansion, not specifiers.
 assert.match(service, /ExecStart=:\".*\$USER \$\{HOME\}/);
 assert.doesNotMatch(service, /\$\$USER|\$\$\{HOME\}/);
});

test('installed unit syntax passes the real systemd verifier', async t => {
 const f = await setupFixture(t);
 await setup(f.root, f.setupOptions);
 const units = path.join(f.home, '.config/systemd/user');
 try {
  await promisify(execFile)('systemd-analyze', ['--user', 'verify', path.join(units, 'hempi-pi-update.service'), path.join(units, 'hempi-pi-update.timer')], { timeout: 10000 });
 } catch (error) { if (error.code === 'ENOENT') t.skip('systemd-analyze is unavailable'); else throw error; }
});

test('setup requires a global source every time and a baseline when already selected', async t => {
 const f = await setupFixture(t);
 await setup(f.root, f.setupOptions);
 f.state.source = path.join(f.root, 'mise.toml');
 await assert.rejects(setup(f.root, f.setupOptions), /global mise config/);
 f.state.source = f.config;
 await fs.unlink(path.join(f.runtime, 'integration.json'));
 await assert.rejects(setup(f.root, f.setupOptions), /baseline/);
});

test('partial unit installation failure removes only new units and restores owned units and state', async t => {
 for (const enabled of ['disabled', 'enabled', 'enabled-runtime']) {
  const existing = enabled !== 'disabled';
  const f = await setupFixture(t), units = path.join(f.home, '.config/systemd/user');
  await fs.mkdir(units, { recursive: true });
  const service = path.join(units, 'hempi-pi-update.service');
  const timer = path.join(units, 'hempi-pi-update.timer');
  const original = '# Managed by Hempi Pi channel\nold service\n';
  if (existing) {
   await fs.writeFile(service, original); await fs.writeFile(timer, original);
   f.state.enabled = enabled; f.state.active = 'active';
  }
  const fail = async (cmd, args) => {
   const result = await f.run(cmd, args);
   if (args[1] === 'enable' && args.includes('--now')) throw new Error('partial enable');
   return result;
  };
  await assert.rejects(setup(f.root, { ...f.setupOptions, run: fail }), /partial enable/);
  for (const target of [service, timer]) {
   if (existing) assert.equal(await fs.readFile(target, 'utf8'), original);
   else await assert.rejects(fs.access(target), { code: 'ENOENT' });
  }
  assert.equal(f.state.enabled, enabled);
  assert.equal(f.state.active, existing ? 'active' : 'inactive');
  assert.equal(f.state.selection, 'latest');
 }
});

test('a second unit write failure restores the first unit without disabling any timer', async t => {
 const f = await setupFixture(t), units = path.join(f.home, '.config/systemd/user');
 await fs.mkdir(units, { recursive: true });
 const service = path.join(units, 'hempi-pi-update.service');
 const timer = path.join(units, 'hempi-pi-update.timer');
 const original = '# Managed by Hempi Pi channel\noriginal\n';
 await fs.writeFile(service, original);
 const run = async (cmd, args) => {
  const result = await f.run(cmd, args);
  // Simulate a competing filesystem change after preflight, before the second write.
  if (cmd === 'mise' && args[0] === 'use' && args[2].startsWith('pi@path:')) await fs.mkdir(timer);
  return result;
 };
 await assert.rejects(setup(f.root, { ...f.setupOptions, run }), error => ['EISDIR', 'ENOTEMPTY'].includes(error.code));
 assert.equal(await fs.readFile(service, 'utf8'), original);
 assert.equal((await fs.stat(timer)).isDirectory(), true);
 assert.equal(f.state.selection, 'latest');
 assert.ok(!f.calls.some(call => call[0] === 'systemctl' && ['enable', 'disable', 'start', 'stop'].includes(call[2])));
});

test('restoration errors remain visible alongside the original setup failure', async t => {
 const f = await setupFixture(t);
 const run = async (cmd, args) => {
  const result = await f.run(cmd, args);
  if (args[1] === 'enable' && args.includes('--now')) throw new Error('setup broke');
  if (args[1] === 'disable') throw new Error('restore broke');
  return result;
 };
 await assert.rejects(setup(f.root, { ...f.setupOptions, run }), error => {
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(error.errors.map(item => item.message), ['setup broke', 'restore broke']);
  return true;
 });
 assert.equal(f.state.selection, 'latest');
});

test('setup preflights both units without changing mise or an enabled unmanaged timer', async t => {
 const f = await setupFixture(t), units = path.join(f.home, '.config/systemd/user');
 await fs.mkdir(units, { recursive: true });
 f.state.enabled = 'enabled'; f.state.active = 'active';
 const target = path.join(units, 'hempi-pi-update.timer'); await fs.writeFile(target, 'User owned unit');
 await assert.rejects(setup(f.root, f.setupOptions), /unmanaged unit/);
 assert.equal(await fs.readFile(target, 'utf8'), 'User owned unit');
 assert.equal(f.state.enabled, 'enabled'); assert.equal(f.state.active, 'active');
 assert.equal(f.state.selection, 'latest');
 assert.ok(f.calls.every(args => args[1] === 'ls'));
 await assert.rejects(fs.access(path.join(units, 'hempi-pi-update.service')), { code: 'ENOENT' });
});

test('mise tilde-normalized path selections retain ownership and the original baseline', async t => {
 const f = await setupFixture(t);
 const run = async (cmd, args) => {
  const result = await f.run(cmd, args);
  if (cmd === 'mise' && args[0] === 'ls') {
   const rows = JSON.parse(result.stdout);
   if (rows[0].requested_version.startsWith('path:')) rows[0].requested_version = `path:~/${path.relative(f.home, rows[0].requested_version.slice(5))}`;
   return { stdout: JSON.stringify(rows) };
  }
  return result;
 };
 await setup(f.root, { ...f.setupOptions, run });
 await setup(f.root, { ...f.setupOptions, run });
 await stock(f.root, { run, home: f.home });
 assert.equal(f.state.selection, 'latest');
});

test('an unusable mise executable layout fails setup before enabling any timer', async t => {
 const f = await setupFixture(t);
 const run = async (cmd, args) => {
  if (cmd === 'mise' && args[0] === 'exec') throw new Error('executable permission denied');
  return f.run(cmd, args);
 };
 await assert.rejects(setup(f.root, { ...f.setupOptions, run }), /executable permission denied/);
 assert.equal(f.state.selection, 'latest');
 assert.ok(!f.calls.some(call => call.includes('enable') || call.includes('disable')));
 await assert.rejects(fs.access(path.join(f.home, '.config/systemd/user/hempi-pi-update.service')), { code: 'ENOENT' });
});
