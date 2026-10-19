import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime, ModelRegistry, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaults, resolveSelection } from "../src/config.ts";
import { emptyUsage, Requests } from "../src/requests.ts";
import { createChild } from "../src/agents.ts";

export default async function () {
 const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hempi-sdk-"));
 try {
  await fs.writeFile(path.join(cwd, "hello.txt"), "ACTUAL WORKSPACE FILE");
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  let calls = 0;
  runtime.registerProvider("hempi-test", {
   baseUrl: "http://127.0.0.1:1", api: "hempi-test-api", apiKey: "test-only", models: [{ id: "model", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
   streamSimple(model, context, options) {
    const stream = createAssistantMessageEventStream();
    void (async () => {
     try {
      await options?.onPayload?.({ model: model.id }, model);
      calls++;
      const content: AssistantMessage["content"] = calls === 1 ? [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "hello.txt" } }] : [{ type: "text", text: "Reviewed the actual file" }];
      if (calls === 2) assert.ok(JSON.stringify(context).includes("ACTUAL WORKSPACE FILE"), "native SDK read tools must really execute");
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason: calls === 1 ? "toolUse" : "stop", usage: emptyUsage(), timestamp: Date.now() };
      stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: calls === 1 ? "toolUse" : "stop", message }); stream.end(message);
     } catch (error) {
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "error", errorMessage: String(error), usage: emptyUsage(), timestamp: Date.now() };
      stream.push({ type: "error", reason: "error", error: message }); stream.end(message);
     }
    })();
    return stream;
   },
  });
  await runtime.refresh({ allowNetwork: false, providers: ["hempi-test"] });
  const registry = new ModelRegistry(runtime);
  const metadata: unknown[] = [];
  const api = { on: () => () => {}, appendEntry: (_kind: string, data: unknown) => metadata.push(data), getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
  const ctx = { cwd, model: registry.find("hempi-test", "model"), thinkingLevel: "off", modelRegistry: registry, sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "Primary constraints", isProjectTrusted: () => false } as unknown as ExtensionContext;
  const config = defaults();
  const requests = new Requests(api, () => config);
  const selection = resolveSelection(config, "current", ctx);
  const child = await createChild({ ctx, requests, config, selection, kind: "test", instructions: "Read hello.txt then answer.", tools: ["read"], maxRequests: 4, workspaceOnly: true });
  try { await child.session.prompt("Read the file"); assert.equal(calls, 2); assert.equal(child.session.getLastAssistantText(), "Reviewed the actual file"); assert.equal(ctx.sessionManager.buildSessionContext().messages.length, 0); }
  finally { await child.stop(); }
  console.error("ABI check passed: real isolated SDK session, public broker delegation, actual native file-tool execution; no network or paid calls.");
 } finally { await fs.rm(cwd, { recursive: true, force: true }); }
}
