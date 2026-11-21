export type LeadSource = "manychat_instagram" | "manychat_facebook" | "web_form";

/** One enquiry, normalised from whichever channel it came in on. */
export type Lead = {
  externalId: string; // id from the source system, used for deduplication
  source: LeadSource;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null; // E.164, e.g. +923001234567
  message: string;
  answers: Record<string, string>; // qualification answers collected by the bot or form
  receivedAt: string; // ISO timestamp
  adId?: string; // Meta ad or campaign id, for attribution
  fbclid?: string;
  gclid?: string;
};

export type Qualification = {
  status: "qualified" | "nurture" | "disqualified";
  score: number; // 0-100
  reason: string;
  needsHuman: boolean; // true when the bot should hand off to a person
};

export type PipelineResult = {
  leadId: string;
  duplicate: boolean;
  qualification?: Qualification;
  hubspotContactId?: string;
  hubspotDealId?: string;
  whatsappSid?: string;
  capiSent?: boolean;
  errors: string[];
};
