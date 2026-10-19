import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { defaults, HARNESS_NAMES, mergeConfig, saveConfigPatch } from "../src/config.ts";
import { discoverAgentFiles } from "../src/agents.ts";
import { externalTransport } from "../src/acp/backends.ts";

const require = createRequire(import.meta.url);
test("Pi defaults stay unchanged; external profiles have opaque model/mode selectors", () => {
 const base = defaults();
 assert.deepEqual(HARNESS_NAMES, ["pi", "omp", "claude", "codex", "fx"]);
 assert.equal(base.agents.worker.harness ?? "pi", "pi");
 const config = mergeConfig(base, { agents: { worker: { harness: "codex", role: "not-a-pi-role", acpModel: "opaque model:fast", acpMode: "read-only" } } });
 assert.equal(config.agents.worker.acpModel, "opaque model:fast");
 assert.equal(base.agents.worker.acpModel, undefined);
 assert.deepEqual(base.harnesses.omp, { command: "omp", args: ["acp"] });
 assert.deepEqual(base.harnesses.fx, { command: "fx", args: ["acp"] });
});

test("strict harness and process validation", () => {
 const bad = [
  { harnesses: { nanocodex: {} } }, { harnesses: { pi: {} } },
  { agents: { worker: { harness: "nanocodex" } } },
  { agents: { worker: { acpMode: 1 } } },
  { harnesses: { omp: { shell: true } } },
  { harnesses: { omp: { command: "" } } },
  { harnesses: { omp: { command: "x\0y" } } },
  { harnesses: { omp: { args: "acp" } } },
  { harnesses: { omp: { args: Array(65).fill("x") } } },
  { harnesses: { omp: { args: Array(5).fill("x".repeat(8192)) } } },
  { harnesses: { omp: { env: { BAD: 1 } } } },
  { harnesses: { omp: { env: { "BAD=KEY": "x" } } } },
  { harnesses: { omp: { env: { BAD: "x\0" } } } },
  { harnesses: { omp: { env: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`K${i}`, ""])) } } },
  { harnesses: { omp: { env: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`K${i}`, "x".repeat(8192)])) } } },
  JSON.parse('{"harnesses":{"__proto__":{}}}'),
  JSON.parse('{"harnesses":{"omp":{"env":{"constructor":"x"}}}}'),
 ];
 for (const patch of bad) assert.throws(() => mergeConfig(defaults(), patch));
});

test("sparse patches merge per harness and do not persist defaults or inherited environment", async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), "hempi-acp-config-"));
 try {
  await saveConfigPatch({ harnesses: { omp: { command: "/custom/omp", args: ["--acp"], env: { LOCAL: "yes" } }, fx: { args: ["acp", "--quiet"] } } }, root);
  await saveConfigPatch({ harnesses: { omp: { args: ["acp"] } } }, root);
  const saved = JSON.parse(await fs.readFile(path.join(root, ".pi/hempi.json"), "utf8"));
  assert.deepEqual(saved, { harnesses: { omp: { command: "/custom/omp", args: ["acp"], env: { LOCAL: "yes" } }, fx: { args: ["acp", "--quiet"] } } });
  const config = mergeConfig(defaults(), saved);
  assert.equal(config.harnesses.omp?.command, "/custom/omp");
  assert.equal(config.harnesses.fx?.command, "fx");
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Markdown passes ACP fields through validation and preserves Pi model semantics", async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), "hempi-acp-md-"));
 try {
  await fs.writeFile(path.join(root, "external.md"), "---\nname: external\ndescription: External\nharness: claude\nacpModel: opaque:fast\nacpMode: read-only\nrole: absent-pi-role\n---\nExternal instructions");
  await fs.writeFile(path.join(root, "native.md"), "---\nname: native\ndescription: Native\nmodel: provider/model\nthinking: high\n---\nNative instructions");
  await fs.writeFile(path.join(root, "invalid.md"), "---\nname: invalid\ndescription: Invalid\nharness: nanocodex\n---\nNo");
  const warnings: string[] = [];
  const config = await discoverAgentFiles(defaults(), root, (message) => warnings.push(message));
  assert.equal(config.agents.external.harness, "claude");
  assert.equal(config.agents.external.acpModel, "opaque:fast");
  assert.equal(config.agents.external.acpMode, "read-only");
  assert.equal(config.agents.external.role, "absent-pi-role");
  assert.equal(config.agents.native.harness ?? "pi", "pi");
  assert.equal(config.agents.native.role, "agent-native");
  assert.deepEqual(config.roles["agent-native"], { model: "provider/model", thinkingLevel: "high" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unsupported harness/);
 } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("transport resolves local adapters and fixed argv without spawning or modifying env", () => {
 const config = defaults();
 for (const name of ["pi", "nanocodex", "unknown"]) assert.throws(() => externalTransport(name as never, config, "/workspace"));
 for (const name of ["omp", "fx"] as const) {
  const transport = externalTransport(name, config, "/workspace");
  assert.equal(transport.command, name);
  assert.deepEqual(transport.args, ["acp"]);
  assert.equal(transport.cwd, "/workspace");
 }
 for (const [name, adapter] of [["claude", "claude-agent-acp"], ["codex", "codex-acp"]] as const) {
  const transport = externalTransport(name, config, "/workspace");
  assert.equal(transport.command, process.execPath);
  assert.deepEqual(transport.args, [require.resolve(`@agentclientprotocol/${adapter}/dist/index.js`)]);
  // No mode/bypass or Codex path policy is imposed by the factory.
  assert.equal(transport.env?.INITIAL_AGENT_MODE, process.env.INITIAL_AGENT_MODE);
  assert.equal(transport.env?.CODEX_PATH, process.env.CODEX_PATH);
 }
 const flags = ["PI_SESSION_FILE", "PI_SESSION_ID", "PI_SESSION_PROVIDER", "PI_SESSION_MODEL", "PI_SESSION_REASONING_LEVEL", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_CODING_AGENT", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"];
 const before = { ...process.env };
 try {
  for (const flag of flags) process.env[flag] = "parent-session";
  process.env.HEMPI_ACP_TEST_TOKEN = "test-only-value";
  const custom = mergeConfig(config, { harnesses: { codex: { command: "/custom/adapter", args: ["a b", ";", ""], env: { HEMPI_ACP_TEST_LOCAL: "yes", PI_CODING_AGENT_DIR: "/override" } } } });
  const transport = externalTransport("codex", custom, "/workspace");
  assert.equal(transport.command, "/custom/adapter");
  assert.deepEqual(transport.args, ["a b", ";", ""]);
  for (const flag of flags) assert.equal(transport.env?.[flag], undefined);
  assert.ok(transport.env?.HEMPI_ACP_TEST_TOKEN === process.env.HEMPI_ACP_TEST_TOKEN);
  assert.equal(transport.env?.HEMPI_ACP_TEST_LOCAL, "yes");
  assert.equal(process.env.PI_CODING_AGENT_DIR, "parent-session");
  transport.args!.push("mutated");
  assert.equal(custom.harnesses.codex?.args.length, 3);
 } finally {
  for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
  Object.assign(process.env, before);
 }
});
