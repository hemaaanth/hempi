import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'ho-'));
const cwd = fileURLToPath(new URL('..', import.meta.url));
const agent = join(root, 'agent');
mkdirSync(agent);
const home = join(root, `optchat-home-${'x'.repeat(15)}`);
const ownTools = ['zoom', 'date', 'search', 'spawn', 'tell'];
after(() => rmSync(root, { recursive: true, force: true }));

function start(flags = [], sessionFile) {
  const child = spawn(process.env.HEMPI_PI_TEST_BINARY ?? 'pi', ['--mode', 'rpc', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--extension', resolve(cwd, 'src/index.ts'), '--extension', resolve(cwd, 'tests/optchat-provider.ts'),
    ...(sessionFile ? ['--session', sessionFile] : ['--no-session']),
    '--provider', 'hempi-test', '--model', 'main', ...flags], {
    cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent, OPTCHAT_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = [], pending = new Map();
  let stderr = '', buffer = '', seq = 0;
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => {
    for (const request of pending.values()) request.fail(`Pi exited ${code ?? signal}: ${stderr}`);
    pending.clear();
    resolve({ code, signal });
  }));
  child.stdout.on('data', bytes => {
    buffer += bytes;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line); events.push(event);
      if (event.type === 'agent_settled') child.emit('agent_settled');
      if (event.type === 'response' && pending.has(event.id)) { pending.get(event.id).reply(event); pending.delete(event.id); }
    }
  });
  child.stdin.on('error', () => {});
  async function send(command) {
    const id = `test-${++seq}`;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${command.type}; ${stderr}`)); }, 20000);
      pending.set(id, {
        reply(event) { clearTimeout(timer); resolve(event); },
        fail(message) { clearTimeout(timer); reject(new Error(message)); },
      });
    });
    child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
    return reply;
  }
  async function tools() {
    const at = events.length;
    assert.equal((await send({ type: 'prompt', message: '/test-tools' })).success, true);
    const note = events.slice(at).find(event => event.type === 'extension_ui_request' && event.method === 'notify');
    return JSON.parse(note.message).tools;
  }
  async function close() { child.stdin.end(); return exited; }
  return { child, events, send, tools, close, exited, stderr: () => stderr };
}
const profile = name => join(home, 'profiles', name);
const config = name => JSON.parse(readFileSync(join(profile(name), 'config.json'), 'utf8'));
function session(name, rows = [], big = false) {
  const file = join(root, `${name}.jsonl`), timestamp = '2026-10-16T00:00:00.000Z';
  const messages = rows.map((text, index) => ({ type: 'message', id: `u${index}`, parentId: index ? `u${index - 1}` : null,
    timestamp, message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.parse(timestamp) } }));
  if (big) messages.push({ type: 'message', id: 'a', parentId: `u${rows.length - 1}`, timestamp,
    message: { role: 'assistant', api: 'hempi-optchat-test', provider: 'hempi-test', model: 'main', content: [{ type: 'text', text: 'Recorded.' }],
      stopReason: 'stop', timestamp: Date.parse(timestamp), usage: { input: 40000, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 40020, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
  writeFileSync(file, [{ type: 'session', version: 3, id: name, timestamp, cwd: root }, ...messages].map(row => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

test('off by default, including saved bindings; normal native compaction still runs', async () => {
  const file = session('plain', ['Old worker notes.', 'Latest worker notes. '.repeat(5000)], true);
  writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ type: 'custom', id: 'saved', parentId: 'a', customType: 'optchat.profile', data: { name: 'missing' } }) + '\n');
  const pi = start([], file);
  try {
    assert.equal((await pi.send({ type: 'get_state' })).success, true);
    assert.ok((await pi.tools()).every(tool => !ownTools.includes(tool)));
    const compact = await pi.send({ type: 'compact' });
    assert.equal(compact.success, true, JSON.stringify(compact));
    assert.match(compact.data.summary, /FAKE COMPACTION SUMMARY/);
    assert.ok(!pi.events.some(event => event.method === 'notify' && event.message?.startsWith('OptChat ')));
  } finally { await pi.close(); }
  const probe = start();
  try { assert.ok((await probe.tools()).every(tool => !ownTools.includes(tool))); }
  finally { await probe.close(); }
});

test('create uses Codex defaults, binds RPC, preserves tools on persona/reset and role switches', async () => {
  const instructions = join(root, 'instructions.md'); writeFileSync(instructions, 'Exact profile instructions.\n');
  const file = session('bound', ['Old worker notes.', 'Latest worker notes. '.repeat(5000)], true);
  const pi = start(['--optchat-profile', 'created', '--optchat-create', '--optchat-instructions', instructions], file);
  try {
    await pi.send({ type: 'get_state' });
    assert.deepEqual(config('created').compactor, { provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'low' });
    assert.deepEqual(config('created').subagent, { provider: 'openai-codex', model: 'gpt-6-sol', thinking: 'medium' });
    assert.equal(config('created').memorySearch, true);
    assert.equal(readFileSync(join(profile('created'), 'AGENTS.md'), 'utf8'), 'Exact profile instructions.\n');
    assert.equal(pi.events.filter(event => event.method === 'notify' && event.message?.startsWith('OptChat ')).length, 1);
    for (const command of ['/agent reviewer', '/model-role current', '/agent reset']) {
      assert.equal((await pi.send({ type: 'prompt', message: command })).success, true);
      const active = await pi.tools(); assert.ok(ownTools.every(tool => active.includes(tool)), `${command}: ${active}`);
    }
    const compact = await pi.send({ type: 'compact' });
    assert.match(compact.error, /Compaction cancelled/);
  } finally { await pi.close(); }
});

test('busy exits 75 before prompts, with exactly one stderr line and owner PID', async () => {
  const owner = start(['--optchat-profile', 'locked', '--optchat-create']);
  try {
    await owner.send({ type: 'get_state' });
    const settled = once(owner.child, 'agent_settled', { signal: AbortSignal.timeout(20000) });
    await owner.send({ type: 'prompt', message: 'Reply with the tool names.' });
    await settled;
    const second = start(['--optchat-profile', 'locked']);
    assert.deepEqual(await second.exited, { code: 75, signal: null });
    assert.equal(second.stderr(), `optchat: profile busy: locked (owner pid ${owner.child.pid})\n`);
    assert.ok(!second.events.some(event => event.type === 'agent_start'));
    assert.equal((await owner.send({ type: 'get_state' })).success, true);
  } finally { await owner.close(); }
});

test('simultaneous binds select one owner and refuse the other with exit 75', async () => {
  const setup = start(['--optchat-profile', 'raced', '--optchat-create']);
  await setup.send({ type: 'get_state' }); await setup.close();
  const contenders = [start(['--optchat-profile', 'raced']), start(['--optchat-profile', 'raced'])];
  try {
    const results = await Promise.allSettled(contenders.map(pi => pi.send({ type: 'get_state' })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    const loser = 1 - winner;
    assert.deepEqual(await contenders[loser].exited, { code: 75, signal: null }, contenders[loser].stderr());
    assert.equal(contenders[loser].stderr(), `optchat: profile busy: raced (owner pid ${contenders[winner].child.pid})\n`);
  } finally { await Promise.all(contenders.map(pi => pi.close())); }
});

test('explicit print connect joins the owner; RPC and JSON still exit 75', async () => {
  const owner = start(['--optchat-profile', 'connected', '--optchat-create']);
  try {
    await owner.send({ type: 'get_state' });
    for (const mode of ['rpc', 'json']) {
      const headless = start(['--optchat-profile', 'connected', '--optchat-connect', 'join', '--mode', mode, ...(mode === 'json' ? ['Refuse this prompt while busy.'] : [])]);
      if (mode === 'json') headless.child.stdin.end();
      assert.deepEqual(await headless.exited, { code: 75, signal: null }, headless.stderr());
    }
    for (const mode of ['auto', 'join']) {
      const child = spawn(process.env.HEMPI_PI_TEST_BINARY ?? 'pi', ['--print', '--no-session', '--no-extensions', '--no-skills',
        '--extension', resolve(cwd, 'src/index.ts'), '--extension', resolve(cwd, 'tests/optchat-provider.ts'),
        '--provider', 'hempi-test', '--model', 'main', '--optchat-profile', 'connected', '--optchat-connect', mode, 'Report the child tool names.'], {
        cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent, OPTCHAT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, killSignal: 'SIGKILL',
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const code = await new Promise(resolve => child.on('exit', resolve));
      if (code !== 0) owner.child.kill('SIGKILL');
      assert.equal(code, 0, stderr + JSON.stringify(owner.events.slice(-10)));
      const reply = JSON.parse(stdout);
      assert.ok(reply.tools.includes('tell_parent'), `print ${mode} must run a child in the owning process`);
      assert.ok(reply.tools.includes('zoom'), 'connected children retain profile memory tools');
    }
  } finally { await owner.close(); }
});

test('a crashed owner can be bound again without manual recovery', async () => {
  const owner = start(['--optchat-profile', 'crashed', '--optchat-create']);
  await owner.send({ type: 'get_state' });
  owner.child.kill('SIGKILL');
  assert.deepEqual(await owner.exited, { code: null, signal: 'SIGKILL' });
  const resumed = start(['--optchat-profile', 'crashed']);
  try {
    assert.equal((await resumed.send({ type: 'get_state' })).success, true, resumed.stderr());
    const active = await resumed.tools();
    assert.ok(ownTools.every(tool => active.includes(tool)));
  } finally { await resumed.close(); }
});

test('missing exits 66 with exactly one stderr line', async () => {
  const pi = start(['--optchat-profile', 'absent']);
  assert.deepEqual(await pi.exited, { code: 66, signal: null });
  assert.equal(pi.stderr(), 'optchat: profile not found: absent\n');
});

test('import only on create, then bind; later launches ignore the import path', async () => {
  const source = session('import-source', ['The buried codeword is ORCHID-715.']);
  const flags = ['--optchat-profile', 'imported', '--optchat-create', '--optchat-import-session', source];
  const first = start(flags);
  try { await first.send({ type: 'get_state' }); assert.ok((await first.tools()).includes('zoom')); }
  finally { await first.close(); }
  const memory = JSON.parse(readFileSync(join(profile('imported'), 'active-memory.json'), 'utf8'));
  const logDir = join(profile('imported'), memory, 'main');
  const contents = readdirSync(logDir).map(file => readFileSync(join(logDir, file), 'utf8')).join('');
  assert.match(contents, /ORCHID-715/);
  const again = start(['--optchat-profile', 'imported', '--optchat-create', '--optchat-import-session', '/missing-session']);
  try { assert.equal((await again.send({ type: 'get_state' })).success, true); assert.ok((await again.tools()).includes('search')); }
  finally { await again.close(); }
  assert.equal(readdirSync(logDir).map(file => readFileSync(join(logDir, file), 'utf8')).join(''), contents);
  assert.equal(readFileSync(join(profile('imported'), 'AGENTS.md'), 'utf8'), 'Instructions for imported.\n');
});

test('instructions refresh on every bind, without rewriting identical text or changing memory', async () => {
  const file = join(root, 'refreshed.md');
  writeFileSync(file, 'Original instructions.\n');
  const source = session('refresh-source', ['Retain this memory through instruction changes.']);
  const original = start(['--optchat-profile', 'refreshed', '--optchat-create', '--optchat-instructions', file, '--optchat-import-session', source]);
  try { await original.send({ type: 'get_state' }); }
  finally { await original.close(); }
  writeFileSync(file, 'UPDATED-BIND-INSTRUCTIONS\n');
  const flags = ['--optchat-profile', 'refreshed', '--optchat-instructions', file];
  const memoryBefore = readFileSync(join(profile('refreshed'), 'active-memory.json'), 'utf8');
  const changed = start(flags);
  try {
    await changed.send({ type: 'get_state' });
    assert.equal(readFileSync(join(profile('refreshed'), 'AGENTS.md'), 'utf8'), 'UPDATED-BIND-INSTRUCTIONS\n');
  } finally { await changed.close(); }
  const before = statSync(join(profile('refreshed'), 'AGENTS.md'));
  const same = start(flags);
  try { await same.send({ type: 'get_state' }); }
  finally { await same.close(); }
  const after = statSync(join(profile('refreshed'), 'AGENTS.md'));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(readFileSync(join(profile('refreshed'), 'active-memory.json'), 'utf8'), memoryBefore);
});

test('failed startup imports exit 65, without a ready notification', async () => {
  const invalid = join(root, 'invalid.jsonl'); writeFileSync(invalid, '{broken json}\n');
  for (const [name, file] of [['missing-import', '/missing-session'], ['invalid-import', invalid]]) {
    const pi = start(['--optchat-profile', name, '--optchat-create', '--optchat-import-session', file]);
    assert.deepEqual(await pi.exited, { code: 65, signal: null });
    assert.match(pi.stderr(), /^optchat: import failed: [^\n]+\n$/);
    assert.ok(!pi.events.some(event => event.method === 'notify' && event.message?.startsWith('OptChat ')));
  }
});
