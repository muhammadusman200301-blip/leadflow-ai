import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { toE164, normalizeEmail, fromManyChat, fromWebForm } from "../src/lib/normalize.ts";
import { ruleBasedQualify, validate, qualifyLead } from "../src/lib/qualify.ts";
import { verifyTwilioSignature } from "../src/lib/twilio.ts";
import { buildLeadEvent, sha256 } from "../src/lib/metaCapi.ts";
import { requestJson } from "../src/lib/http.ts";
import { LeadStore } from "../src/lib/store.ts";
import { processLead } from "../src/pipeline.ts";
import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";

// A fake fetch that records calls and answers by URL.
function mockFetch(routes: Record<string, (body: any) => { status?: number; json: unknown }>) {
  const calls: { url: string; body: any }[] = [];
  const impl = (async (url: string, init: any) => {
    const body = init?.body && String(init.body).startsWith("{") ? JSON.parse(init.body) : init?.body;
    calls.push({ url, body });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("no route", { status: 404 });
    const r = routes[key](body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const sampleManyChat = {
  subscriber_id: "123",
  first_name: "Ayesha",
  last_name: "Khan",
  email: " Ayesha@Example.com ",
  phone: "0300-1234567",
  channel: "instagram",
  last_input: "Need a quote this week, budget around 200k PKR",
  custom_fields: { service: "website" },
  ad_id: "ad_42",
};

test("phone numbers become E.164", () => {
  assert.equal(toE164("0300-1234567"), "+923001234567");
  assert.equal(toE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(toE164("0044 20 7946 0958"), "+442079460958");
  assert.equal(toE164("12"), null);
});

test("emails are trimmed, lowercased and validated", () => {
  assert.equal(normalizeEmail(" A@B.com "), "a@b.com");
  assert.equal(normalizeEmail("not-an-email"), null);
});

test("ManyChat and web form payloads normalise to one Lead shape", () => {
  const a = fromManyChat(sampleManyChat);
  assert.equal(a.externalId, "mc_123");
  assert.equal(a.source, "manychat_instagram");
  assert.equal(a.email, "ayesha@example.com");
  const b = fromWebForm({ submission_id: "s1", name: "Ali Raza Shah", email: "ali@x.pk", phone: "03111234567", message: "hi" });
  assert.equal(b.firstName, "Ali");
  assert.equal(b.lastName, "Raza Shah");
});

test("rule-based qualifier: budget + timeline + phone = qualified, job seekers = disqualified", () => {
  assert.equal(ruleBasedQualify(fromManyChat(sampleManyChat)).status, "qualified");
  const job = fromWebForm({ name: "X", message: "Is there any job vacancy? sending my CV" });
  assert.equal(ruleBasedQualify(job).status, "disqualified");
});

test("guardrail rejects malformed model output", () => {
  assert.throws(() => validate({ status: "maybe", score: 50 }));
  assert.equal(validate({ status: "qualified", score: 140, reason: "x" }).score, 100);
});

test("if OpenAI fails, the lead still gets a score and is flagged for a human", async () => {
  const { impl } = mockFetch({ "api.openai.com": () => ({ status: 400, json: { error: "bad" } }) });
  const q = await qualifyLead(fromManyChat(sampleManyChat), { apiKey: "k", model: "m", fetchImpl: impl });
  assert.equal(q.needsHuman, true);
  assert.equal(q.status, "qualified");
});

test("requestJson retries on 503 and then succeeds", async () => {
  let n = 0;
  const impl = (async () => (++n < 2 ? new Response("down", { status: 503 }) : new Response('{"ok":true}'))) as unknown as typeof fetch;
  const res = await requestJson<any>("https://x.test", { fetchImpl: impl, retries: 2 });
  assert.deepEqual(res, { ok: true });
  assert.equal(n, 2);
});

test("Twilio signature check accepts genuine requests and rejects forged ones", () => {
  const token = "secret";
  const url = "https://app.test/webhooks/twilio/status";
  const params = { MessageSid: "SM1", MessageStatus: "delivered" };
  const data = url + Object.keys(params).sort().map((k) => k + (params as any)[k]).join("");
  const sig = createHmac("sha1", token).update(data).digest("base64");
  assert.equal(verifyTwilioSignature(token, url, params, sig), true);
  assert.equal(verifyTwilioSignature(token, url, params, "forged"), false);
});

test("Meta CAPI event hashes personal data and carries an event_id for dedup", () => {
  const ev = buildLeadEvent(fromManyChat(sampleManyChat), "QualifiedLead", "mc_123");
  assert.deepEqual(ev.user_data.em, [sha256("ayesha@example.com")]);
  assert.equal(ev.event_id, "mc_123");
  assert.ok(!JSON.stringify(ev).includes("ayesha@example.com"));
});

test("full pipeline: HubSpot contact + deal, WhatsApp, CAPI, and duplicates are skipped", async () => {
  const { impl, calls } = mockFetch({
    "api.openai.com": () => ({ json: { choices: [{ message: { content: '{"status":"qualified","score":82,"reason":"budget and timeline","needsHuman":false}' } }] } }),
    "/contacts/search": () => ({ json: { results: [] } }),
    "/crm/v3/objects/contacts": () => ({ json: { id: "c1" } }),
    "/crm/v3/objects/deals": () => ({ json: { id: "d1" } }),
    "/crm/v3/objects/notes": () => ({ json: { id: "n1" } }),
    "api.twilio.com": () => ({ json: { sid: "SM1" } }),
    "graph.facebook.com": () => ({ json: { events_received: 1 } }),
  });
  const config = loadConfig({
    OPENAI_API_KEY: "k", HUBSPOT_TOKEN: "h", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t",
    TWILIO_WHATSAPP_FROM: "whatsapp:+1", META_PIXEL_ID: "p", META_ACCESS_TOKEN: "m", DRY_RUN: "false",
  });
  const deps = { config, store: new LeadStore(null), fetchImpl: impl, log: () => {} };

  const r = await processLead(fromManyChat(sampleManyChat), deps);
  assert.deepEqual(r.errors, []);
  assert.equal(r.hubspotContactId, "c1");
  assert.equal(r.hubspotDealId, "d1");
  assert.equal(r.whatsappSid, "SM1");
  assert.equal(r.capiSent, true);
  const deal = calls.find((c) => c.url.includes("/deals"))!;
  assert.equal(deal.body.properties.dealstage, "appointmentscheduled");

  const again = await processLead(fromManyChat(sampleManyChat), deps);
  assert.equal(again.duplicate, true);
});

test("one failing service does not stop the others", async () => {
  const { impl } = mockFetch({
    "/contacts/search": () => ({ status: 401, json: { message: "bad token" } }),
    "api.twilio.com": () => ({ json: { sid: "SM2" } }),
    "graph.facebook.com": () => ({ json: { events_received: 1 } }),
  });
  const config = loadConfig({ HUBSPOT_TOKEN: "h", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", META_PIXEL_ID: "p", META_ACCESS_TOKEN: "m", DRY_RUN: "false" });
  const r = await processLead(fromManyChat({ ...sampleManyChat, subscriber_id: "999" }), { config, store: new LeadStore(null), fetchImpl: impl, log: () => {} });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^hubspot:/);
  assert.equal(r.whatsappSid, "SM2");
});

test("HTTP: ManyChat webhook needs the shared secret and returns a status ManyChat can branch on", async () => {
  const config = loadConfig({ MANYCHAT_WEBHOOK_SECRET: "s3cret", DRY_RUN: "true" });
  const server = buildServer({ config, store: new LeadStore(null), log: () => {} });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    const bad = await fetch(`http://localhost:${port}/webhooks/manychat`, { method: "POST", body: "{}", headers: { "x-webhook-secret": "nope" } });
    assert.equal(bad.status, 401);
    const ok = await fetch(`http://localhost:${port}/webhooks/manychat`, {
      method: "POST", body: JSON.stringify(sampleManyChat), headers: { "x-webhook-secret": "s3cret" },
    });
    const json: any = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(json.status, "qualified");
  } finally {
    server.close();
  }
});
