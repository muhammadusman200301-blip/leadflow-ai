// Plain node:http server, no framework, so the project runs with zero dependencies.

import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { loadConfig, type Config } from "./config.ts";
import { LeadStore } from "./lib/store.ts";
import { fromManyChat, fromWebForm } from "./lib/normalize.ts";
import { verifyTwilioSignature } from "./lib/twilio.ts";
import { processLead, type Deps } from "./pipeline.ts";

const MAX_BODY = 100_000;

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function secretOk(expected: string, given: string | string[] | undefined): boolean {
  if (!expected) return true; // no secret configured (local dev)
  const g = Buffer.from(String(given ?? ""));
  const e = Buffer.from(expected);
  return g.length === e.length && timingSafeEqual(g, e);
}

export function buildServer(deps: Deps) {
  const c: Config = deps.config;

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

      if (req.method === "POST" && url.pathname === "/webhooks/manychat") {
        if (!secretOk(c.manychatSecret, req.headers["x-webhook-secret"])) return send(res, 401, { error: "bad secret" });
        const lead = fromManyChat(JSON.parse(await readBody(req)));
        const result = await processLead(lead, deps);
        // ManyChat reads this response and can branch on it (e.g. hand off to a human).
        return send(res, 200, {
          version: "v2",
          status: result.qualification?.status,
          needs_human: result.qualification?.needsHuman ?? false,
          duplicate: result.duplicate,
        });
      }

      if (req.method === "POST" && url.pathname === "/webhooks/form") {
        if (!secretOk(c.formSecret, req.headers["x-webhook-secret"])) return send(res, 401, { error: "bad secret" });
        const result = await processLead(fromWebForm(JSON.parse(await readBody(req))), deps);
        return send(res, 200, result);
      }

      if (req.method === "POST" && url.pathname === "/webhooks/twilio/status") {
        const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
        const fullUrl = `${c.publicBaseUrl}${url.pathname}`;
        if (c.twilioToken && !verifyTwilioSignature(c.twilioToken, fullUrl, params, String(req.headers["x-twilio-signature"] ?? ""))) {
          return send(res, 403, { error: "bad signature" });
        }
        // Delivery monitoring: log failures so they show up in alerts.
        if (["failed", "undelivered"].includes(params.MessageStatus)) {
          console.error("[leadflow] WhatsApp delivery failed", params.MessageSid, params.ErrorCode);
        }
        return send(res, 200, { received: true });
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      console.error("[leadflow] error", err);
      send(res, 400, { error: (err as Error).message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const server = buildServer({ config, store: new LeadStore() });
  server.listen(config.port, () => console.log(`[leadflow] listening on :${config.port} (dryRun=${config.dryRun})`));
}
