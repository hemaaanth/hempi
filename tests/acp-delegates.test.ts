import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Agents } from "../src/agents.ts";
import { defaults, mergeConfig } from "../src/config.ts";
import type { Requests } from "../src/requests.ts";

const processCode = `
const readline = require('node:readline');
let mode=false, count=0, active;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const reply=(id,result)=>send({jsonrpc:'2.0',id,result});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line), p=m.params;
 if(m.method==='initialize') reply(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true}});
 if(m.method==='session/new'||m.method==='session/load') reply(m.id,{sessionId:'external',modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]}});
 if(m.method==='session/set_mode') {mode=true;reply(m.id,{});}
 if(m.method==='session/prompt') {
  if(!mode) {send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'unsafe'}});return;}
  count++; active=m.id;
  if(p.prompt[0].text.includes('HANG'))return;
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'external',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'answer '+count+' '+ 'x'.repeat(51000)}}}});
  send({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId:'external',toolCall:{toolCallId:'t',title:'Write?'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});
 }
 if(m.id==='permission'&&m.result)reply(active,{stopReason:'end_turn'});
 if(m.method==='session/cancel') {reply(active,{stopReason:'cancelled'});}
});`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
 const end = Date.now() + 3000;
 while (!await check()) { if (Date.now() > end) throw new Error("Test condition timed out"); await sleep(10); }
}
async function fixture(code = processCode) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), "hempi-delegates-test-"));
 const file = path.join(root, "parent.jsonl"); await fs.writeFile(file, "");
 const trace = path.join(root, "methods"); await fs.writeFile(trace, "");
 code = code.replace("const m=JSON.parse(line), p=m.params;", `const m=JSON.parse(line), p=m.params; require('node:fs').appendFileSync(${JSON.stringify(trace)},(m.method||'reply')+'\\n');`);
 let session = "one", tools = ["write", "read"];
 const entries: any[] = [], branch: any[] = [];
 const ctx = { cwd: root, hasUI: false, getSystemPrompt: () => "Parent constraints", sessionManager: {
  getSessionId: () => session, getSessionFile: () => file, getBranch: () => branch,
 }, ui: { select: async () => undefined } } as unknown as ExtensionContext;
 const config = mergeConfig(defaults(), { harnesses: { omp: { command: process.execPath, args: ["-e", code] } }, agents: { worker: { harness: "omp" } } });
 const pi = { getActiveTools: () => tools, appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }); } } as unknown as ExtensionAPI;
 const agents = new Agents(pi, {} as Requests, () => config);
 return { agents, ctx, entries, branch, config, trace, methods: () => fs.readFile(trace, "utf8"), set session(value: string) { session = value; }, set tools(value: string[]) { tools = value; }, async close() { await agents.stop(); await fs.rm(root, { recursive: true, force: true }); } };
}
test("external live context is not consumption; only final standard usage reports consumed tokens", async () => {
 const code = processCode.replace("count++; active=m.id;", `count++; active=m.id;
  for(const used of [321,-1,1.5]) send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'external',update:{sessionUpdate:'usage_update',used,size:1000}}});
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'external',_meta:{hempi:{reportedTokens:999}},update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:''}}}});`)
  .replace("{stopReason:'end_turn'}", "{stopReason:'end_turn',usage:{totalTokens:17}} ");
 const f = await fixture(code);
 try {
  const id = f.agents.start("worker", "HANG", f.ctx);
  await until(() => f.agents.runs.get(id)?.contextTokens === 321);
  assert.equal(f.agents.runs.get(id)?.reportedTokens, undefined);
  const writes = f.entries.length;
  assert.ok(writes > 0);
  f.agents.runs.cancel(id); await f.agents.runs.wait(id);
  assert.equal(f.agents.runs.get(id)?.contextTokens, 321);
  const completed = await f.agents.run("worker", "Finish", f.ctx);
  assert.equal(completed.usageKnown, false);
  const info = f.agents.runs.get(completed.runId!)!;
  assert.equal(info.reportedTokens, 17);
  assert.equal(info.contextTokens, 321);
  assert.equal(info.answer.length, 50000);
  assert.ok(info.finishedAt! >= info.runningAt!);
 } finally { await f.close(); }
});

test("readonly, dangerous modes and primary writer bypass fail before spawn", async () => {
 const f = await fixture();
 try {
  assert.throws(() => f.agents.start("scout", "Inspect", f.ctx, { harness: "omp" }), /read-only grants/);
  f.config.agents.worker.acpMode = "bypassPermissions";
  assert.throws(() => f.agents.start("worker", "Write", f.ctx), /safe mode/);
  f.config.agents.worker.acpMode = undefined; f.tools = ["read"];
  assert.throws(() => f.agents.start("worker", "Write", f.ctx), /read-only loadout/);
  assert.equal(f.entries.length, 0);
  assert.deepEqual((await fs.readdir(f.ctx.cwd)).sort(), ["methods", "parent.jsonl"]);
 } finally { await f.close(); }
});
test("queued cancellation never spawns; stop cancels live tasks and session restore deduplicates", async () => {
 const f = await fixture();
 try {
  const ids = Array.from({ length: 6 }, () => f.agents.start("worker", "HANG", f.ctx));
  f.agents.runs.cancel(ids[5]);
  assert.equal((await f.agents.runs.wait(ids[5])).state, "cancelled");
  const old = f.agents.runs;
  await f.agents.stop();
  assert.ok(old.list().every(run => run.state === "cancelled"));
  const saved = { ...old.get(ids[0])!, state: "running" };
  f.branch.push(...[saved, { ...saved, progress: "newest" }].map(data => ({ type: "custom", customType: "hempi.run", data })));
  f.session = "two"; f.agents.restore(f.ctx);
  assert.notEqual(f.agents.runs, old);
  assert.equal(f.agents.runs.list().length, 1);
  assert.equal(f.agents.runs.get(saved.id)?.state, "interrupted");
  assert.equal(f.agents.runs.get(saved.id)?.progress, "newest");
  f.agents.restore(f.ctx); assert.equal(f.agents.runs.list().length, 1);
 } finally { await f.close(); }
});
test("permission dialogs are explicit and globally serialized; stop awaits running process cleanup", async () => {
 const a = await fixture(), b = await fixture();
 let active = 0, peak = 0, selected = 0;
 for (const f of [a, b]) {
  Object.assign(f.ctx, { hasUI: true, ui: { select: async (_title: string, options: string[], { signal }: { signal: AbortSignal }) => {
   assert.equal(signal.aborted, false); active++; peak = Math.max(peak, active);
   await new Promise(resolve => setTimeout(resolve, 30)); active--; selected++;
   return options[1];
  } } });
 }
 try {
  const results = await Promise.all([a.agents.run("worker", "Review permission", a.ctx), b.agents.run("worker", "Review permission", b.ctx)]);
  assert.ok(results.every(result => result.status === "completed"));
  assert.equal(selected, 2); assert.equal(peak, 1);
  const id = a.agents.start("worker", "HANG", a.ctx);
  await new Promise(resolve => setTimeout(resolve, 100));
  await a.agents.stop();
  assert.equal((await a.agents.runs.wait(id)).state, "cancelled");
 } finally { await a.close(); await b.close(); }
});
test("abort during initialize, session open or model setup closes startup without prompting", async () => {
 for (const stage of ["initialize", "session/new", "session/set_config_option"]) {
  const code = processCode.replace("sessionId:'external',modes:", "sessionId:'external',configOptions:[{id:'model',name:'Model',type:'select',currentValue:'test-model',options:[{value:'test-model',name:'Test'}]}],modes:");
  const f = await fixture(code.replace("if(m.method==='initialize') reply", `if(m.method==='${stage}')return; if(m.method==='initialize') reply`));
  try {
   f.config.agents.worker.acpModel = "test-model";
   const id = f.agents.start("worker", "Never prompt", f.ctx);
   await until(async () => (await f.methods()).includes(stage + "\n"));
   const started = Date.now(); f.agents.runs.cancel(id);
   await until(() => f.agents.runs.get(id)?.state === "cancelled");
   assert.ok(Date.now() - started < 2000);
   assert.equal((await f.methods()).includes("session/prompt"), false);
   assert.equal((f.agents as any).peers.size, 0);
  } finally { await f.close(); }
 }
});
test("abort while constructing instruction handoff is checked immediately before prompt", async () => {
 const f = await fixture();
 try {
  let id = "", running = false, reads = 0;
  f.ctx.getSystemPrompt = () => {
   if (running && ++reads === 2) f.agents.runs.cancel(id);
   return "Parent constraints";
  };
  f.agents.restore(f.ctx);
  f.agents.runs.subscribe(info => { if (info.state === "running") { running = true; reads = 0; } });
  id = f.agents.start("worker", "Never prompt", f.ctx);
  assert.equal((await f.agents.runs.wait(id)).state, "cancelled");
  assert.equal((await f.methods()).includes("session/prompt"), false);
 } finally { await f.close(); }
});
test("failed transcript removes poisoned peer and permits fresh external load", async () => {
 const f = await fixture();
 try {
  const result = await f.agents.run("worker", "First", f.ctx), id = result.runId!;
  const peer = (f.agents as any).peers.get(id);
  peer.log.flush = async () => { throw new Error("log failed"); };
  f.agents.followup(id, "Broken log", f.ctx);
  assert.equal((await f.agents.runs.wait(id)).state, "failed");
  assert.equal((f.agents as any).peers.has(id), false);
  f.agents.followup(id, "Fresh load", f.ctx);
  assert.equal((await f.agents.runs.wait(id)).state, "completed");
  assert.ok((await f.methods()).includes("session/load"));
 } finally { await f.close(); }
});
test("idle peer retention is bounded and record eviction awaits process cleanup at stop", async () => {
 const f = await fixture();
 try {
  const ids: string[] = [];
  for (let i = 0; i < 18; i++) ids.push((await f.agents.run("worker", "First", f.ctx)).runId!);
  assert.equal((f.agents as any).peers.size, 16);
  assert.equal((f.agents as any).peers.has(ids[0]), false);
  const template = f.agents.runs.get(ids[2])!;
  f.agents.runs.restore(Array.from({ length: 182 }, (_, i) => ({ ...template, id: `filler-${i}`, updatedAt: Date.now() + 10000 })));
  for (let i = 0; i < 3; i++) await f.agents.run("worker", "Evict oldest", f.ctx);
  assert.equal(f.agents.runs.get(ids[2]), undefined);
  assert.equal((f.agents as any).peers.has(ids[2]), false);
  await f.agents.stop();
  assert.equal((f.agents as any).cleanups.size, 0);
  assert.equal((f.agents as any).peers.size, 0);
 } finally { await f.close(); }
});
test("retained and restored profiles reject changed grants, roles and parent constraints", async () => {
 const f = await fixture();
 try {
  const result = await f.agents.run("worker", "First", f.ctx), id = result.runId!;
  const definition = f.config.agents.worker;
  for (const patch of [{ tools: ["write"] }, { instructions: "New rules" }, { role: "smol" }, { maxRequests: 1 }, { acpModel: "other" }, { harness: "fx" as const }]) {
   const original = { ...definition };
   Object.assign(definition, patch);
   assert.throws(() => f.agents.followup(id, "Again", f.ctx), /changed/);
   for (const key of Object.keys(definition)) delete (definition as any)[key];
   Object.assign(definition, original);
  }
  f.config.roles.task.maxTokens = 17;
  assert.throws(() => f.agents.followup(id, "Again", f.ctx), /changed/);
  delete f.config.roles.task.maxTokens;
  const originalPrompt = f.ctx.getSystemPrompt;
  f.ctx.getSystemPrompt = () => "Different constraints";
  assert.throws(() => f.agents.followup(id, "Again", f.ctx), /changed/);
  f.ctx.getSystemPrompt = originalPrompt;
  const saved = f.agents.runs.get(id)!;
  assert.equal(typeof (saved.extra as any).fingerprint, "string");
  await f.agents.stop();
  f.branch.push({ type: "custom", customType: "hempi.run", data: saved });
  f.agents.restore(f.ctx); definition.instructions = "Changed after restore";
  assert.throws(() => f.agents.followup(id, "Again", f.ctx), /changed/);
 } finally { await f.close(); }
});
test("profile changes after queueing reject before acquiring changed writer grants", async () => {
 const f = await fixture();
 let release!: () => void, acquired = false;
 const lease = withFileMutationQueue(path.join(f.ctx.cwd, ".hempi-worker-lease"), async () => {
  acquired = true; await new Promise<void>(resolve => { release = resolve; });
 });
 try {
  await until(() => acquired);
  const id = f.agents.start("worker", "Queued", f.ctx);
  await sleep(30);
  f.config.agents.worker.instructions = "Reloaded";
  release(); await lease;
  assert.match((await f.agents.runs.wait(id)).error!, /changed/);
  assert.equal(await f.methods(), "");
  const second = f.agents.start("worker", "Queued again", f.ctx);
  f.tools = ["read"];
  assert.match((await f.agents.runs.wait(second)).error!, /read-only loadout/);
 } finally { release?.(); await lease; await f.close(); }
});
test("queued followup revalidates its launch snapshot before execution", async () => {
 const f = await fixture();
 let release!: () => void, acquired = false;
 let lease: Promise<void> | undefined;
 try {
  const id = (await f.agents.run("worker", "First", f.ctx)).runId!;
  lease = withFileMutationQueue(path.join(f.ctx.cwd, ".hempi-worker-lease"), async () => {
   acquired = true; await new Promise<void>(resolve => { release = resolve; });
  });
  await until(() => acquired);
  f.agents.followup(id, "Queued followup", f.ctx); await sleep(30);
  f.config.agents.worker.tools = ["write"];
  release(); await lease;
  assert.match((await f.agents.runs.wait(id)).error!, /changed/);
  assert.equal((await f.methods()).split("session/prompt").length - 1, 1);
 } finally { release?.(); await lease; await f.close(); }
});
test("cancel second writer while first remains running", async () => {
 const f = await fixture();
 try {
  const first = f.agents.start("worker", "HANG", f.ctx);
  await until(async () => (await f.methods()).includes("session/prompt"));
  const second = f.agents.start("worker", "Must never prompt", f.ctx);
  await sleep(30); f.agents.runs.cancel(second);
  await until(() => f.agents.runs.get(second)?.state === "cancelled");
  assert.equal(f.agents.runs.get(first)?.state, "running");
  assert.equal((await f.methods()).split("session/prompt").length - 1, 1);
 } finally { await f.close(); }
});
test("restore during startup cannot attach an old peer to the new generation", async () => {
 const f = await fixture(processCode.replace("if(m.method==='initialize') reply", "if(m.method==='session/new')return; if(m.method==='initialize') reply"));
 try {
  const id = f.agents.start("worker", "Old generation", f.ctx), old = f.agents.runs;
  await until(async () => (await f.methods()).includes("session/new"));
  f.session = "new-generation"; f.agents.restore(f.ctx);
  const current = f.agents.runs;
  assert.notEqual(current, old);
  await until(() => old.get(id)?.state === "cancelled");
  assert.equal((f.agents as any).peers.size, 0);
  assert.equal(current.list().length, 0);
  assert.equal((await f.methods()).includes("session/prompt"), false);
 } finally { await f.close(); }
});
test("writer lease wait cancels promptly without releasing another writer's lock", async () => {
 const f = await fixture();
 let release!: () => void, acquired = false;
 const lease = withFileMutationQueue(path.join(f.ctx.cwd, ".hempi-worker-lease"), async () => {
  acquired = true; await new Promise<void>(resolve => { release = resolve; });
 });
 try {
  await until(() => acquired);
  const id = f.agents.start("worker", "Must never start", f.ctx);
  await sleep(30); f.agents.runs.cancel(id);
  await until(() => f.agents.runs.get(id)?.state === "cancelled");
  await f.agents.stop();
  let next = false;
  const tail = withFileMutationQueue(path.join(f.ctx.cwd, ".hempi-worker-lease"), async () => { next = true; });
  await sleep(30); assert.equal(next, false);
  release(); await lease; await tail;
  assert.equal(await f.methods(), "");
 } finally { release?.(); await lease; await f.close(); }
});
test("cold external resume requires a small canonical marker, never a stored path", async () => {
 for (const kind of ["legacy", "missing", "oversized", "invalid", "session"]) {
  const f = await fixture();
  try {
   const id = (await f.agents.run("worker", "First", f.ctx)).runId!;
   const saved = f.agents.runs.get(id)!;
   const markerFile = path.join(path.dirname(saved.file!), `${id}.checkpoint.json`);
   const extra = saved.extra as any;
   if (kind === "legacy") delete extra.checkpoint;
   if (kind === "missing") {
    extra.checkpointFile = markerFile + ".alternate";
    await fs.rename(markerFile, extra.checkpointFile);
   }
   if (kind === "oversized") await fs.writeFile(markerFile, " ".repeat(4097));
   if (kind === "invalid") await fs.writeFile(markerFile, "null");
   if (kind === "session") await fs.writeFile(markerFile, JSON.stringify({ sessionId: "other", nonce: extra.checkpoint }));
   await f.agents.stop();
   f.branch.push({ type: "custom", customType: "hempi.run", data: saved });
   f.agents.restore(f.ctx);
   const before = await f.methods();
   f.agents.followup(id, "Resume", f.ctx);
   assert.match((await f.agents.runs.wait(id)).error!, /checkpoint/);
   assert.equal(await f.methods(), before);
  } finally { await f.close(); }
 }
});
test("checkpoint write failure and cancellation cannot send another prompt", async () => {
 for (const cancel of [false, true]) {
  const f = await fixture();
  try {
   const id = (await f.agents.run("worker", "First", f.ctx)).runId!;
   const saved = f.agents.runs.get(id)!;
   const markerFile = path.join(path.dirname(saved.file!), `${id}.checkpoint.json`);
   if (cancel) await fs.writeFile(markerFile + ".lock", "locked");
   else { await fs.rm(markerFile); await fs.mkdir(markerFile); }
   f.agents.followup(id, "Never prompt", f.ctx);
   if (cancel) {
    await sleep(50);
    f.agents.runs.cancel(id);
    await fs.rm(markerFile + ".lock");
   }
   assert.equal((await f.agents.runs.wait(id)).state, cancel ? "cancelled" : "failed");
   await f.agents.stop();
   assert.equal((await f.methods()).split("session/prompt").length - 1, 1);
  } finally { await f.close(); }
 }
});
test("no-session external turns and readonly rejection create no artifacts", async () => {
 const f = await fixture();
 try {
  f.ctx.sessionManager.getSessionFile = () => undefined;
  assert.throws(() => f.agents.start("scout", "Inspect", f.ctx, { harness: "omp" }), /read-only grants/);
  const id = (await f.agents.run("worker", "First", f.ctx)).runId!;
  f.agents.followup(id, "Second", f.ctx);
  const saved = await f.agents.runs.wait(id);
  assert.equal(saved.state, "completed");
  assert.equal(saved.file, undefined);
  assert.equal((saved.extra as any).checkpoint, undefined);
  assert.deepEqual((await fs.readdir(f.ctx.cwd)).sort(), ["methods", "parent.jsonl"]);
  await f.agents.stop();
  f.branch.push({ type: "custom", customType: "hempi.run", data: saved });
  f.agents.restore(f.ctx);
  const before = await f.methods();
  f.agents.followup(id, "Cold resume", f.ctx);
  assert.match((await f.agents.runs.wait(id)).error!, /checkpoint is missing/);
  assert.equal(await f.methods(), before);
 } finally { await f.close(); }
});
test("hung and failed external prompts dirty the checkpoint before sending", async () => {
 for (const task of ["HANG", "FAIL"]) {
  const f = await fixture(processCode.replace("count++; active=m.id;", "count++; active=m.id; if(p.prompt[0].text.endsWith('FAIL')) {send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'failed prompt'}});return;}"));
  try {
   const id = (await f.agents.run("worker", "Turn A", f.ctx)).runId!;
   const saved = f.agents.runs.get(id)!;
   f.agents.followup(id, task, f.ctx);
   await until(async () => (await f.methods()).split("session/prompt").length === 3);
   const marker = JSON.parse(await fs.readFile(path.join(path.dirname(saved.file!), `${id}.checkpoint.json`), "utf8"));
   assert.notEqual(marker.nonce, (saved.extra as any).checkpoint);
   assert.equal(marker.nonce, (f.agents.runs.get(id)!.extra as any).checkpoint);
   if (task === "HANG") f.agents.runs.cancel(id);
   else assert.equal((await f.agents.runs.wait(id)).state, "failed");
   await f.agents.stop();
   f.branch.push({ type: "custom", customType: "hempi.run", data: saved });
   f.agents.restore(f.ctx);
   const before = await f.methods();
   f.agents.followup(id, "Old branch", f.ctx);
   assert.match((await f.agents.runs.wait(id)).error!, /advanced beyond/);
   assert.equal(await f.methods(), before);
  } finally { await f.close(); }
 }
});
test("external checkpoints reject abandoned futures before spawn but permit latest restore", async () => {
 const f = await fixture();
 try {
  const id = (await f.agents.run("worker", "Turn A", f.ctx)).runId!;
  const savedA = f.agents.runs.get(id)!;
  const markerFile = path.join(path.dirname(savedA.file!), `${id}.checkpoint.json`);
  const markerA = JSON.parse(await fs.readFile(markerFile, "utf8"));
  assert.deepEqual(markerA, { sessionId: savedA.sessionId, nonce: (savedA.extra as any).checkpoint });
  assert.equal((await fs.stat(markerFile)).mode & 0o777, 0o600);
  assert.notEqual(savedA.file, markerFile);
  f.agents.followup(id, "Turn B", f.ctx);
  const savedB = await f.agents.runs.wait(id);
  assert.notEqual((savedA.extra as any).checkpoint, (savedB.extra as any).checkpoint);
  await f.agents.stop();
  f.branch.push({ type: "custom", customType: "hempi.run", data: savedA });
  f.agents.restore(f.ctx);
  const before = await f.methods();
  f.agents.followup(id, "Abandoned branch", f.ctx);
  assert.match((await f.agents.runs.wait(id)).error!, /External session advanced beyond this parent checkpoint; start a new run/);
  assert.equal(await f.methods(), before);
  await f.agents.stop();
  f.branch.push({ type: "custom", customType: "hempi.run", data: savedB });
  f.agents.restore(f.ctx);
  f.agents.followup(id, "Latest branch", f.ctx);
  assert.equal((await f.agents.runs.wait(id)).state, "completed");
  assert.ok((await f.methods()).includes("session/load"));
 } finally { await f.close(); }
});
test("external safe mode, capped answer/full private log, unknown usage, retained followup and restored resume", async () => {
 const f = await fixture();
 try {
  const result = await f.agents.run("worker", "Do work", f.ctx);
  assert.equal(result.status, "completed"); assert.equal(result.usageKnown, false);
  assert.equal(result.answer.length, 50000); assert.ok(result.runId);
  assert.equal((await fs.stat(result.file!)).mode & 0o777, 0o600);
  assert.ok((await fs.readFile(result.file!, "utf8")).includes("x".repeat(51000)));
  f.agents.followup(result.runId!, "Another", f.ctx);
  assert.match((await f.agents.runs.wait(result.runId!)).answer, /^answer 2/);
  const saved = f.agents.runs.get(result.runId!)!;
  await f.agents.stop();
  f.branch.push({ type: "custom", customType: "hempi.run", data: saved });
  f.agents.restore(f.ctx);
  f.agents.followup(result.runId!, "Resume", f.ctx);
  assert.equal((await f.agents.runs.wait(result.runId!)).state, "completed");
 } finally { await f.close(); }
});
