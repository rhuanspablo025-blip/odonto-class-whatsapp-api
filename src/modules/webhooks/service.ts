import crypto from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { getEnv } from "../../config/env.js";
import { getDb } from "../../database/client.js";
import {
  contacts,
  conversations,
  messages,
  templates,
  whatsappAccounts,
  webhookEvents,
} from "../../database/schema/index.js";
import { newId, nowMs } from "../../lib/ids.js";
import {
  deliveryCategoryForMessage,
  recordMessageCost,
} from "../billing/service.js";
import { publishEvent } from "../events/service.js";
import type {
  MetaIncomingMessage,
  MetaWebhookChange,
  MetaWebhookEvent,
  MetaWebhookValue,
} from "../../integrations/whatsapp/types.js";

const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const processingEventIds = new Set<string>();

/**
 * Verifica a assinatura HMAC-SHA256 do webhook da Meta.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  const secret = getEnv().META_APP_SECRET;
  if (!secret || !signatureHeader || !rawBody) return false;
  if (!/^sha256=[a-f\d]{64}$/i.test(signatureHeader)) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(signatureHeader.slice(7), "hex");
  return provided.length === expected.length && crypto.timingSafeEqual(expected, provided);
}

/**
 * Persiste cada alteração do webhook antes de confirmar o recebimento à Meta.
 * A chave inclui o payload completo para não descartar atualizações posteriores
 * (por exemplo, delivered/read para o mesmo wamid).
 */
export async function persistMetaWebhook(event: MetaWebhookEvent): Promise<string[]> {
  const db = getDb();
  const pendingIds: string[] = [];

  for (const entry of event.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const eventId = newId();
      const eventKey = createWebhookEventKey(entry.id, change);
      const result = await db.insert(webhookEvents).values({
        id: eventId,
        eventKey,
        payload: {
          object: event.object,
          entry: [{ id: entry.id, changes: [change] }],
        },
        status: "PENDING",
        receivedAt: nowMs(),
      }).onConflictDoNothing();

      if (result.rowsAffected > 0) {
        pendingIds.push(eventId);
        continue;
      }

      // Uma entrega já processada é ignorada; falhas persistidas podem ser tentadas novamente.
      const [existing] = await db
        .select({ id: webhookEvents.id, status: webhookEvents.status })
        .from(webhookEvents)
        .where(eq(webhookEvents.eventKey, eventKey))
        .limit(1);
      if (existing && existing.status !== "PROCESSED") {
        pendingIds.push(existing.id);
      }
    }
  }

  return pendingIds;
}

/** Processa eventos que já estão duravelmente gravados no banco. */
export async function processPersistedWebhookEvents(eventIds: string[]): Promise<void> {
  const db = getDb();
  const failures: Error[] = [];

  for (const eventId of eventIds) {
    if (processingEventIds.has(eventId)) continue;
    processingEventIds.add(eventId);
    try {
      const [stored] = await db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.id, eventId))
        .limit(1);
      if (!stored || stored.status === "PROCESSED") continue;

      const event = stored.payload as unknown as MetaWebhookEvent;
      for (const entry of event.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (change.field !== "messages") continue;
          await processMessagesChange(entry.id, change);
        }
      }

      await db
        .update(webhookEvents)
        .set({ status: "PROCESSED", processedAt: nowMs(), error: null })
        .where(eq(webhookEvents.id, eventId));
    } catch (error) {
      try {
        await db
          .update(webhookEvents)
          .set({
            status: "FAILED",
            error: error instanceof Error ? error.message.slice(0, 2000) : "Erro desconhecido",
          })
          .where(eq(webhookEvents.id, eventId));
      } catch {
        // O evento permanece persistido como PENDING para uma tentativa posterior.
      }
      failures.push(error instanceof Error ? error : new Error("Erro desconhecido"));
    } finally {
      processingEventIds.delete(eventId);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Um ou mais eventos de webhook falharam.");
  }
}

/** Compatibilidade para chamadas internas que precisam aguardar o processamento. */
export async function processMetaWebhook(event: MetaWebhookEvent): Promise<void> {
  const eventIds = await persistMetaWebhook(event);
  await processPersistedWebhookEvents(eventIds);
}

function createWebhookEventKey(entryId: string, change: MetaWebhookChange): string {
  return crypto
    .createHash("sha256")
    .update(`${entryId}\0${stableJson(change)}`)
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function processMessagesChange(
  entryId: string,
  change: MetaWebhookChange,
): Promise<void> {
  const value = change.value as unknown as MetaWebhookValue;
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) throw new Error("Webhook messages sem metadata.phone_number_id.");

  const db = getDb();
  const [account] = await db
    .select({
      id: whatsappAccounts.id,
      tenantId: whatsappAccounts.tenantId,
    })
    .from(whatsappAccounts)
    .where(
      and(
        eq(whatsappAccounts.phoneNumberId, phoneNumberId),
        eq(whatsappAccounts.status, "CONNECTED"),
      ),
    )
    .limit(1);

  if (!account) {
    throw new Error(`Nenhuma conta WhatsApp conectada para o phone_number_id ${phoneNumberId}.`);
  }

  for (const msg of value.messages ?? []) {
    await handleInboundMessage(account.tenantId, account.id, value.contacts ?? [], msg);
  }

  for (const status of value.statuses ?? []) {
    await handleStatusUpdate(
      account.tenantId,
      account.id,
      status.id,
      status.status,
      status.timestamp,
      status.errors?.[0],
    );
  }
}

/** Trata uma mensagem recebida do contato. */
async function handleInboundMessage(
  tenantId: string,
  whatsappAccountId: string,
  webhookContacts: MetaWebhookValue["contacts"],
  msg: MetaIncomingMessage,
) {
  const db = getDb();
  const sender = msg.from.replace(/^\+/, "");
  if (!/^\d{7,15}$/.test(sender)) {
    throw new Error("Mensagem inbound sem número de telefone válido.");
  }
  const contactPhone = `+${sender}`;
  const profileName = webhookContacts?.find((item) => item.wa_id === sender)?.profile?.name;

  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.phoneE164, contactPhone)))
    .limit(1);

  let contactId = contact?.id;
  if (!contactId) {
    contactId = newId();
    await db.insert(contacts).values({
      id: contactId,
      tenantId,
      name: profileName?.trim() || `Contato ${sender}`,
      phoneE164: contactPhone,
    });
  }

  // Encontra ou cria conversa.
  const [conv] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.contactId, contactId),
        eq(conversations.status, "OPEN"),
      ),
    )
    .limit(1);

  const conversationId = conv?.id ?? newId();
  if (!conv) {
    await db.insert(conversations).values({
      id: conversationId,
      tenantId,
      contactId,
      whatsappAccountId,
      status: "OPEN",
      lastMessageAt: nowMs(),
      customerServiceWindowExpiresAt: nowMs() + WINDOW_24H_MS,
    });
  }

  const typeMap: Record<string, "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "LOCATION"> = {
    text: "TEXT",
    image: "IMAGE",
    video: "VIDEO",
    audio: "AUDIO",
    document: "DOCUMENT",
    location: "LOCATION",
  };
  const timestamp = Number(msg.timestamp);
  const receivedAt = Number.isFinite(timestamp) && timestamp > 0 ? timestamp * 1000 : nowMs();

  // A deduplicação é feita pela unicidade `(tenant_id, provider_message_id)`.
  // Se a Meta reentregar o webhook, nada é inserido e nenhum evento é publicado.
  const inserted = await db
    .insert(messages)
    .values({
      id: newId(),
      tenantId,
      conversationId,
      contactId,
      direction: "INBOUND",
      type: typeMap[msg.type] ?? "TEXT",
      content: msg as unknown as Record<string, unknown>,
      providerMessageId: msg.id,
      status: "DELIVERED",
      createdAt: receivedAt,
      deliveredAt: receivedAt,
    })
    .onConflictDoNothing()
    .returning({
      id: messages.id,
      type: messages.type,
      content: messages.content,
      createdAt: messages.createdAt,
    });

  const created = inserted[0];
  if (!created) return; // Reentrega do mesmo wamid: apenas ignora.

  // Atualiza a conversa (janela de 24h + contador de não lidas).
  await db
    .update(conversations)
    .set({
      lastMessageAt: receivedAt,
      customerServiceWindowExpiresAt: receivedAt + WINDOW_24H_MS,
      whatsappAccountId: conv?.whatsappAccountId ?? whatsappAccountId,
      unreadCount: sql`${conversations.unreadCount} + 1`,
    })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));

  await publishEvent({
    tenantId,
    type: "message.inbound",
    conversationId,
    messageId: created.id,
    payload: {
      id: created.id,
      conversationId,
      contactId,
      type: created.type,
      content: created.content,
      providerMessageId: msg.id,
      createdAt: created.createdAt,
    },
  });
}

/** Atualiza o status de uma mensagem enviada (máquina de estados anti-regressão). */
async function handleStatusUpdate(
  tenantId: string,
  whatsappAccountId: string,
  providerMessageId: string,
  status: "sent" | "delivered" | "read" | "failed",
  timestamp: string,
  error?: {
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  },
) {
  const db = getDb();
  const [msg] = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      status: messages.status,
      type: messages.type,
      content: messages.content,
    })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.providerMessageId, providerMessageId),
      ),
    )
    .limit(1);

  if (!msg) return;

  const statusMap: Record<string, string> = {
    sent: "SENT",
    delivered: "DELIVERED",
    read: "READ",
    failed: "FAILED",
  };
  const newStatus = statusMap[status];
  if (!newStatus) return;

  const order = ["PENDING", "QUEUED", "SENT", "DELIVERED", "READ"];
  const currentIdx = order.indexOf(msg.status);
  const newIdx = order.indexOf(newStatus);
  const canTransitionToFailed =
    newStatus === "FAILED" && currentIdx >= 0 && currentIdx < order.indexOf("DELIVERED");

  const statusTimestamp = Number(timestamp);
  const occurredAt =
    Number.isFinite(statusTimestamp) && statusTimestamp > 0
      ? statusTimestamp * 1000
      : nowMs();

  if (canTransitionToFailed || newIdx > currentIdx) {
    await db
      .update(messages)
      .set({
        status: newStatus as never,
        sentAt: newStatus === "SENT" ? occurredAt : undefined,
        deliveredAt: newStatus === "DELIVERED" ? occurredAt : undefined,
        readAt: newStatus === "READ" ? occurredAt : undefined,
        failedAt: newStatus === "FAILED" ? occurredAt : undefined,
        errorCode: newStatus === "FAILED" ? String(error?.code ?? "META_DELIVERY_FAILED") : undefined,
        errorMessage:
          newStatus === "FAILED"
            ? (error?.error_data?.details ?? error?.message ?? error?.title ?? "Falha de entrega").slice(0, 2000)
            : undefined,
      })
      .where(and(eq(messages.tenantId, tenantId), eq(messages.id, msg.id)));

    // A entrega é o evento de cobrança: registra o custo estimado (livro-razão).
    if (newStatus === "DELIVERED") {
      await recordDeliveryCost({
        tenantId,
        whatsappAccountId,
        messageId: msg.id,
        messageType: msg.type,
        content: msg.content,
        providerMessageId,
        occurredAt,
      });
    }

    // Notifica o atendimento em tempo real sobre a mudança de status.
    await publishEvent({
      tenantId,
      type: "message.status",
      conversationId: msg.conversationId,
      messageId: msg.id,
      payload: {
        id: msg.id,
        status: newStatus,
        providerMessageId,
        occurredAt,
        errorCode: newStatus === "FAILED" ? String(error?.code ?? "META_DELIVERY_FAILED") : null,
        errorMessage:
          newStatus === "FAILED"
            ? (error?.error_data?.details ?? error?.message ?? error?.title ?? "Falha de entrega").slice(0, 500)
            : null,
      },
    });
  }
}

/**
 * Registra o custo estimado de uma mensagem entregue.
 * Nunca interrompe o processamento do webhook: o custo é informação acessória.
 */
async function recordDeliveryCost(input: {
  tenantId: string;
  whatsappAccountId: string;
  messageId: string;
  messageType: string;
  content: unknown;
  providerMessageId: string;
  occurredAt: number;
}): Promise<void> {
  try {
    let templateCategory: string | null = null;
    if (input.messageType === "TEMPLATE") {
      const templateName =
        input.content && typeof input.content === "object"
          ? (input.content as Record<string, unknown>).templateName
          : null;
      if (typeof templateName === "string") {
        const db = getDb();
        const [tpl] = await db
          .select({ category: templates.category })
          .from(templates)
          .where(and(eq(templates.tenantId, input.tenantId), eq(templates.name, templateName)))
          .limit(1);
        templateCategory = tpl?.category ?? null;
      }
    }

    await recordMessageCost({
      tenantId: input.tenantId,
      whatsappAccountId: input.whatsappAccountId,
      messageId: input.messageId,
      providerMessageId: input.providerMessageId,
      category: deliveryCategoryForMessage(input.messageType, templateCategory),
      occurredAt: input.occurredAt,
    });
  } catch {
    // Best-effort: falha ao registrar custo não deve afetar a entrega.
  }
}
