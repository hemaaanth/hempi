import assert from 'node:assert/strict';
import optchat from '../src/optchat/index.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// Run through Pi's extension loader, which supports the SDK's TypeScript syntax.
export default async function () {
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = new Proxy({}, { get(_target, key) {
    if (key === 'on') return (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => events.set(name, fn);
    if (key === 'getFlag') return () => undefined;
    if (key === 'getActiveTools') return () => [];
    return () => {};
  } }) as ExtensionAPI;
  const api = optchat(pi);
  assert.deepEqual(api.tools(), []);
  assert.deepEqual(Object.keys(api.childActivity).sort(), ['snapshot', 'subscribe']);
  assert.deepEqual(api.childActivity.snapshot(), []);
  let changes = 0;
  api.childActivity.subscribe(() => { throw new Error('observer'); });
  api.childActivity.subscribe(() => { changes++; });
  const ctx = { sessionManager: { getEntries: () => [] } } as unknown as ExtensionContext;
  await events.get('session_start')!({}, ctx);
  assert.deepEqual(api.childActivity.snapshot(), []);
  await events.get('session_shutdown')!({}, ctx);
  assert.equal(changes, 2);
  console.error('optchat activity runtime: registration, tools compatibility, off/stop and observer isolation passed');
}
