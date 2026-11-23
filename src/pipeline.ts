// The whole flow for one lead:
// dedupe -> AI qualify -> HubSpot contact + deal -> WhatsApp follow-up -> Meta CAPI -> audit log.
// Each outbound step is isolated: if one fails, the others still run and the error is recorded.

import type { Config } from "./config.ts";
import type { Lead, PipelineResult } from "./lib/types.ts";
import type { FetchLike } from "./lib/http.ts";
import { LeadStore } from "./lib/store.ts";
import { qualifyLead } from "./lib/qualify.ts";
import { upsertContact, createDeal, logNote } from "./lib/hubspot.ts";
import { sendWhatsApp, followUpMessage } from "./lib/twilio.ts";
import { buildLeadEvent, sendCapiEvent } from "./lib/metaCapi.ts";

export type Deps = { config: Config; store: LeadStore; fetchImpl?: FetchLike; log?: (msg: string, extra?: unknown) => void };

export async function processLead(lead: Lead, deps: Deps): Promise<PipelineResult> {
  const { config: c, store, fetchImpl } = deps;
  const log = deps.log ?? ((m, e) => console.log(`[leadflow] ${m}`, e ?? ""));
  const result: PipelineResult = { leadId: lead.externalId, duplicate: false, errors: [] };

  if (!store.claim(lead.externalId)) {
    log("duplicate lead skipped", lead.externalId);
    return { ...result, duplicate: true };
  }

  const q = await qualifyLead(lead, { apiKey: c.openaiKey, model: c.openaiModel, fetchImpl });
  result.qualification = q;
  log("qualified", { id: lead.externalId, ...q });

  const live = (ready: boolean) => !c.dryRun && ready;
  const hubspotOpts = {
    token: c.hubspotToken, pipelineId: c.hubspotPipelineId,
    stageQualified: c.hubspotStageQualified, stageNurture: c.hubspotStageNurture, fetchImpl,
  };

  // 1. HubSpot
  try {
    if (live(!!c.hubspotToken)) {
      result.hubspotContactId = await upsertContact(lead, q, hubspotOpts);
      result.hubspotDealId = await createDeal(lead, q, result.hubspotContactId, hubspotOpts);
    } else {
      log("DRY RUN hubspot upsert + deal", { stage: q.status });
    }
  } catch (e) {
    result.errors.push(`hubspot: ${(e as Error).message}`);
  }

  // 2. WhatsApp follow-up (only to people who are not disqualified and gave a phone)
  if (q.status !== "disqualified" && lead.phone) {
    const text = followUpMessage(lead.firstName, q.status === "qualified");
    try {
      if (live(!!c.twilioSid)) {
        result.whatsappSid = await sendWhatsApp(lead.phone, text, {
          sid: c.twilioSid, token: c.twilioToken, from: c.twilioWhatsAppFrom,
          statusCallbackUrl: `${c.publicBaseUrl}/webhooks/twilio/status`, fetchImpl,
        });
        if (result.hubspotContactId) await logNote(result.hubspotContactId, `WhatsApp sent: ${text}`, hubspotOpts);
      } else {
        log("DRY RUN whatsapp", { to: lead.phone, text });
      }
    } catch (e) {
      result.errors.push(`twilio: ${(e as Error).message}`);
    }
  }

  // 3. Meta Conversions API: tell Meta which ad leads turned out to be qualified
  if (q.status === "qualified") {
    const event = buildLeadEvent(lead, "QualifiedLead", lead.externalId);
    try {
      if (live(!!c.metaPixelId)) {
        result.capiSent = await sendCapiEvent(event, { pixelId: c.metaPixelId, accessToken: c.metaAccessToken, testEventCode: c.metaTestEventCode, fetchImpl });
      } else {
        log("DRY RUN capi", event);
      }
    } catch (e) {
      result.errors.push(`capi: ${(e as Error).message}`);
    }
  }

  store.saveResult(lead.externalId, result, lead);
  return result;
}
