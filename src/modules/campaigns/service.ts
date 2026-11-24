import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../database/client.js";
import {
  campaignRecipients,
  campaigns,
  consents,
  contacts,
  messageJobs,
  messages,
} from "../../database/schema/index.js";
import { errors } from "../../lib/errors.js";
import { newId, nowMs } from "../../lib/ids.js";
import { assertBudgetAllowsMarketing } from "../billing/service.js";
import {
  getOrCreateConversation,
  resolveWhatsAppAccountId,
} from "../messages/service.js";

/**
 * Módulo de Campanhas.
 *
 * Campanhas disparam mensagens em massa para um segmento de contatos.
 * Cada destinatário gera uma mensagem + job independente.
 */

export const createCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  templateName: z.string().min(1),
  whatsappAccountId: z.string().optional(),
  language: z.string().default("pt_BR"),
  segment: z
    .object({
      channel: z.enum(["WHATSAPP", "SMS", "EMAIL"]).default("WHATSAPP"),
      purpose: z.string().default("whatsapp"),
    })
    .default({ channel: "WHATSAPP", purpose: "whatsapp" }),
  scheduledAt: z.string().datetime().optional(),
});

/** Cria uma campanha e enfileira jobs para destinatários com consentimento. */
export async function createCampaign(
  tenantId: string,
  input: z.infer<typeof createCampaignSchema>,
) {
  const db = getDb();
  // Guarda de orçamento: pode bloquear novas campanhas de marketing.
  await assertBudgetAllowsMarketing(tenantId);
  const whatsappAccountId = await resolveWhatsAppAccountId(
    tenantId,
    input.whatsappAccountId,
  );
  const campaignId = newId();
  const scheduledAt = input.scheduledAt
    ? new Date(input.scheduledAt).getTime()
    : nowMs();

  // 1. Cria a campanha.
  await db.insert(campaigns).values({
    id: campaignId,
    tenantId,
    name: input.name,
    status: "DRAFT",
    scheduledAt,
  });

  // 2. Seleciona contatos com consentimento ativo.
  const consentedContacts = await db
    .select({ id: contacts.id })
    .from(contacts)
    .innerJoin(
      consents,
      and(
        eq(consents.contactId, contacts.id),
        eq(consents.tenantId, tenantId),
        eq(consents.channel, input.segment.channel),
        eq(consents.purpose, input.segment.purpose),
        eq(consents.status, "GRANTED"),
      ),
    )
    .where(eq(contacts.tenantId, tenantId));

  const recipients = consentedContacts.map((c) => ({
    id: newId(),
    tenantId,
    campaignId,
    contactId: c.id,
  }));

  if (recipients.length > 0) {
    // 3. Para cada destinatário: cria conversa, mensagem e job.
    for (const r of recipients) {
      const conversation = await getOrCreateConversation(
        tenantId,
        r.contactId,
        whatsappAccountId ?? undefined,
      );
      const messageId = newId();

      await db
        .insert(messages)
        .values({
          id: messageId,
          tenantId,
          conversationId: conversation.id,
          contactId: r.contactId,
          direction: "OUTBOUND",
          type: "TEMPLATE",
          content: {
            templateName: input.templateName,
            language: input.language,
            components: [],
          },
          status: "QUEUED",
        });

      await db.insert(messageJobs).values({
        id: newId(),
        tenantId,
        messageId,
        scheduledAt,
        nextAttemptAt: scheduledAt,
      });

      await db.insert(campaignRecipients).values({
        id: r.id,
        tenantId,
        campaignId,
        contactId: r.contactId,
        messageId,
      });
    }
  }

  // 4. Ativa a campanha.
  await db
    .update(campaigns)
    .set({ status: "SCHEDULED" })
    .where(eq(campaigns.id, campaignId));

  return {
    id: campaignId,
    status: "SCHEDULED",
    totalRecipients: recipients.length,
  };
}

/** Inicia uma campanha (move jobs pendentes para PENDING). */
export async function startCampaign(tenantId: string, campaignId: string) {
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)))
    .limit(1);

  if (!campaign) throw errors.notFound("Campanha");
  if (!["DRAFT", "SCHEDULED", "PAUSED"].includes(campaign.status)) {
    throw errors.validation("Campanha não pode ser iniciada.");
  }

  // Guarda de orçamento: impede iniciar campanhas de marketing acima do limite.
  await assertBudgetAllowsMarketing(tenantId);

  await db
    .update(campaigns)
    .set({ status: "RUNNING", startedAt: nowMs() })
    .where(eq(campaigns.id, campaignId));

  // Jobs já estão PENDING por padrão; nada a mover.
  return { id: campaignId, status: "RUNNING" };
}

/** Pausa uma campanha. */
export async function pauseCampaign(tenantId: string, campaignId: string) {
  const db = getDb();
  await db
    .update(campaigns)
    .set({ status: "PAUSED" })
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));

  return { id: campaignId, status: "PAUSED" };
}

/** Cancela uma campanha e seus jobs. */
export async function cancelCampaign(tenantId: string, campaignId: string) {
  const db = getDb();
  await db
    .update(campaigns)
    .set({ status: "CANCELLED" })
    .where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));

  // Cancela os jobs das mensagens desta campanha (via recipients).
  const recips = await db
    .select({ messageId: campaignRecipients.messageId })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId));

  const msgIds = recips.map((r) => r.messageId).filter(Boolean) as string[];
  if (msgIds.length > 0) {
    await db
      .update(messageJobs)
      .set({ status: "CANCELLED" })
      .where(inArray(messageJobs.messageId, msgIds));
  }

  return { id: campaignId, status: "CANCELLED" };
}

/** Lista campanhas do tenant. */
export async function listCampaigns(tenantId: string) {
  const db = getDb();
  return db
    .select()
    .from(campaigns)
    .where(eq(campaigns.tenantId, tenantId))
    .orderBy(campaigns.createdAt);
}
