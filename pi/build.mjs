import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, writeSync, constants } from 'node:fs';
import path from 'node:path';

const upstream = 'https://github.com/earendil-works/pi.git';
export function stableVersion(value) {
  if (typeof value !== 'string' || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Expected stable version X.Y.Z (optional v prefix)');
  }
  return value.replace(/^v/, '');
}
export async function latestVersion() {
  const response = await fetch('https://api.github.com/repos/earendil-works/pi/releases/latest', {
    signal: AbortSignal.timeout(30000), headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`Latest release query failed: ${response.status}`);
  const release = await response.json();
  if (release.draft || release.prerelease) throw new Error('Latest release is not stable');
  return stableVersion(release.tag_name);
}
const inside = (base, file) => file.startsWith(base + path.sep);
async function localFile(base, name) {
  if (typeof name !== 'string' || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) {
    throw new Error('Unsafe input path');
  }
  const file = path.resolve(base, name);
  if (!inside(base, file) || !inside(base, await fs.realpath(file))) throw new Error('Input path escapes directory');
  if (!(await fs.stat(file)).isFile()) throw new Error('Input must be a regular file');
  return file;
}
async function inputs(root) {
  const config = JSON.parse(await fs.readFile(path.join(root, 'pi/channel.json'), 'utf8'));
  if (config.upstream !== upstream) throw new Error('Unsupported upstream');
  stableVersion(config.bootstrap.version);
  if (!/^[a-f0-9]{40}$/.test(config.bootstrap.commit)) throw new Error('Invalid bootstrap commit');
  if (!Array.isArray(config.patches) || !config.patches.length) throw new Error('Explicit patches required');
  if (!Array.isArray(config.upstreamTests) || !config.upstreamTests.length ||
      config.upstreamTests.some(p => typeof p !== 'string' || !/^test\/[\w/-]+\.test\.ts$/.test(p) || p.includes('..'))) {
    throw new Error('Explicit upstream test paths required');
  }
  const patches = [];
  for (const name of config.patches) patches.push(await localFile(path.join(root, 'pi/patches'), name));
  const names = new Set(['package.json', 'package-lock.json', 'pi/build.mjs', 'pi/channel.json']);
  // Include local/uncommitted code too; this channel must not validate a different Hempi tree.
  async function walk(directory) {
    const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      if (['node_modules', '.git', '.pi-runtime'].includes(entry.name)) continue;
      const name = path.posix.join(directory, entry.name);
      if (name === 'pi/patches') continue;
      if (entry.isDirectory()) await walk(name);
      else names.add(name);
    }
  }
  for (const directory of ['src', 'tests', 'pi', 'prompts']) await walk(directory);
  try { await fs.access(path.join(root, 'tsconfig.json')); names.add('tsconfig.json'); } catch {}
  for (const file of patches) names.add(path.relative(root, file));
  const hash = createHash('sha256'), patchHash = createHash('sha256');
  for (const name of [...names].sort()) {
    if (name.split('/').some(p => ['node_modules', '.git', '.pi-runtime'].includes(p))) continue;
    const content = await fs.readFile(await localFile(root, name));
    const digest = createHash('sha256').update(content).digest('hex');
    hash.update(`${name}\0${digest}\0`);
  }
  for (const file of patches) patchHash.update(`${path.relative(root, file)}\0`).update(await fs.readFile(file)).update('\0');
  return { config, patches, inputDigest: hash.digest('hex'), patchHash: patchHash.digest('hex') };
}
export async function inputDigest(root) { return (await inputs(await fs.realpath(root))).inputDigest; }

// No shell, inherited stdin, command-line logging, or environment persistence.
export async function runProcess(command, args, { cwd, env, timeout = 600000, logFd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', timedOut = false, interrupted, logError;
    const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') logError ??= error; } };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = signals.map(signal => { const handler = () => { interrupted = signal; kill(); }; process.on(signal, handler); return handler; });
    const cleanup = () => { clearTimeout(timer); signals.forEach((signal, index) => process.off(signal, handlers[index])); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    const log = bytes => { if (logFd !== undefined) try { writeSync(logFd, bytes); } catch (error) { logError ??= error; kill(); } };
    child.stdout.on('data', bytes => { log(bytes); if (stdout.length < 1048576) stdout += bytes.toString().slice(0, 1048576 - stdout.length); });
    child.stderr.on('data', log);
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (code, signal) => { cleanup(); if (logError) reject(logError); else resolve({ code, signal: interrupted ?? signal, timedOut, stdout }); });
  });
}
async function stableNode() {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const node = path.join(directory, 'node');
    try { await fs.access(node, constants.X_OK); if ((await fs.stat(node)).isFile()) return node; } catch {}
  }
  return process.execPath;
}
export async function buildCandidate(root, { version, force: _force, run = runProcess, fetchLatest = latestVersion } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Only linux-x64 candidate builds are supported');
  root = await fs.realpath(root);
  version = stableVersion(version ?? await fetchLatest());
  const before = await inputs(root);
  const runtime = path.join(root, '.pi-runtime');
  const id = `${version}-${randomUUID()}`;
  const work = path.join(runtime, 'work', id), directory = path.join(runtime, 'releases', id);
  await fs.mkdir(work, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(runtime, 'logs'), { recursive: true, mode: 0o700 });
  const logPath = path.join(runtime, 'logs', `build-${id}.log`);
  const log = await fs.open(logPath, 'wx', 0o600);
  const source = path.join(work, 'source'), stage = path.join(work, 'candidate');
  const home = path.join(work, 'home');
  await fs.mkdir(home);
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'), HEMPI_MODE: 'off' };
  const invoke = async (command, args, options = {}) => {
    const result = await run(command, args, { cwd: root, env, timeout: 600000, logFd: log.fd, logPath, ...options });
    if (!result || result.code !== 0 || result.signal || result.timedOut) throw new Error(`Build command failed: ${path.basename(command)} (see ${logPath})`);
    return result.stdout ?? '';
  };
  try {
    const tag = `refs/tags/v${version}`;
    const refs = await invoke('git', ['ls-remote', upstream, tag, `${tag}^{}`], { timeout: 30000 });
    const rows = new Map(refs.trim().split('\n').map(line => line.trim().split(/\s+/).reverse()));
    const commit = rows.get(`${tag}^{}`) ?? rows.get(tag);
    if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Missing exact upstream tag SHA');
    if (version === stableVersion(before.config.bootstrap.version) && commit !== before.config.bootstrap.commit) throw new Error('Bootstrap SHA mismatch');
    await invoke('git', ['clone', '--depth', '1', '--branch', `v${version}`, upstream, source]);
    if ((await invoke('git', ['rev-parse', 'HEAD'], { cwd: source })).trim() !== commit) throw new Error('Cloned HEAD does not match pinned tag');
    const pkg = JSON.parse(await fs.readFile(path.join(source, 'packages/coding-agent/package.json'), 'utf8'));
    if (pkg.version !== version) throw new Error('Upstream package version mismatch');
    await invoke('npm', ['ci', '--ignore-scripts'], { cwd: source });
    for (const patch of before.patches) {
      await invoke('git', ['apply', '--check', patch], { cwd: source });
      await invoke('git', ['apply', patch], { cwd: source });
    }
    await invoke(await stableNode(), [path.join(root, 'pi/hydrate-model-data.mjs'), source], { cwd: source, timeout: 120000 });
    await invoke('npm', ['run', 'build:offline'], { cwd: source });
    await invoke('npm', ['run', 'check'], { cwd: source });
    await invoke(await stableNode(), [path.join(source, 'node_modules/vitest/dist/cli.js'), '--run', ...before.config.upstreamTests], {
      cwd: path.join(source, 'packages/coding-agent'),
    });
    await invoke('bash', ['scripts/build-binaries.sh', '--skip-install', '--skip-build', '--platform', 'linux-x64', '--out', path.join(work, 'binaries')], { cwd: source });
    await fs.mkdir(stage);
    const piDir = path.join(stage, 'pi'), binary = path.join(piDir, 'pi');
    await fs.cp(path.join(work, 'binaries/linux-x64'), piDir, { recursive: true, dereference: true, errorOnExist: true, force: false });
    await fs.writeFile(path.join(piDir, 'hempi-channel.json'), JSON.stringify({ format: 1, root, node: await stableNode() }) + '\n', { flag: 'wx' });
    const candidateEnv = { ...env, HEMPI_PI_TEST_BINARY: binary, PATH: `${piDir}${path.delimiter}${env.PATH ?? ''}` };
    const nativeVersion = (await invoke(binary, ['--version'], { env: candidateEnv, timeout: 60000 })).trim();
    if (nativeVersion !== version) throw new Error('Native candidate version mismatch');
    await invoke(binary, ['--help'], { env: candidateEnv, timeout: 60000 });
    for (const script of ['typecheck', 'test:privacy', 'test:downstream', 'test:model-route', 'test:acp', 'test:workflows', 'test:optchat-activity', 'test:watermark']) {
      await invoke('npm', ['run', script], { env: candidateEnv });
    }
    await invoke(binary, ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '-e', path.join(root, 'tests/runtime.ts')], { env: candidateEnv, timeout: 60000 });
    await invoke(await stableNode(), ['--test', '--test-timeout=90000', 'tests/optchat.test.mjs'], { env: candidateEnv, timeout: 180000 });
    if ((await inputDigest(root)) !== before.inputDigest) throw new Error('Build inputs changed during validation');
    const manifest = { format: 1, upstreamVersion: version, upstreamCommit: commit, patchHash: before.patchHash,
      inputDigest: before.inputDigest, binarySha256: createHash('sha256').update(await fs.readFile(binary)).digest('hex'),
      createdAt: new Date().toISOString(), validated: true };
    await fs.writeFile(path.join(stage, 'build.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await fs.rename(stage, directory);
    return { directory, manifest };
  } finally { await log.close(); }
}
