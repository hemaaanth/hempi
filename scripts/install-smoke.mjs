import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'hempi-install-'));
const checkout = path.join(root, 'checkout');
const home = path.join(root, 'home');
const agent = path.join(root, 'agent');
const env = {
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
  XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
  PI_CODING_AGENT_DIR: agent, OPTCHAT_HOME: path.join(root, 'optchat'),
  PI_OFFLINE: '1', CI: 'true', LANG: 'C.UTF-8',
};
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: checkout, env, encoding: 'utf8', timeout: 180_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  mkdirSync(checkout);
  mkdirSync(home);
  // Only public install inputs: no existing dependencies, runtime, or user resources.
  for (const name of ['package.json', 'package-lock.json', 'src', 'prompts']) {
    cpSync(path.join(source, name), path.join(checkout, name), { recursive: true });
  }
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  const pi = path.join(checkout, 'node_modules/.bin/pi');
  assert.equal(run(pi, ['--version']).trim(), '1.0.0');
  run(pi, ['install', '.']);
  const settings = JSON.parse(readFileSync(path.join(agent, 'settings.json'), 'utf8'));
  assert.ok(settings.packages.some(entry => typeof entry === 'string' && path.resolve(agent, entry) === checkout),
    `pi install must register the copied checkout: ${JSON.stringify(settings.packages)}`);
  // No -e override: prove package discovery, imports and command registration work.
  const output = run(pi, ['--mode', 'rpc', '--no-session', '--no-skills', '--no-prompt-templates', '--offline'], {
    input: '{"id":"smoke","type":"get_commands"}\n', timeout: 30_000,
  });
  const response = output.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .find(record => record.id === 'smoke');
  assert.equal(response?.success, true, output);
  for (const name of ['hempi', 'model-role', 'agents', 'advisor', 'btw', 'optchat']) {
    assert.ok(response.data.commands.some(command => command.name === name), `missing installed command: ${name}`);
  }
  console.log('Clean local package installation and offline RPC discovery passed (stock Pi 1.0.0).');
} finally {
  rmSync(root, { recursive: true, force: true });
}
