// Reads settings from the environment once, so the rest of the app never touches process.env.

export type Config = {
  port: number;
  publicBaseUrl: string;
  manychatSecret: string;
  formSecret: string;
  openaiKey: string;
  openaiModel: string;
  hubspotToken: string;
  hubspotPipelineId: string;
  hubspotStageQualified: string;
  hubspotStageNurture: string;
  twilioSid: string;
  twilioToken: string;
  twilioWhatsAppFrom: string;
  metaPixelId: string;
  metaAccessToken: string;
  metaTestEventCode: string;
  dryRun: boolean;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:3000",
    manychatSecret: env.MANYCHAT_WEBHOOK_SECRET ?? "",
    formSecret: env.FORM_WEBHOOK_SECRET ?? "",
    openaiKey: env.OPENAI_API_KEY ?? "",
    openaiModel: env.OPENAI_MODEL ?? "gpt-4o-mini",
    hubspotToken: env.HUBSPOT_TOKEN ?? "",
    hubspotPipelineId: env.HUBSPOT_PIPELINE_ID ?? "default",
    hubspotStageQualified: env.HUBSPOT_STAGE_QUALIFIED ?? "appointmentscheduled",
    hubspotStageNurture: env.HUBSPOT_STAGE_NURTURE ?? "qualifiedtobuy",
    twilioSid: env.TWILIO_ACCOUNT_SID ?? "",
    twilioToken: env.TWILIO_AUTH_TOKEN ?? "",
    twilioWhatsAppFrom: env.TWILIO_WHATSAPP_FROM ?? "",
    metaPixelId: env.META_PIXEL_ID ?? "",
    metaAccessToken: env.META_ACCESS_TOKEN ?? "",
    metaTestEventCode: env.META_TEST_EVENT_CODE ?? "",
    dryRun: (env.DRY_RUN ?? "true").toLowerCase() === "true",
  };
}
