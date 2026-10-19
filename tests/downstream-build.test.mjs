import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildCandidate, inputDigest, stableVersion, latestVersion, runProcess } from '../pi/build.mjs';

const exec = promisify(execFile);
const commit = '71023aec1546d6d677a65669c5665c0927ce0dd0';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hempi-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'pi/patches'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'prompts'));
  await fs.writeFile(path.join(root, 'prompts/scout.md'), 'Bundled runtime instructions.');
  for (const file of ['channel.json', 'build.mjs']) await fs.copyFile(new URL(`../pi/${file}`, import.meta.url), path.join(root, 'pi', file));
  const { patches } = JSON.parse(await fs.readFile(path.join(root, 'pi/channel.json')));
  for (const file of patches) await fs.writeFile(path.join(root, 'pi/patches', file), 'patch fixture');
  for (const file of ['package.json', 'package-lock.json']) await fs.writeFile(path.join(root, file), '{}');
  await fs.writeFile(path.join(root, 'src/input.ts'), 'original');
  await fs.writeFile(path.join(root, 'tests/runtime.ts'), 'fixture');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['add', '.'], { cwd: root });
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    let stdout = '';
    if (args[0] === 'ls-remote') stdout = `${'a'.repeat(40)}\trefs/tags/v1.3.0\n${commit}\trefs/tags/v1.3.0^{}\n`;
    if (args[0] === 'clone') {
      const source = args.at(-1);
      await fs.mkdir(path.join(source, 'packages/coding-agent'), { recursive: true });
      await fs.writeFile(path.join(source, 'packages/coding-agent/package.json'), '{"version":"1.3.0"}');
    }
    if (args[0] === 'rev-parse') stdout = commit;
    if (command === 'bash') {
      const output = path.join(args.at(-1), 'linux-x64');
      await fs.mkdir(path.join(output, 'native'), { recursive: true });
      await fs.writeFile(path.join(output, 'pi'), 'binary fixture');
      await fs.writeFile(path.join(output, 'native/helper'), 'native fixture');
    }
    if (args[0] === '--version') stdout = '1.3.0\n';
    return { code: 0, stdout };
  };
  return { root, calls, run };
}
async function noValidated(root) {
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else assert.notEqual(entry.name, 'build.json', `unexpected validated manifest ${file}`);
    }
  }
  await walk(root);
}

test('stable versions only; invalid versions never run commands', async t => {
  for (const value of ['1.2.3-beta', '../1.2.3', '01.2.3', '1.2', '', null]) assert.throws(() => stableVersion(value));
  assert.equal(stableVersion('v1.2.3'), '1.2.3');
  const f = await fixture(t);
  await assert.rejects(buildCandidate(f.root, { version: '1.2.3-rc', run: f.run }), /stable version/);
  assert.equal(f.calls.length, 0);
});

test('patch traversal and symlink escapes rejected', async t => {
  const f = await fixture(t);
  const configPath = path.join(f.root, 'pi/channel.json');
  const config = JSON.parse(await fs.readFile(configPath));
  config.patches = ['../build.mjs'];
  await fs.writeFile(configPath, JSON.stringify(config));
  await assert.rejects(inputDigest(f.root), /Unsafe input path/);
  await fs.symlink(path.join(f.root, 'package.json'), path.join(f.root, 'pi/patches/escape.patch'));
  config.patches = ['escape.patch'];
  await fs.writeFile(configPath, JSON.stringify(config));
  await assert.rejects(inputDigest(f.root), /escapes directory/);
});

test('successful staging uses actual native candidate and explicit offline gates', async t => {
  const f = await fixture(t);
  const digest = await inputDigest(f.root);
  const { directory, manifest } = await buildCandidate(f.root, { run: f.run, fetchLatest: async () => 'v1.3.0' });
  assert.equal(manifest.validated, true);
  assert.equal(manifest.inputDigest, digest);
  assert.equal(manifest.upstreamCommit, commit);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'build.json'))), manifest);
  assert.equal(await fs.readFile(path.join(directory, 'pi/native/helper'), 'utf8'), 'native fixture');
  const marker = JSON.parse(await fs.readFile(path.join(directory, 'pi/hempi-channel.json')));
  assert.equal(marker.root, f.root);
  assert.ok(path.isAbsolute(marker.node));
  const rpc = f.calls.find(c => c.args[0] === '--mode');
  assert.equal(rpc.options.cwd, f.root);
  assert.match(rpc.command, /candidate\/pi\/pi$/);
  assert.deepEqual(rpc.args, ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '-e', path.join(f.root, 'tests/runtime.ts')]);
  assert.equal(rpc.options.timeout, 60000);
  const gates = f.calls.filter(c => c.command === 'npm' && c.options.env.HEMPI_PI_TEST_BINARY === rpc.command);
  assert.deepEqual(gates.map(c => c.args.join(' ')), ['typecheck', 'test:privacy', 'test:downstream', 'test:model-route', 'test:acp', 'test:workflows', 'test:optchat-activity', 'test:watermark'].map(script => `run ${script}`));
  const optchat = f.calls.find(c => c.args.includes('tests/optchat.test.mjs'));
  assert.ok(path.isAbsolute(optchat.command));
  assert.equal(optchat.args[0], '--test');
  assert.equal(optchat.options.env.PATH.split(path.delimiter)[0], path.dirname(rpc.command));
  const vitest = f.calls.find(c => c.args[0]?.endsWith('vitest/dist/cli.js'));
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'pi/channel.json')));
  assert.deepEqual(vitest.args.slice(1), ['--run', ...config.upstreamTests]);
  assert.match(vitest.options.cwd, /source\/packages\/coding-agent$/);
  assert.ok(!f.calls.some(c => c.args.includes('test') || c.args.includes('--3way')));
  assert.ok(f.calls.some(c => c.command === 'npm' && c.args.join(' ') === 'run check'));
  await assert.rejects(fs.lstat(path.join(f.root, '.pi-runtime/current')), { code: 'ENOENT' });
  const second = await buildCandidate(f.root, { version: '1.3.0', run: f.run });
  assert.notEqual(second.directory, directory);
  assert.equal(await fs.readFile(path.join(directory, 'pi/pi'), 'utf8'), 'binary fixture');
});

test('bootstrap mismatch fails before cloning', async t => {
  const f = await fixture(t);
  await assert.rejects(buildCandidate(f.root, { version: '1.3.0', run: async () => ({ code: 0, stdout: `${'b'.repeat(40)}\trefs/tags/v1.3.0\n` }) }), /Bootstrap SHA mismatch/);
  await noValidated(f.root);
});

test('changed tracked inputs abort after gates without a validated manifest', async t => {
  const f = await fixture(t);
  const run = async (command, args, options) => {
    const result = await f.run(command, args, options);
    if (args.includes('tests/optchat.test.mjs')) await fs.writeFile(path.join(f.root, 'src/input.ts'), 'changed');
    return result;
  };
  await assert.rejects(buildCandidate(f.root, { version: '1.3.0', run }), /inputs changed/);
  await noValidated(f.root);
});

test('digest covers compatibility inputs, scripts, configuration and explicit patches only', async t => {
  const f = await fixture(t);
  let previous = await inputDigest(f.root);
  await fs.writeFile(path.join(f.root, 'pi/patches/not-selected.patch'), 'ignored');
  assert.equal(await inputDigest(f.root), previous);
  for (const file of ['src/input.ts', 'tests/runtime.ts', 'prompts/scout.md', 'package-lock.json', 'pi/build.mjs', 'pi/patches/0001-chat-only-view.patch']) {
    await fs.appendFile(path.join(f.root, file), '\nchanged');
    const next = await inputDigest(f.root);
    assert.notEqual(next, previous, file);
    previous = next;
  }
  await fs.writeFile(path.join(f.root, 'pi/channel.mjs'), '// channel');
  assert.notEqual(await inputDigest(f.root), previous);
});

test('default runner streams output and fails closed on timeout or signal', async t => {
  const f = await fixture(t);
  const log = await fs.open(path.join(f.root, 'output.log'), 'wx', 0o600);
  try {
    const options = { cwd: f.root, env: process.env, logFd: log.fd, timeout: 5000 };
    const result = await runProcess(process.execPath, ['-e', 'console.log("out"); console.error("err")'], options);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), 'out');
    const output = await fs.readFile(path.join(f.root, 'output.log'), 'utf8');
    assert.match(output, /out\n/);
    assert.match(output, /err\n/);
    const timeout = await runProcess(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { ...options, timeout: 50 });
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.signal, 'SIGKILL');
    const signal = await runProcess(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], options);
    assert.equal(signal.signal, 'SIGTERM');
  } finally { await log.close(); }
});

test('latest query accepts only stable GitHub releases and uses a timeout', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let release = { tag_name: 'v1.3.0' };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/earendil-works/pi/releases/latest');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => release };
  };
  assert.equal(await latestVersion(), '1.3.0');
  release = { tag_name: 'v1.3.1-rc', prerelease: true };
  await assert.rejects(latestVersion(), /not stable/);
  release = { tag_name: 'v1.3.1-beta' };
  await assert.rejects(latestVersion(), /stable version/);
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(latestVersion(), /503/);
});

for (const stage of ['patch', 'patch-apply', 'build', 'check', 'gate', 'signal', 'timeout', 'head', 'package', 'native-version', 'throw']) {
  test(`${stage} failure never stamps validated`, async t => {
    const f = await fixture(t);
    const run = async (command, args, options) => {
      if (stage === 'throw' && args.includes('build:offline')) throw new Error('runner failed');
      const result = await f.run(command, args, options);
      if (stage === 'head' && args[0] === 'rev-parse') return { code: 0, stdout: 'b'.repeat(40) };
      if (stage === 'package' && args[0] === 'clone') await fs.writeFile(path.join(args.at(-1), 'packages/coding-agent/package.json'), '{"version":"1.2.0"}');
      if (stage === 'native-version' && args[0] === '--version') return { code: 0, stdout: '1.2.0' };
      const fail = (stage === 'patch' && args[0] === 'apply') ||
        (stage === 'patch-apply' && args[0] === 'apply' && !args.includes('--check')) ||
        (stage === 'build' && args.includes('build:offline')) ||
        (stage === 'check' && args.join(' ') === 'run check') ||
        (['gate', 'signal', 'timeout'].includes(stage) && args.includes('test:acp'));
      if (fail) return { code: stage === 'signal' || stage === 'timeout' ? 0 : 1,
        signal: stage === 'signal' ? 'SIGTERM' : null, timedOut: stage === 'timeout' };
      return result;
    };
    await assert.rejects(buildCandidate(f.root, { version: '1.3.0', run }));
    await noValidated(f.root);
    assert.ok((await fs.readdir(path.join(f.root, '.pi-runtime/logs'))).length);
  });
}
