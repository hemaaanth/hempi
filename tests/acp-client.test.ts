import assert from "node:assert/strict";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { AcpClient, type AcpClientOptions } from "../src/acp/client.ts";

function peer(options: Partial<AcpClientOptions> = {}, loadSession = true) {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  let finish: ((value: acp.PromptResponse) => void) | undefined;
  let hang = false;
  let ignoreCancel = false;
  let permission: acp.RequestPermissionResponse | undefined;
  let loaded = false;
  const connection = new acp.AgentSideConnection(client => ({
    initialize: () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession } }),
    authenticate: () => ({}),
    newSession: () => ({ sessionId: "s" }),
    loadSession: () => { loaded = true; return {}; },
    prompt: async ({ sessionId }) => {
      await client.sessionUpdate({ sessionId, update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" },
      } });
      permission = await client.requestPermission({ sessionId,
        toolCall: { toolCallId: "tool", title: "test" },
        options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
      });
      if (hang) return new Promise(resolve => { finish = resolve; });
      return { stopReason: "end_turn" };
    },
    cancel: () => { if (!ignoreCancel) finish?.({ stopReason: "cancelled" }); },
  }), acp.ndJsonStream(toClient.writable, toAgent.readable));
  const client = new AcpClient({ timeoutMs: 200, shutdownMs: 40, ...options,
    transport: { readable: toClient.readable, writable: toAgent.writable },
  });
  return { client, connection, get permission() { return permission; },
    get loaded() { return loaded; }, set hang(value: boolean) { hang = value; },
    set ignoreCancel(value: boolean) { ignoreCancel = value; } };
}
const request = { cwd: process.cwd(), mcpServers: [] };
const prompt: acp.ContentBlock[] = [{ type: "text", text: "test" }];
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  assert.fail("condition did not become true");
}

test("initialize/new/prompt, updates, default deny and single prompt", async () => {
  const updates: acp.SessionNotification[] = [];
  const p = peer({ onUpdate: update => { updates.push(update); } });
  try {
    await p.client.initialize();
    assert.equal(await p.client.openSession(request), "s");
    const result = p.client.prompt(prompt);
    await assert.rejects(p.client.prompt(prompt), /already active/);
    assert.equal((await result).stopReason, "end_turn");
    assert.equal(updates.length, 1);
    assert.deepEqual(p.permission, { outcome: { outcome: "cancelled" } });
    p.hang = true;
    const pending = p.client.prompt(prompt);
    await waitFor(() => updates.length === 2);
    await tick();
    await p.client.cancel();
    assert.equal((await pending).stopReason, "cancelled");
  } finally { await p.client.shutdown(); }
});

test("load is capability gated; permission requires explicit valid selection", async () => {
  const p = peer({ requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "yes" } }) });
  try {
    await p.client.initialize();
    assert.equal(await p.client.openSession(request, "saved"), "saved");
    assert.equal(p.loaded, true);
    await p.client.prompt(prompt);
    assert.deepEqual(p.permission, { outcome: { outcome: "selected", optionId: "yes" } });
  } finally { await p.client.shutdown(); }
  const unsupported = peer({}, false);
  try {
    await unsupported.client.initialize();
    await assert.rejects(unsupported.client.openSession(request, "saved"), /does not support/);
    assert.equal(unsupported.loaded, false);
  } finally { await unsupported.client.shutdown(); }
});

test("invalid approval is denied and hanging permission cancellation is bounded", async () => {
  const invalid = peer({ requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "unknown" } }) });
  try {
    await invalid.client.initialize(); await invalid.client.openSession(request);
    await invalid.client.prompt(prompt);
    assert.deepEqual(invalid.permission, { outcome: { outcome: "cancelled" } });
  } finally { await invalid.client.shutdown(); }
  let requested = false;
  const p = peer({ requestPermission: () => { requested = true; return new Promise(() => {}); } });
  try {
    await p.client.initialize(); await p.client.openSession(request);
    const pending = p.client.prompt(prompt);
    await waitFor(() => requested);
    await p.client.cancel();
    await pending;
    assert.deepEqual(p.permission, { outcome: { outcome: "cancelled" } });
  } finally { await p.client.shutdown(); }
});

test("stream EOF and process startup/exit failures reject", async () => {
  const p = peer();
  await p.client.shutdown();
  await assert.rejects(p.client.initialize(), /shut down/);
  for (const transport of [
    { command: "/nonexistent/hempi-acp" },
    { command: process.execPath, args: ["-e", "process.exit(7)"] },
  ]) {
    const client = new AcpClient({ transport, timeoutMs: 500, shutdownMs: 20 });
    try { await assert.rejects(client.initialize(), /failed to start|exited|closed/); }
    finally { await client.shutdown(); }
  }
  const eof = new AcpClient({ transport: {
    readable: new ReadableStream({ start(controller) { controller.close(); } }),
    writable: new WritableStream(),
  }, timeoutMs: 100 });
  try { await assert.rejects(eof.initialize(), /closed/); }
  finally { await eof.shutdown(); }
});

test("uncooperative cancellation closes the connection and rejects the prompt", async () => {
  const p = peer();
  try {
    await p.client.initialize(); await p.client.openSession(request);
    p.hang = true; p.ignoreCancel = true;
    const pending = p.client.prompt(prompt);
    const rejected = assert.rejects(pending, /shut down/);
    await waitFor(() => p.permission !== undefined);
    await assert.rejects(p.client.cancel(), /timed out/);
    await rejected;
    await assert.rejects(p.client.prompt(prompt), /shut down/);
  } finally { await p.client.shutdown(); }
});

test("process stdio uses the SDK wire protocol", async () => {
  const script = `
    import { Readable, Writable } from 'node:stream';
    import * as acp from '@agentclientprotocol/sdk';
    new acp.AgentSideConnection(() => ({
      initialize: () => ({ protocolVersion: acp.PROTOCOL_VERSION }),
      authenticate: () => ({}), newSession: () => ({ sessionId: 'stdio' }),
      prompt: () => ({ stopReason: 'end_turn' }), cancel: () => {},
    }), acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
  `;
  const client = new AcpClient({ transport: { command: process.execPath,
    args: ["--input-type=module", "-e", script], cwd: process.cwd(),
  }, timeoutMs: 1000, shutdownMs: 20 });
  try {
    await client.initialize();
    assert.equal(await client.openSession(request), "stdio");
    assert.equal((await client.prompt(prompt)).stopReason, "end_turn");
  } finally { await client.shutdown(); }
});

test("hung process times out, bounds stderr, and escalates TERM to KILL", async () => {
  const client = new AcpClient({ transport: {
    command: process.execPath, args: ["-e", `
      process.on('SIGTERM', () => {});
      process.stderr.write('x'.repeat(20000) + '\\n' + process.pid);
      setInterval(() => {}, 1000);
    `],
  }, timeoutMs: 150, shutdownMs: 30 });
  const started = Date.now();
  await assert.rejects(client.initialize(), /timed out/);
  assert.ok(Date.now() - started < 1500);
  assert.equal(Buffer.byteLength(client.stderr), 8192);
  const pid = Number(client.stderr.split("\n").at(-1));
  assert.ok(pid > 0);
  await waitFor(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  });
  await client.shutdown();
});
