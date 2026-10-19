import assert from "node:assert/strict";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { AcpClient } from "../src/acp/client.ts";

const request = { cwd: process.cwd(), mcpServers: [] };
test("negotiated mode/model selection, Unicode framing, and permission deadline withdrawal", async () => {
 const a = new TransformStream<Uint8Array, Uint8Array>(), b = new TransformStream<Uint8Array, Uint8Array>();
 const text = "你好 👩🏽‍💻 one\u2028two\u2029three";
 const updates: string[] = [], changes: string[] = [];
 let withdrawn = false;
 const config: acp.SessionConfigOption[] = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "small", options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] }];
 new acp.AgentSideConnection(client => ({
  initialize: () => ({ protocolVersion: acp.PROTOCOL_VERSION }), authenticate: () => ({}),
  newSession: () => ({ sessionId: "s", configOptions: config, modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] } }),
  setSessionMode: params => { changes.push(params.modeId); return {}; },
  setSessionConfigOption: params => { changes.push(String(params.value)); return { configOptions: config }; },
  prompt: async ({ sessionId }) => {
   await client.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
   const result = await client.requestPermission({ sessionId, toolCall: { toolCallId: "t", title: "Write?" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] });
   assert.equal(result.outcome.outcome, "cancelled");
   return { stopReason: "end_turn" };
  }, cancel: () => {},
 }), acp.ndJsonStream(b.writable, a.readable));
 const client = new AcpClient({ transport: { readable: b.readable, writable: a.writable }, permissionTimeoutMs: 20,
  onUpdate: n => { if (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text") updates.push(n.update.content.text); },
  requestPermission: (_request, signal) => new Promise(resolve => signal.addEventListener("abort", () => {
   withdrawn = true; resolve({ outcome: { outcome: "cancelled" } });
  }, { once: true })),
 });
 try {
  await client.initialize(); await client.openSession(request);
  await client.setMode("ask"); await client.setModel("large");
  assert.deepEqual(changes, ["ask", "large"]);
  await client.prompt([{ type: "text", text: "go" }]);
  assert.deepEqual(updates, [text]); assert.equal(withdrawn, true);
  await assert.rejects(client.setModel("not-advertised"), /not advertised/);
 } finally { await client.shutdown(); }
});

test("oversized ACP frames terminate the connection instead of accumulating unbounded input", async () => {
 const client = new AcpClient({ timeoutMs: 1000, transport: {
  readable: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1).fill(120)); } }),
  writable: new WritableStream(),
 } });
 try { await assert.rejects(client.initialize(), /closed/); }
 finally { await client.shutdown(); }
});
