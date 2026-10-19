import type { Tier } from "./config.ts";
// Shared extension-owned state, not Pi internals. Session IDs keep embedded SDK roots independent.
const key = Symbol.for("hempi.primary-policy");
const global = globalThis as typeof globalThis & { [key]?: Map<string, Tier> };
const policies = global[key] ??= new Map<string, Tier>();
export function primaryPolicy(sessionId: string): Tier { return policies.get(sessionId) ?? "inherit"; }
export function setPrimaryPolicy(sessionId: string, tier: Tier): void { policies.set(sessionId, tier); }
export function clearPrimaryPolicy(sessionId: string): void { policies.delete(sessionId); }
