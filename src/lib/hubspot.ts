import type { Lead, Qualification } from "./types.ts";
import { requestJson, type FetchLike } from "./http.ts";

const BASE = "https://api.hubapi.com";

type Opts = { token: string; pipelineId: string; stageQualified: string; stageNurture: string; fetchImpl?: FetchLike };

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/**
 * Custom contact properties used below. Create them once in HubSpot (Settings > Properties):
 * lead_source_channel, ai_qualification_status, ai_qualification_score, ai_qualification_reason, needs_human
 */
function contactProps(lead: Lead, q: Qualification) {
  return {
    firstname: lead.firstName,
    lastname: lead.lastName,
    ...(lead.email ? { email: lead.email } : {}),
    ...(lead.phone ? { phone: lead.phone } : {}),
    lead_source_channel: lead.source,
    ai_qualification_status: q.status,
    ai_qualification_score: String(q.score),
    ai_qualification_reason: q.reason,
    needs_human: q.needsHuman ? "true" : "false",
  };
}

/** Finds the contact by email, then phone. Updates it if found, creates it if not. */
export async function upsertContact(lead: Lead, q: Qualification, o: Opts): Promise<string> {
  const filters = lead.email
    ? [{ propertyName: "email", operator: "EQ", value: lead.email }]
    : lead.phone
      ? [{ propertyName: "phone", operator: "EQ", value: lead.phone }]
      : [];

  if (filters.length) {
    const found = await requestJson<any>(`${BASE}/crm/v3/objects/contacts/search`, {
      method: "POST",
      headers: headers(o.token),
      body: JSON.stringify({ filterGroups: [{ filters }], limit: 1, properties: ["email"] }),
      fetchImpl: o.fetchImpl,
    });
    const id = found.results?.[0]?.id;
    if (id) {
      await requestJson(`${BASE}/crm/v3/objects/contacts/${id}`, {
        method: "PATCH",
        headers: headers(o.token),
        body: JSON.stringify({ properties: contactProps(lead, q) }),
        fetchImpl: o.fetchImpl,
      });
      return id;
    }
  }

  const created = await requestJson<any>(`${BASE}/crm/v3/objects/contacts`, {
    method: "POST",
    headers: headers(o.token),
    body: JSON.stringify({ properties: contactProps(lead, q) }),
    fetchImpl: o.fetchImpl,
  });
  return created.id;
}

/** Creates a deal in the right stage and links it to the contact. Disqualified leads get no deal. */
export async function createDeal(lead: Lead, q: Qualification, contactId: string, o: Opts): Promise<string | undefined> {
  if (q.status === "disqualified") return undefined;
  const deal = await requestJson<any>(`${BASE}/crm/v3/objects/deals`, {
    method: "POST",
    headers: headers(o.token),
    body: JSON.stringify({
      properties: {
        dealname: `${lead.firstName} ${lead.lastName}`.trim() + ` (${lead.source})`,
        pipeline: o.pipelineId,
        dealstage: q.status === "qualified" ? o.stageQualified : o.stageNurture,
      },
      associations: [
        { to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] },
      ],
    }),
    fetchImpl: o.fetchImpl,
  });
  return deal.id;
}

/** Logs a WhatsApp message or call summary on the contact timeline as a note. */
export async function logNote(contactId: string, text: string, o: Opts): Promise<void> {
  await requestJson(`${BASE}/crm/v3/objects/notes`, {
    method: "POST",
    headers: headers(o.token),
    body: JSON.stringify({
      properties: { hs_note_body: text, hs_timestamp: new Date().toISOString() },
      associations: [
        { to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] },
      ],
    }),
    fetchImpl: o.fetchImpl,
  });
}
