import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createMcpHandler } from "../src/mcp.ts";
import { LeadStore } from "../src/lib/store.ts";
import { loadConfig } from "../src/config.ts";
import { processLead } from "../src/pipeline.ts";
import { fromManyChat, fromWebForm } from "../src/lib/normalize.ts";

const config = loadConfig({ DRY_RUN: "true" });

async function seeded() {
  const store = new LeadStore(null);
  const deps = { config, store, log: () => {} };
  await processLead(fromManyChat({ subscriber_id: "1", first_name: "Ayesha", phone: "03001234567", channel: "instagram", last_input: "Need a quote this week, budget 200k" }), deps);
  await processLead(fromWebForm({ submission_id: "2", name: "Ali Raza", message: "just looking" }), deps);
  await processLead(fromWebForm({ submission_id: "3", name: "X", message: "any job vacancy? sending my CV" }), deps);
  return { handle: createMcpHandler(deps), store };
}

const call = (id: number, name: string, args: object = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("MCP initialize returns server info and tools capability", async () => {
  const { handle } = await seeded();
  const res: any = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(res.result.serverInfo.name, "leadflow-ai");
  assert.ok(res.result.capabilities.tools);
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("MCP tools/list exposes read-only tools and marks submit_lead as not read-only", async () => {
  const { handle } = await seeded();
  const res: any = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = res.result.tools.map((t: any) => t.name);
  assert.deepEqual(names, ["list_leads", "get_lead", "lead_stats", "qualify_message", "submit_lead"]);
  assert.equal(res.result.tools.find((t: any) => t.name === "submit_lead").annotations.readOnlyHint, false);
});

test("list_leads filters by status, lead_stats counts everything", async () => {
  const { handle } = await seeded();
  const q: any = await handle(call(3, "list_leads", { status: "qualified" }));
  assert.equal(q.result.structuredContent.total, 1);
  assert.equal(q.result.structuredContent.leads[0].name, "Ayesha");
  const s: any = await handle(call(4, "lead_stats"));
  assert.equal(s.result.structuredContent.total, 3);
  assert.equal(s.result.structuredContent.byStatus.disqualified, 1);
});

test("get_lead returns full details, and an unknown id comes back as a tool error, not a crash", async () => {
  const { handle } = await seeded();
  const ok: any = await handle(call(5, "get_lead", { id: "mc_1" }));
  assert.equal(ok.result.structuredContent.lead.firstName, "Ayesha");
  const bad: any = await handle(call(6, "get_lead", { id: "nope" }));
  assert.equal(bad.result.isError, true);
});

test("submit_lead runs the pipeline in dry run and skips a duplicate", async () => {
  const { handle } = await seeded();
  const first: any = await handle(call(7, "submit_lead", { id: "9", name: "Sara Khan", phone: "03111234567", message: "Price for this month please, urgent" }));
  assert.equal(first.result.structuredContent.dryRun, true);
  assert.equal(first.result.structuredContent.qualification.status, "qualified");
  const again: any = await handle(call(8, "submit_lead", { id: "9", name: "Sara Khan", message: "again" }));
  assert.equal(again.result.structuredContent.duplicate, true);
});

test("unknown method and unknown tool return JSON-RPC errors", async () => {
  const { handle } = await seeded();
  const m: any = await handle({ jsonrpc: "2.0", id: 9, method: "resources/list" });
  assert.equal(m.error.code, -32601);
  const t: any = await handle(call(10, "delete_everything"));
  assert.equal(t.error.code, -32602);
});

test("stdio server answers initialize over newline-delimited JSON", async () => {
  const child = spawn(process.execPath, ["src/mcp.ts"], { env: { ...process.env, LEADFLOW_STORE: "", DRY_RUN: "true" } });
  const line = await new Promise<string>((resolve, reject) => {
    child.stdout.once("data", (d) => resolve(String(d)));
    child.once("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  });
  child.kill();
  assert.equal(JSON.parse(line).result.serverInfo.name, "leadflow-ai");
});

test("HTTP /mcp needs the bearer token and answers tools/list", async () => {
  const { buildServer } = await import("../src/server.ts");
  const cfg = loadConfig({ DRY_RUN: "true", MCP_TOKEN: "t0k3n" });
  const server = buildServer({ config: cfg, store: new LeadStore(null), log: () => {} });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  try {
    const denied = await fetch(`http://localhost:${port}/mcp`, { method: "POST", body });
    assert.equal(denied.status, 401);
    const ok = await fetch(`http://localhost:${port}/mcp`, { method: "POST", body, headers: { authorization: "Bearer t0k3n" } });
    const json: any = await ok.json();
    assert.equal(json.result.tools.length, 5);
  } finally {
    server.close();
  }
});
