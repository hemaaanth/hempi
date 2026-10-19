import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { emptyUsage } from '../src/requests.ts';

/** CLI contract tests must never reach a paid provider, including the default compactor. */
export default function fixture(pi: ExtensionAPI) {
  for (const provider of ['hempi-test', 'openai-codex']) pi.registerProvider(provider, {
    apiKey: 'test-only', baseUrl: 'http://127.0.0.1:1', api: 'hempi-optchat-test',
    models: ['main', 'gpt-6-luna', 'gpt-6-sol'].map(id => ({ id, name: id, reasoning: true,
      input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: JSON.stringify({ tools: getCurrentTools(context.messages).map(tool => tool.name), summary: 'FAKE COMPACTION SUMMARY' }) }],
        usage: emptyUsage(), timestamp: Date.now(), stopReason: 'stop' };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); });
      return stream;
    },
  });
  pi.registerCommand('test-tools', { description: 'Test-only tool snapshot', handler: async (_args, ctx) => {
    ctx.ui.notify(JSON.stringify({ tools: pi.getActiveTools() }), 'info');
  } });
}
