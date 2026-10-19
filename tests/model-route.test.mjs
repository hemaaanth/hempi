import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findModel } from '../src/model-route.ts';

test('Codex models resolve through Model Gateway only inside a routed turn', () => {
  const models = new Map([['openai-codex/gpt-6-sol', 'direct'], ['model-gateway/gpt-6-sol', 'gateway']]);
  const registry = { find: (provider, id) => models.get(`${provider}/${id}`) };
  const saved = process.env.MODEL_GATEWAY_BASE_URL;
  try {
    delete process.env.MODEL_GATEWAY_BASE_URL;
    assert.equal(findModel(registry, 'openai-codex', 'gpt-6-sol'), 'direct');
    process.env.MODEL_GATEWAY_BASE_URL = 'http://gateway.test/v1';
    assert.equal(findModel(registry, 'openai-codex', 'gpt-6-sol'), 'gateway');
    assert.equal(findModel(registry, 'openai-codex', 'gpt-6.1-sol'), undefined);
    assert.equal(findModel(registry, 'openai', 'gpt-6-sol'), undefined);
  } finally {
    if (saved === undefined) delete process.env.MODEL_GATEWAY_BASE_URL; else process.env.MODEL_GATEWAY_BASE_URL = saved;
  }
});
