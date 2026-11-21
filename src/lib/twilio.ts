import { createHmac, timingSafeEqual } from "node:crypto";
import { requestJson, type FetchLike } from "./http.ts";

type Opts = { sid: string; token: string; from: string; statusCallbackUrl?: string; fetchImpl?: FetchLike };

/** Sends a WhatsApp message through Twilio. Returns the message SID. */
export async function sendWhatsApp(toE164: string, body: string, o: Opts): Promise<string> {
  const form = new URLSearchParams({ From: o.from, To: `whatsapp:${toE164}`, Body: body });
  if (o.statusCallbackUrl) form.set("StatusCallback", o.statusCallbackUrl);
  const res = await requestJson<any>(`https://api.twilio.com/2010-04-01/Accounts/${o.sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${o.sid}:${o.token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    fetchImpl: o.fetchImpl,
  });
  return res.sid;
}

/**
 * Checks the X-Twilio-Signature header so only Twilio can call our status webhook.
 * Signature = base64(HMAC-SHA1(authToken, fullUrl + sorted(key+value of every POST param))).
 */
export function verifyTwilioSignature(authToken: string, fullUrl: string, params: Record<string, string>, signature: string): boolean {
  const data = fullUrl + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function followUpMessage(firstName: string, qualified: boolean): string {
  const name = firstName || "there";
  return qualified
    ? `Hi ${name}, thanks for your enquiry! One of our team will call you shortly. Is now a good time, or would you prefer later today?`
    : `Hi ${name}, thanks for reaching out! Here is a quick overview of how we work. Reply here any time if you have questions.`;
}
