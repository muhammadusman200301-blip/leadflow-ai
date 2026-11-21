import { createHash } from "node:crypto";
import type { Lead } from "./types.ts";
import { requestJson, type FetchLike } from "./http.ts";

type Opts = { pixelId: string; accessToken: string; testEventCode?: string; fetchImpl?: FetchLike };

export const sha256 = (v: string) => createHash("sha256").update(v.trim().toLowerCase()).digest("hex");

/** Builds the CAPI event. Personal data is hashed (SHA-256) as Meta requires. */
export function buildLeadEvent(lead: Lead, eventName: "Lead" | "QualifiedLead", eventId: string) {
  const user_data: Record<string, unknown> = {};
  if (lead.email) user_data.em = [sha256(lead.email)];
  if (lead.phone) user_data.ph = [sha256(lead.phone.replace(/\D/g, ""))];
  if (lead.firstName) user_data.fn = [sha256(lead.firstName)];
  if (lead.lastName) user_data.ln = [sha256(lead.lastName)];
  if (lead.fbclid) user_data.fbc = `fb.1.${Date.now()}.${lead.fbclid}`;

  return {
    event_name: eventName,
    event_time: Math.floor(new Date(lead.receivedAt).getTime() / 1000),
    event_id: eventId, // lets Meta deduplicate against the browser pixel
    action_source: lead.source === "web_form" ? "website" : "system_generated",
    user_data,
    custom_data: { lead_source: lead.source, ...(lead.adId ? { ad_id: lead.adId } : {}) },
  };
}

export async function sendCapiEvent(event: ReturnType<typeof buildLeadEvent>, o: Opts): Promise<boolean> {
  const res = await requestJson<any>(`https://graph.facebook.com/v21.0/${o.pixelId}/events?access_token=${encodeURIComponent(o.accessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [event], ...(o.testEventCode ? { test_event_code: o.testEventCode } : {}) }),
    fetchImpl: o.fetchImpl,
  });
  return (res.events_received ?? 0) > 0;
}
