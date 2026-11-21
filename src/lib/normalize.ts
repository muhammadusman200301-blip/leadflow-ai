import type { Lead, LeadSource } from "./types.ts";

/** Turns a phone number into E.164. Pakistani local numbers (03xx...) get +92. */
export function toE164(raw: string | undefined | null, defaultCountry = "92"): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = "+" + digits.slice(2);
  if (digits.startsWith("+")) return /^\+\d{8,15}$/.test(digits) ? digits : null;
  if (digits.startsWith("0")) digits = defaultCountry + digits.slice(1);
  return /^\d{8,15}$/.test(digits) ? "+" + digits : null;
}

export function normalizeEmail(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

function splitName(full: string): [string, string] {
  const parts = full.trim().split(/\s+/);
  return [parts[0] ?? "", parts.slice(1).join(" ")];
}

/**
 * ManyChat "External Request" body. Configure the request in ManyChat to send:
 * { "subscriber_id", "first_name", "last_name", "email", "phone", "channel", "last_input", "custom_fields": {...}, "ad_id" }
 */
export function fromManyChat(body: any): Lead {
  const channel: LeadSource = body.channel === "facebook" ? "manychat_facebook" : "manychat_instagram";
  return {
    externalId: `mc_${body.subscriber_id}`,
    source: channel,
    firstName: String(body.first_name ?? "").trim(),
    lastName: String(body.last_name ?? "").trim(),
    email: normalizeEmail(body.email),
    phone: toE164(body.phone),
    message: String(body.last_input ?? ""),
    answers: Object.fromEntries(Object.entries(body.custom_fields ?? {}).map(([k, v]) => [k, String(v)])),
    receivedAt: new Date().toISOString(),
    adId: body.ad_id ? String(body.ad_id) : undefined,
  };
}

/** Website enquiry form. */
export function fromWebForm(body: any): Lead {
  const [first, last] = splitName(String(body.name ?? ""));
  return {
    externalId: `form_${body.submission_id ?? crypto.randomUUID()}`,
    source: "web_form",
    firstName: first,
    lastName: last,
    email: normalizeEmail(body.email),
    phone: toE164(body.phone),
    message: String(body.message ?? ""),
    answers: Object.fromEntries(Object.entries(body.answers ?? {}).map(([k, v]) => [k, String(v)])),
    receivedAt: new Date().toISOString(),
    fbclid: body.fbclid,
    gclid: body.gclid,
  };
}
