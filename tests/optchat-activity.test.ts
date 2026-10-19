import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChildActivity } from '../src/optchat/activity.ts';
import type { RunInfo } from '../src/optchat/runs.ts';

function run(id = 'abcdefgh123', extra: Partial<RunInfo> = {}): RunInfo {
  return { id, parentSession: 'owner', task: '\n \n\x1b[31mFirst\tline\x1b[0m\nsecret second line',
    cwd: '/private', sessionFile: '/private/session', model: 'model', thinking: 'off',
    started: 10, state: 'running', depth: 1, guidance: [], ...extra };
}
function children(rows: RunInfo[]) {
  const listeners = new Set<() => void>();
  const live = new Map<string, { updated: number }>();
  return { rows, listeners, liveRows: live, history: { list: () => rows },
    live: (id: string) => live.get(id),
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    emit() { for (const fn of listeners) fn(); },
    collectUsage() { assert.fail('snapshot must not collect usage'); },
    messages() { assert.fail('snapshot must not read messages'); },
  };
}
const entry = (runId: string, totalTokens: number, session = 'owner') => ({ session, runId,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

test('owned and nested metadata only, copied, sanitized, and live updates', () => {
  const source = new ChildActivity();
  const main = run(), nested = run('nested', { parentId: main.id, depth: 2, state: 'waiting' });
  const c = children([main, nested, run('foreign', { parentSession: 'other' })]);
  c.liveRows.set(main.id, { updated: 20 });
  source.bind(c, { entries: [] }, 'owner');
  const rows = source.snapshot();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: 'optchat:abcdefgh123', agent: 'optchat abcdefgh', title: 'First line',
    harness: 'pi', state: 'running', startedAt: 10, updatedAt: 20, runningAt: 10, model: 'model' });
  assert.equal(rows[1].state, 'waiting');
  assert.equal(rows[1].runningAt, undefined);
  rows[0].title = 'mutated';
  assert.equal(source.snapshot()[0].title, 'First line');
  let changes = 0;
  source.subscribe(() => { changes++; });
  for (const state of ['paused', 'stopping', 'completed'] as const) {
    main.state = state; main.ended = state === 'completed' ? 40 : undefined;
    c.emit(); assert.equal(source.snapshot()[0].state, state);
  }
  assert.equal(changes, 3);
  assert.equal(source.snapshot()[0].finishedAt, 40);
  assert.equal(source.snapshot()[0].runningAt, undefined);
  c.liveRows.clear(); assert.equal(source.snapshot()[0].updatedAt, 40);
  main.task = 'x'.repeat(300); assert.equal(source.snapshot()[0].title.length, 240);
});

test('usage is authoritative, owner/run filtered, unknown differs from zero, and reads never write', () => {
  const source = new ChildActivity(), c = children([run('known'), run('zero'), run('unknown'), run('overflow')]);
  const entries = [entry('known', 12), entry('known', 8), entry('known', 999, 'other'), entry('other', 999),
    entry('zero', 0), entry('unknown', NaN), entry('unknown', -1), entry('unknown', Infinity), entry('unknown', 1.5), entry('overflow', Number.MAX_SAFE_INTEGER), entry('overflow', 1)];
  const before = structuredClone(entries);
  source.bind(c, { entries }, 'owner');
  for (let i = 0; i < 2; i++) {
    const rows = source.snapshot();
    assert.deepEqual(rows.map(row => row.reportedTokens), [20, 0, undefined, undefined]);
    assert.equal(Object.hasOwn(rows[2], 'reportedTokens'), false);
    assert.ok(rows.every(row => !Object.hasOwn(row, 'contextTokens')));
  }
  assert.deepEqual(entries, before);
});

test('subscribers survive replacement, stale callbacks are ignored, clear detaches, observers are isolated', () => {
  const source = new ChildActivity(), first = children([run('old')]), next = children([run('new')]);
  assert.deepEqual(source.snapshot(), []);
  let changes = 0;
  source.subscribe(() => { throw new Error('display error'); });
  const unsubscribe = source.subscribe(() => { changes++; });
  source.bind(first, { entries: [] }, 'owner');
  const stale = [...first.listeners][0];
  assert.equal(changes, 1);
  source.bind(next, { entries: [] }, 'owner');
  assert.equal(first.listeners.size, 0);
  stale(); first.emit(); assert.equal(changes, 2);
  assert.equal(source.snapshot()[0].id, 'optchat:new');
  next.emit(); assert.equal(changes, 3);
  source.clear(); assert.equal(changes, 4);
  assert.deepEqual(source.snapshot(), []);
  assert.equal(next.listeners.size, 0);
  stale(); next.emit(); assert.equal(changes, 4);
  unsubscribe(); source.clear(); assert.equal(changes, 4);
});

test('missing owner never projects historical orphan runs', () => {
  const source = new ChildActivity(), c = children([run('orphan', { parentSession: '' })]);
  source.bind(c, { entries: [entry('orphan', 42, '')] }, '');
  assert.deepEqual(source.snapshot(), []);
  assert.equal(c.listeners.size, 0);
});
