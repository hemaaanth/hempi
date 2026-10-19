import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function xml(text: string): string { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
/** Output/provenance quarantine adapted from OMP v18.4.2 advisor/runtime.ts; see OMP-LICENSE. */
export function unsafeAdvisorOutput(message: AssistantMessage, source: string, granted: Set<string>): string | undefined {
 for (const block of message.content) if (block.type === "toolCall" && !granted.has(block.name)) return `Advisor requested an ungranted tool: ${block.name}`;
 const generated = message.content.flatMap((block) => block.type === "text" ? [block.text] : block.type === "toolCall" && block.name === "advise" && typeof block.arguments.note === "string" ? [block.arguments.note] : []).join("\n");
 const hazards = [
  { name: "account-deletion claim", pattern: /\buser\b.{0,80}\b(?:deleted|erased)\b.{0,80}\baccount\b/i },
  { name: "instruction override", pattern: /\bignore\s+(?:all\s+)?(?:prior|previous|earlier)\s+(?:user\s+)?instructions\b/i },
  { name: "destructive shell command", pattern: /\brm\s+(?=(?:-[a-z]+\s*)*-[a-z]*r[a-z]*)(?=(?:-[a-z]+\s*)*-[a-z]*f[a-z]*)(?:-[a-z]+\s*)+/i },
  { name: "denial instruction", pattern: /\bdeny\s+(?:this|it|the\s+request)\s+if\s+(?:asked|questioned)\b/i },
 ];
 const matched = hazards.filter((hazard) => hazard.pattern.test(generated));
 const outputOnly = matched.filter((hazard) => !hazard.pattern.test(source)).map((hazard) => hazard.name);
 if (matched.some((hazard) => hazard.name === "destructive shell command") && outputOnly.includes("instruction override")) outputOnly.push("destructive shell command");
 if (outputOnly.includes("destructive shell command") || outputOnly.length >= 3) return `Advisor output quarantined: ${[...new Set(outputOnly)].join(", ")}`;
}
/** Never forward known credential values or common token literals to the reviewer. */
export class Secrets {
 readonly #values: string[];
 constructor(values: string[] = []) { this.#values = [...new Set(values.filter((value) => value.length >= 8))].sort((a,b) => b.length - a.length); }
 static async create(ctx: ExtensionContext, model?: Model<Api>): Promise<Secrets> {
  const values = Object.entries(process.env).filter(([name]) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)).map(([,value]) => value ?? "");
  const models = new Map([ctx.model, model].filter((candidate): candidate is Model<Api> => !!candidate).map(candidate => [`${candidate.provider}/${candidate.id}`, candidate]));
  for (const candidate of models.values()) {
   const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate).catch(() => { throw new Error("Advisor credential inventory unavailable"); });
   if (!auth.ok) throw new Error("Advisor credential inventory unavailable");
   if (auth.apiKey) values.push(auth.apiKey);
   for (const [name, value] of Object.entries(auth.headers ?? {})) if (value && /authorization|api.?key|token|secret/i.test(name)) { values.push(value); if (value.startsWith("Bearer ")) values.push(value.slice(7)); }
   for (const [name, value] of Object.entries(auth.env ?? {})) if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) values.push(value);
  }
  return new Secrets(values);
 }
 text(input: string): string {
  let result = input;
  for (const secret of this.#values) result = result.replaceAll(secret, "[redacted credential]");
  return result.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[redacted credential]")
   .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*["']?\s*[:=]\s*["'])([^"'\n]+)(["'])/gi, "$1[redacted credential]$3");
 }
}
