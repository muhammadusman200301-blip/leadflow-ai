# LeadFlow AI

From a Meta ad enquiry to a qualified lead in HubSpot, automatically.

A lead comes in from **ManyChat** (Instagram / Facebook DMs) or a **website form**. LeadFlow AI qualifies it with **OpenAI**, creates or updates the **HubSpot** contact and deal, sends a **Twilio WhatsApp** follow-up, and reports qualified leads back to **Meta Conversions API** so ads optimise for leads that actually convert.

It also ships an **MCP server**, so Claude, ChatGPT, Cursor or any MCP client can list leads, check stats and submit new leads in plain language.

Zero dependencies: plain Node.js 22 + TypeScript, `node:http`, `fetch` and `node:test`.

```mermaid
flowchart LR
    A[Instagram / Facebook DM<br/>ManyChat] -->|webhook + secret| W[LeadFlow AI<br/>Node.js]
    B[Website form] -->|webhook + secret| W
    W --> D{Already seen?}
    D -->|yes| X[Skip duplicate]
    D -->|no| Q[OpenAI qualification<br/>+ guardrails]
    Q --> H[HubSpot<br/>contact + deal + notes]
    Q -->|not disqualified| T[Twilio WhatsApp<br/>follow-up]
    Q -->|qualified| M[Meta Conversions API<br/>QualifiedLead event]
    T -->|status callback, signed| W
    W -->|status, needs_human| A
```

## What it handles

| Concern | How |
|---|---|
| Duplicate webhooks and double submits | Idempotency key per lead (`mc_<subscriber_id>`, `form_<submission_id>`) |
| Flaky APIs | Retries with exponential backoff on network errors, 429 and 5xx; fails fast on other 4xx |
| One service down | Each step (HubSpot, Twilio, CAPI) runs on its own; errors are recorded, the rest still run |
| Bad AI output | Strict JSON schema check; on failure, rule-based score and the lead is flagged `needs_human` |
| Human handoff | ManyChat gets `needs_human` back and can route the chat to a person |
| Fake webhook calls | Shared secret for ManyChat / form; HMAC-SHA1 signature check for Twilio callbacks |
| Privacy for Meta | Email, phone and names are SHA-256 hashed before being sent to CAPI |
| Delivery monitoring | Twilio status callback logs `failed` / `undelivered` messages |

## Run it

```bash
cp .env.example .env      # DRY_RUN=true logs every outbound call instead of sending it
npm start                 # http://localhost:3000
npm test                  # 20 tests, all external APIs mocked
```

Try a lead (dry run):

```bash
curl -X POST localhost:3000/webhooks/form \
  -H 'content-type: application/json' \
  -d @examples/web-form-lead.json
```

## Use it from Claude or ChatGPT (MCP)

LeadFlow AI speaks the [Model Context Protocol](https://modelcontextprotocol.io), so an AI assistant can work with your leads directly.

| Tool | What it does | Changes anything? |
|---|---|---|
| `list_leads` | Recent leads, filter by status, source or "needs a person" | No |
| `get_lead` | Full details: contact, message, AI score, CRM ids, errors | No |
| `lead_stats` | Counts by status and source, handoffs, failed integrations | No |
| `qualify_message` | Score a message without saving or sending anything | No |
| `submit_lead` | Run a lead through the full pipeline (respects `DRY_RUN`) | Yes |

**Claude Desktop, Claude Code or Cursor (local, stdio).** Add this to the client's MCP config:

```json
{
  "mcpServers": {
    "leadflow": {
      "command": "node",
      "args": ["/path/to/leadflow-ai/src/mcp.ts"],
      "env": { "DRY_RUN": "true", "LEADFLOW_STORE": "/path/to/leadflow-ai/data/leads.json" }
    }
  }
}
```

Then ask things like *"How many qualified leads came in from Instagram?"* or *"Which leads need a person to call them?"*

**ChatGPT and other remote clients (HTTP).** The main server also exposes `POST /mcp`. Set `MCP_TOKEN`, deploy it with a public HTTPS URL, and add that URL as a connector with the token as a Bearer header.

Tool errors (for example an unknown lead id) come back as readable results the model can act on, not as crashes, and only `submit_lead` is marked as able to change anything.

## Endpoints

| Method | Path | Used by |
|---|---|---|
| GET | `/health` | Uptime checks |
| POST | `/webhooks/manychat` | ManyChat "External Request" action |
| POST | `/webhooks/form` | Website enquiry form |
| POST | `/webhooks/twilio/status` | Twilio message status callback |
| POST | `/mcp` | MCP clients over HTTP (Bearer `MCP_TOKEN`) |

## Connect the real services

1. **HubSpot**: create a private app with `crm.objects.contacts.write` and `crm.objects.deals.write`, then add these contact properties: `lead_source_channel`, `ai_qualification_status`, `ai_qualification_score`, `ai_qualification_reason`, `needs_human`. Put your pipeline and stage ids in `.env`.
2. **ManyChat**: in your Instagram / Facebook flow, after the qualification questions add an **External Request** to `POST /webhooks/manychat` with header `X-Webhook-Secret`, and the body from `examples/manychat-lead.json`. Map the response field `needs_human` to a condition that hands the chat to Live Chat.
3. **Twilio**: use the WhatsApp sandbox number for testing (`whatsapp:+14155238886`). Set `PUBLIC_BASE_URL` so the status callback can reach you.
4. **Meta CAPI**: add your Pixel id and a system user access token. Use `META_TEST_EVENT_CODE` to see events in Events Manager > Test events before going live.
5. Set `DRY_RUN=false`.

## Project layout

```
src/
  server.ts          HTTP routes, webhook security and POST /mcp
  mcp.ts             MCP server (stdio and HTTP) with 5 lead tools
  pipeline.ts        The flow for one lead
  config.ts          Environment settings
  lib/
    normalize.ts     ManyChat / form payload -> one Lead shape, E.164 phones
    qualify.ts       OpenAI qualification + guardrails + rule-based fallback
    hubspot.ts       Contact upsert, deal in the right stage, timeline notes
    twilio.ts        WhatsApp send, signature verification, message copy
    metaCapi.ts      Hashed Conversions API events
    http.ts          fetch with timeout and retries
    store.ts         Idempotency and audit log (JSON file; swap for Postgres/Redis)
test/                node:test suites (pipeline + MCP) with mocked APIs
```

## Roadmap

- [x] MCP server so Claude and ChatGPT can read and submit leads
- [ ] Google Ads offline conversion upload for qualified leads (`gclid`)
- [ ] AI voice agent on Twilio Voice + ElevenLabs, transcript saved to HubSpot
- [ ] Postgres store and a small dashboard of leads by source and status
