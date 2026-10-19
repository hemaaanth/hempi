import { createRequire } from "node:module";
import type { AcpTransport } from "./client.ts";
import { defaults, HARNESS_NAMES, type Config, type ExternalHarnessName } from "../config.ts";

const require = createRequire(import.meta.url);
const sessionEnv = [
 "PI_SESSION_FILE", "PI_SESSION_ID", "PI_SESSION_PROVIDER", "PI_SESSION_MODEL",
 "PI_SESSION_REASONING_LEVEL", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL",
 "PI_CODING_AGENT", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR",
];

/** Resolve only; the ACP client owns spawning (without a shell) and process lifetime. */
export function externalTransport(name: ExternalHarnessName, config: Config, cwd: string): Extract<AcpTransport, { command: string }> {
 if (!HARNESS_NAMES.some((harness) => harness !== "pi" && harness === name)) throw new Error("Unsupported external harness");
 const backend = config.harnesses[name] ?? defaults().harnesses[name]!;
 let command = backend.command;
 let args = [...backend.args];
 if ((name === "claude" && command === "claude-agent-acp") || (name === "codex" && command === "codex-acp")) {
  const entry = require.resolve(`@agentclientprotocol/${command}/dist/index.js`);
  command = process.execPath;
  args = [entry, ...args];
 }
 const env = { ...process.env, ...backend.env };
 // External agents must not attach to, or reuse storage from, the parent's Pi session.
 for (const key of sessionEnv) delete env[key];
 return { command, args, cwd, env };
}
