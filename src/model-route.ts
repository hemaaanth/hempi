/** Model Gateway's Pi extension registers this provider with the gateway's model IDs. */
export const GATEWAY_PROVIDER = "model-gateway";

/**
 * Inside a gateway-routed turn, a Codex model resolves to the gateway's
 * model of the same name, so hosts without a Codex login still work.
 * Elsewhere, or when the gateway lacks the model, it resolves as given.
 */
export function findModel<T>(registry: { find(provider: string, id: string): T | undefined }, provider: string, id: string): T | undefined {
 if (provider === "openai-codex" && process.env.MODEL_GATEWAY_BASE_URL) {
  const routed = registry.find(GATEWAY_PROVIDER, id);
  if (routed) return routed;
 }
 return registry.find(provider, id);
}
