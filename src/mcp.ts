// MCP server for LeadFlow AI, so Claude, ChatGPT or any MCP client can read and act on leads.
// Speaks JSON-RPC 2.0 over stdio (newline-delimited), as the Model Context Protocol stdio transport expects.
// Zero dependencies, like the rest of the project.

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { LeadStore } from "./lib/store.ts";
import { fromWebForm } from "./lib/normalize.ts";
import { qualifyLead } from "./lib/qualify.ts";
import { processLead, type Deps } from "./pipeline.ts";
import type { Lead, PipelineResult } from "./lib/types.ts";

const PROTOCOL_VERSION = "2025-06-18";

type Json = Record<string, any>;
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Json };

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations: Json;
  run: (args: Json, deps: Deps) => Promise<Json>;
};

function summary(id: string, lead: Lead | undefined, result: PipelineResult | undefined) {
  return {
    id,
    name: lead ? `${lead.firstName} ${lead.lastName}`.trim() : null,
    source: lead?.source ?? null,
    receivedAt: lead?.receivedAt ?? null,
    status: result?.qualification?.status ?? "unknown",
    score: result?.qualification?.score ?? null,
    needsHuman: result?.qualification?.needsHuman ?? false,
    errors: result?.errors ?? [],
  };
}

const tools: Tool[] = [
  {
    name: "list_leads",
    title: "List leads",
    description: "List recent leads, newest first. Filter by qualification status, source or whether a person needs to follow up.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["qualified", "nurture", "disqualified"] },
        source: { type: "string", enum: ["manychat_instagram", "manychat_facebook", "web_form"] },
        needsHuman: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, { store }) {
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
      const rows = store
        .all()
        .map((r) => summary(r.id, r.lead as Lead | undefined, r.result as PipelineResult | undefined))
        .filter((r) => (args.status ? r.status === args.status : true))
        .filter((r) => (args.source ? r.source === args.source : true))
        .filter((r) => (args.needsHuman === undefined ? true : r.needsHuman === args.needsHuman));
      return { total: rows.length, leads: rows.slice(0, limit) };
    },
  },
  {
    name: "get_lead",
    title: "Get one lead",
    description: "Full details of one lead: contact info, message, AI qualification, CRM ids and any integration errors.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(args, { store }) {
      const rec = store.get(String(args.id));
      if (!rec) throw new ToolError(`No lead with id "${args.id}".`);
      return { id: args.id, firstSeen: rec.firstSeen, lead: rec.lead ?? null, result: rec.result ?? null };
    },
  },
  {
    name: "lead_stats",
    title: "Lead stats",
    description: "Counts of leads by status and source, how many need a person, and how many hit an integration error.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(_args, { store }) {
      const byStatus: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      let needsHuman = 0;
      let withErrors = 0;
      const all = store.all();
      for (const r of all) {
        const s = summary(r.id, r.lead as Lead | undefined, r.result as PipelineResult | undefined);
        byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
        if (s.source) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
        if (s.needsHuman) needsHuman++;
        if (s.errors.length) withErrors++;
      }
      return { total: all.length, byStatus, bySource, needsHuman, withErrors };
    },
  },
  {
    name: "qualify_message",
    title: "Preview a qualification",
    description: "Score a message the way LeadFlow would, without saving anything or contacting anyone. Useful for testing prompts and rules.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1 },
        hasEmail: { type: "boolean", default: false },
        hasPhone: { type: "boolean", default: false },
      },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, { config, fetchImpl }) {
      const lead = fromWebForm({
        name: "Preview",
        message: String(args.message),
        email: args.hasEmail ? "preview@example.com" : undefined,
        phone: args.hasPhone ? "03001234567" : undefined,
      });
      return qualifyLead(lead, { apiKey: config.openaiKey, model: config.openaiModel, fetchImpl });
    },
  },
  {
    name: "submit_lead",
    title: "Submit a lead",
    description:
      "Run a new lead through the full pipeline: qualify, HubSpot, WhatsApp follow-up and Meta CAPI. With DRY_RUN=true nothing is sent, the calls are only logged. Duplicate ids are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Your own id for this lead, used for deduplication." },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        message: { type: "string", minLength: 1 },
      },
      required: ["name", "message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, deps) {
      const lead = fromWebForm({
        submission_id: args.id,
        name: String(args.name),
        email: args.email,
        phone: args.phone,
        message: String(args.message),
      });
      const result = await processLead(lead, { ...deps, log: () => {} });
      return { dryRun: deps.config.dryRun, ...result };
    },
  },
];

class ToolError extends Error {}

function text(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

/** Handles one JSON-RPC message. Returns the response, or null for notifications. */
export function createMcpHandler(deps: Deps) {
  return async function handle(msg: Json): Promise<Json | null> {
    const isNotification = msg.id === undefined || msg.id === null;
    const reply = (result: Json) => ({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return isNotification ? null : fail(-32600, "Invalid request");

    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "leadflow-ai", version: "0.2.0" },
          instructions: "Tools to read, summarise and submit leads from LeadFlow AI. Prefer read-only tools; submit_lead sends real messages unless DRY_RUN=true.",
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
        });
      case "tools/call": {
        const tool = tools.find((t) => t.name === msg.params?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
        try {
          const out = await tool.run(msg.params?.arguments ?? {}, deps);
          const result: ToolResult = { content: [{ type: "text", text: text(out) }], structuredContent: out };
          return reply(result);
        } catch (err) {
          // Tool failures go back to the model as a result it can read, not as a protocol error.
          const result: ToolResult = { content: [{ type: "text", text: (err as Error).message }], isError: true };
          return reply(result);
        }
      }
      default:
        return isNotification ? null : fail(-32601, `Method not found: ${msg.method}`);
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const handle = createMcpHandler({ config, store: new LeadStore(process.env.LEADFLOW_STORE ?? "data/leads.json") });
  // stdout carries protocol messages only, so all logging goes to stderr.
  console.log = (...a) => console.error(...a);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      return;
    }
    const res = await handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  });
}
