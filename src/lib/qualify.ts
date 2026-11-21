import type { Lead, Qualification } from "./types.ts";
import { requestJson, type FetchLike } from "./http.ts";

const SYSTEM_PROMPT = `You qualify inbound sales leads for a service business.
Return JSON only: {"status":"qualified"|"nurture"|"disqualified","score":0-100,"reason":"one short sentence","needsHuman":true|false}.
qualified = clear need, budget or timeline mentioned, reachable by phone or email.
nurture = interested but early, vague or no timeline.
disqualified = spam, job seekers, wrong service, abusive.
needsHuman = true if the person asks for a human, is upset, or asks something the bot cannot answer.`;

/** Asks OpenAI to qualify the lead. Falls back to simple rules when no key is set or the call fails. */
export async function qualifyLead(
  lead: Lead,
  opts: { apiKey: string; model: string; fetchImpl?: FetchLike },
): Promise<Qualification> {
  if (!opts.apiKey) return ruleBasedQualify(lead);

  try {
    const data = await requestJson<any>("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ message: lead.message, answers: lead.answers, hasEmail: !!lead.email, hasPhone: !!lead.phone }) },
        ],
      }),
      fetchImpl: opts.fetchImpl,
      retries: 2,
    });
    return validate(JSON.parse(data.choices[0].message.content));
  } catch {
    // Guardrail: never block a lead because the model failed. Use the rules and flag for a person.
    return { ...ruleBasedQualify(lead), needsHuman: true, reason: "AI unavailable, rule-based score" };
  }
}

/** Guardrail: reject anything that is not the exact shape we expect. */
export function validate(x: any): Qualification {
  const statuses = ["qualified", "nurture", "disqualified"];
  if (!x || !statuses.includes(x.status)) throw new Error("bad status");
  const score = Math.max(0, Math.min(100, Math.round(Number(x.score))));
  if (!Number.isFinite(score)) throw new Error("bad score");
  return { status: x.status, score, reason: String(x.reason ?? "").slice(0, 200), needsHuman: Boolean(x.needsHuman) };
}

export function ruleBasedQualify(lead: Lead): Qualification {
  const text = `${lead.message} ${Object.values(lead.answers).join(" ")}`.toLowerCase();
  if (/\b(job|vacancy|cv|resume|hiring)\b/.test(text)) {
    return { status: "disqualified", score: 5, reason: "Looks like a job enquiry", needsHuman: false };
  }
  let score = 20;
  if (lead.phone) score += 20;
  if (lead.email) score += 10;
  if (/\b(budget|price|cost|quote|pkr|usd|\$)\b/.test(text)) score += 20;
  if (/\b(asap|this week|this month|urgent|soon|today)\b/.test(text)) score += 20;
  if (/\b(human|agent|call me|talk to someone)\b/.test(text)) score += 10;
  const status = score >= 60 ? "qualified" : "nurture";
  return {
    status,
    score: Math.min(score, 100),
    reason: status === "qualified" ? "Contact details plus budget or timeline" : "Interested, no clear budget or timeline",
    needsHuman: /\b(human|agent|call me|talk to someone)\b/.test(text),
  };
}
