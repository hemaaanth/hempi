import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Child } from "../src/agents.ts";
import { AcpClient } from "../src/acp/client.ts";
import { createPiAcp } from "../src/acp/pi.ts";
import type * as acp from "@agentclientprotocol/sdk";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function fake() {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const messages: unknown[] = [];
  let stopped = 0, aborted = 0, resets = 0;
  let handler: (text: string, options: unknown) => Promise<void> = async () => {};
  let abortHandler = async () => {};
  const child = {
    manager: { getCwd: () => process.cwd(), getSessionFile: () => "/saved/session.jsonl", getSessionId: () => "memory" },
    session: { messages,
      subscribe(fn: (event: AgentSessionEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); },
      prompt(text: string, options: unknown) { return handler(text, options); },
      async abort() { aborted++; await abortHandler(); },
    },
    resetBudget() { resets++; },
    async stop() { stopped++; aborted++; await abortHandler(); },
  } as unknown as Child;
  return { child, messages, get stopped() { return stopped; }, get aborted() { return aborted; },
    get resets() { return resets; }, get subscriptions() { return listeners.size; },
    set handler(value: typeof handler) { handler = value; },
    set abortHandler(value: typeof abortHandler) { abortHandler = value; },
    emit(event: unknown) { for (const fn of listeners) fn(event as AgentSessionEvent); },
  };
}
const request = { cwd: process.cwd(), mcpServers: [] };
const prompt: acp.ContentBlock[] = [{ type: "text", text: "/not-a-command" }, { type: "text", text: "second" }];
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", stopReason,
  content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text }], errorMessage: "provider failed" });
async function setup(onUpdate?: (update: acp.SessionNotification) => void | Promise<void>) {
  const f = fake();
  const adapter = createPiAcp(async () => f.child);
  const client = new AcpClient({ transport: adapter.transport, onUpdate, timeoutMs: 500, shutdownMs: 500 });
  await client.initialize();
  assert.equal(await client.openSession(request), "/saved/session.jsonl");
  return { f, adapter, client, async close() { await client.shutdown(); await adapter.close(); } };
}

test("local Pi delivers ordered text/tools, no thinking or duplicate final text; followup works", async () => {
  const updates: acp.SessionNotification["update"][] = [];
  const p = await setup(async notification => { await Promise.resolve(); updates.push(notification.update); });
  try {
    p.f.handler = async (text, options) => {
      assert.equal(text, "/not-a-command\nsecond");
      assert.deepEqual(options, { expandPromptTemplates: false });
      assert.equal(p.f.subscriptions, 1);
      const message = assistant("hello");
      p.f.emit({ type: "message_start", message });
      p.f.emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE" } });
      p.f.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "hello" } });
      p.f.emit({ type: "message_end", message });
      p.f.emit({ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: {} });
      p.f.emit({ type: "tool_execution_update", toolCallId: "t", partialResult: assistant("x".repeat(5000)) });
      p.f.emit({ type: "tool_execution_end", toolCallId: "t", result: assistant("done"), isError: false });
      p.f.emit({ type: "message_start", message: assistant("final") });
      p.f.emit({ type: "message_end", message: assistant("final") });
    };
    assert.equal((await p.client.prompt(prompt)).stopReason, "end_turn");
    assert.deepEqual(updates.map(u => u.sessionUpdate), ["agent_message_chunk", "tool_call", "tool_call_update", "tool_call_update", "agent_message_chunk"]);
    assert.ok(!JSON.stringify(updates).includes("PRIVATE"));
    assert.equal(JSON.stringify(updates).match(/hello/g)?.length, 1);
    const partial = updates[2] as acp.ToolCallUpdate & { content: { content: { text: string } }[] };
    assert.equal(partial.content[0].content.text.length, 4000);
    assert.equal(partial.status, "in_progress");
    assert.equal((updates[3] as acp.ToolCallUpdate).status, "completed");
    assert.equal(p.f.subscriptions, 0);
    await p.client.prompt(prompt);
    assert.equal(p.f.resets, 2);
    assert.equal(p.adapter.child, p.f.child);
  } finally { await p.close(); }
});

test("Pi reports authoritative consumption before completion in delivery order, including errors and prompt reset", async () => {
  const notifications: acp.SessionNotification[] = [];
  const delivered = deferred(), release = deferred();
  const p = await setup(async n => {
    await Promise.resolve(); notifications.push(n);
    if ((n._meta?.hempi as { reportedTokens?: number })?.reportedTokens === 18) delivered.resolve();
  });
  try {
    let prompts = 0;
    p.f.handler = async () => {
      prompts++;
      for (const [text, tokens] of [["first", 7], ["last", 11]] as const) {
        const message = { ...assistant(text), usage: { totalTokens: tokens } };
        p.f.emit({ type: "message_start", message });
        p.f.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: text } });
        p.f.emit({ type: "message_end", message });
      }
      await release.promise;
    };
    const pending = p.client.prompt(prompt);
    await delivered.promise;
    assert.deepEqual(notifications.map(n => (n._meta?.hempi as { reportedTokens?: number })?.reportedTokens), [undefined, 7, undefined, 18]);
    assert.equal(notifications.map(n => n.update.sessionUpdate === "agent_message_chunk" ? n.update.content.type === "text" ? n.update.content.text : "" : "").join(""), "firstlast");
    assert.equal(prompts, 1);
    release.resolve(); await pending;
    p.f.handler = async () => { p.f.emit({ type: "message_end", message: { ...assistant("", "error"), usage: { totalTokens: 3 } } }); };
    await assert.rejects(p.client.prompt(prompt), /Internal error/);
    assert.equal((notifications.at(-1)?._meta?.hempi as { reportedTokens: number }).reportedTokens, 3);
    assert.ok(!JSON.stringify(notifications).includes("PRIVATE"));
  } finally { release.resolve(); await p.close(); }
});

test("local Pi cancellation aborts native session and permits followup", async () => {
  const p = await setup();
  const entered = deferred(), finish = deferred();
  try {
    p.f.handler = async () => { entered.resolve(); await finish.promise; };
    p.f.abortHandler = async () => { finish.resolve(); };
    const pending = p.client.prompt(prompt);
    await entered.promise;
    await p.client.cancel();
    assert.equal((await pending).stopReason, "cancelled");
    assert.equal(p.f.aborted, 1);
    p.f.handler = async () => {};
    assert.equal((await p.client.prompt(prompt)).stopReason, "end_turn");
  } finally { await p.close(); }
});

test("provider error tails reject, abort tails cancel, failed tools report failure", async () => {
  const updates: acp.SessionNotification["update"][] = [];
  const p = await setup(n => { updates.push(n.update); });
  try {
    p.f.handler = async () => {
      p.f.messages.push(assistant("", "error"));
      p.f.emit({ type: "tool_execution_end", toolCallId: "bad", result: assistant("failure"), isError: true });
    };
    await assert.rejects(p.client.prompt(prompt), /Internal error/);
    assert.equal((updates[0] as acp.ToolCallUpdate).status, "failed");
    p.f.handler = async () => { p.f.emit({ type: "message_end", message: assistant("", "aborted") }); };
    assert.equal((await p.client.prompt(prompt)).stopReason, "cancelled");
    p.f.handler = async () => { throw new Error("native failure"); };
    await assert.rejects(p.client.prompt(prompt), /Internal error/);
    p.f.handler = async () => {};
    assert.equal((await p.client.prompt(prompt)).stopReason, "end_turn");
    await assert.rejects(p.client.prompt([{ type: "resource_link", uri: "file:///private", name: "private" }]), /Internal error/);
  } finally { await p.close(); }
});

test("close during child startup disposes the late child exactly once", async () => {
  const f = fake(), entered = deferred(), ready = deferred<Child>();
  const adapter = createPiAcp(async () => { entered.resolve(); return ready.promise; });
  const client = new AcpClient({ transport: adapter.transport, timeoutMs: 500 });
  await client.initialize();
  const opening = assert.rejects(client.openSession(request), /closed/);
  await entered.promise;
  const closing = adapter.close();
  assert.equal(adapter.close(), closing);
  ready.resolve(f.child);
  await closing;
  await opening;
  assert.equal(f.stopped, 1);
  assert.equal(adapter.child, undefined);
  await client.shutdown();
});

test("load is opt-in and passes the id to the factory; cwd must match exactly", async () => {
  for (const supportsLoad of [false, true]) {
    const f = fake();
    let resumed: string | undefined;
    const adapter = createPiAcp(async id => { resumed = id; return f.child; }, { supportsLoad });
    const client = new AcpClient({ transport: adapter.transport, timeoutMs: 500 });
    try {
      assert.equal((await client.initialize()).agentCapabilities?.loadSession, supportsLoad);
      if (supportsLoad) {
        assert.equal(await client.openSession(request, "saved-id"), "saved-id");
        assert.equal(resumed, "saved-id");
        await client.prompt(prompt);
      } else {
        await assert.rejects(client.openSession(request, "saved-id"), /does not support/);
      }
    } finally { await client.shutdown(); await adapter.close(); }
  }
  const f = fake();
  const adapter = createPiAcp(async () => f.child);
  const client = new AcpClient({ transport: adapter.transport, timeoutMs: 500 });
  try {
    await client.initialize();
    await assert.rejects(client.openSession({ ...request, cwd: request.cwd + "/." }), /Internal error/);
    assert.equal(f.stopped, 1);
  } finally { await client.shutdown(); await adapter.close(); }
});
