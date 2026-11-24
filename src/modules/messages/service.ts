import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { getEnv, isLocalEnv } from "../../config/env.js";
import { getDb } from "../../database/client.js";
import {
  conversations,
  messageJobs,
  messages,
  whatsappAccounts,
} from "../../database/schema/index.js";
import { errors } from "../../lib/errors.js";
import { newId, nowMs } from "../../lib/ids.js";
import { hasConsent } from "../contacts/service.js";
import { publishEvent } from "../events/service.js";

/**
 * Serviço de mensagens.
 *
 * O envio é ASSÍNCRONO: a requisição persiste a mensagem + job na fila e
 * retorna 202. O worker processa o envio real através do provedor.
 */

export const sendTextSchema = z.object({
  contactId: z.string(),
  whatsappAccountId: z.string().optional(),
  text: z.string().min(1).max(4096),
  previewUrl: z.boolean().optional(),
  idempotencyKey: z.string().max(200).optional(),
  scheduledAt: z.string().datetime().optional(),
});

const mediaParameterSchema = z
  .object({
    id: z.string().optional(),
    link: z.string().url().optional(),
  })
  .refine((value) => Boolean(value.id || value.link));

const templateParameterSchema = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string(),
    parameter_name: z.string().optional(),
  }),
  z.object({
    type: z.literal("currency"),
    currency: z.object({
      fallback_value: z.string(),
      code: z.string(),
      amount_1000: z.number(),
    }),
  }),
  z.object({
    type: z.literal("date_time"),
    date_time: z.object({ fallback_value: z.string() }),
  }),
  z.object({ type: z.literal("image"), image: mediaParameterSchema }),
  z.object({ type: z.literal("video"), video: mediaParameterSchema }),
  z.object({
    type: z.literal("document"),
    document: mediaParameterSchema.extend({ filename: z.string().optional() }),
  }),
  z.object({ type: z.literal("payload"), payload: z.string() }),
  z.object({
    type: z.literal("location"),
    location: z.object({
      longitude: z.number(),
      latitude: z.number(),
      name: z.string().optional(),
      address: z.string().optional(),
    }),
  }),
]);

export const sendMediaSchema = z.object({
  contactId: z.string(),
  whatsappAccountId: z.string().optional(),
  mediaType: z.enum(["image", "video", "audio", "document"]),
  link: z.string().url(),
  /** Legenda (não aplicável a áudio, conforme regra da Meta). */
  caption: z.string().max(1024).optional(),
  filename: z.string().max(200).optional(),
  idempotencyKey: z.string().max(200).optional(),
  scheduledAt: z.string().datetime().optional(),
});

export const sendTemplateSchema = z.object({
  contactId: z.string(),
  whatsappAccountId: z.string().optional(),
  templateName: z.string().min(1),
  language: z.string().default("pt_BR"),
  components: z
    .array(
      z.object({
        type: z.enum(["header", "body", "button", "carousel", "limited_time_offer"]),
        sub_type: z.string().optional(),
        index: z.string().optional(),
        parameters: z.array(templateParameterSchema).optional(),
      }),
    )
    .optional(),
  idempotencyKey: z.string().max(200).optional(),
  scheduledAt: z.string().datetime().optional(),
});

/**
 * Verifica se a conversa está dentro da janela de atendimento de 24h.
 * A janela começa na última mensagem recebida do contato.
 */
function isWithinCustomerServiceWindow(
  windowExpiresAt: number | null | undefined,
): boolean {
  if (!windowExpiresAt) return false;
  return windowExpiresAt > nowMs();
}

/** Resolve a conta conectada sem permitir selecionar contas de outro tenant. */
export async function resolveWhatsAppAccountId(
  tenantId: string,
  requestedAccountId?: string,
): Promise<string | null> {
  const db = getDb();
  const conditions = [
    eq(whatsappAccounts.tenantId, tenantId),
    eq(whatsappAccounts.status, "CONNECTED"),
  ];
  if (requestedAccountId) {
    conditions.push(eq(whatsappAccounts.id, requestedAccountId));
  }

  const accounts = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(and(...conditions));

  if (requestedAccountId) {
    if (!accounts.length) throw errors.notFound("Conta WhatsApp");
    return accounts[0]!.id;
  }
  if (accounts.length === 1) return accounts[0]!.id;
  if (accounts.length > 1) {
    throw errors.validation("Informe whatsappAccountId quando a clínica possui mais de uma conta.");
  }

  const env = getEnv();
  const useTestProvider =
    process.env.WHATSAPP_PROVIDER === "test" ||
    (!process.env.WHATSAPP_PROVIDER && isLocalEnv(env));
  if (!useTestProvider) {
    throw errors.provider("A clínica não possui uma conta WhatsApp Cloud API conectada.");
  }
  return null;
}

/** Encontra ou cria uma conversa associada à conta WhatsApp do tenant. */
export async function getOrCreateConversation(
  tenantId: string,
  contactId: string,
  requestedAccountId?: string,
) {
  const db = getDb();
  const whatsappAccountId = await resolveWhatsAppAccountId(tenantId, requestedAccountId);
  const conditions = [
    eq(conversations.tenantId, tenantId),
    eq(conversations.contactId, contactId),
    eq(conversations.status, "OPEN"),
    whatsappAccountId
      ? eq(conversations.whatsappAccountId, whatsappAccountId)
      : isNull(conversations.whatsappAccountId),
  ];
  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.createdAt))
    .limit(1);

  if (existing) return existing;

  const convId = newId();
  await db.insert(conversations).values({
    id: convId,
    tenantId,
    contactId,
    whatsappAccountId: whatsappAccountId ?? undefined,
    status: "OPEN",
  });

  const [created] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);
  return created!;
}

export interface SendMessageResult {
  id: string;
  status: "queued" | "scheduled";
  createdAt: string;
}

/**
 * Envia uma mensagem de texto (livre ou template).
 * Retorna 202 — o envio real acontece no worker.
 */
export async function sendTextMessage(
  tenantId: string,
  input: z.infer<typeof sendTextSchema>,
): Promise<SendMessageResult> {
  const db = getDb();

  // 1. Verifica consentimento.
  const consented = await hasConsent(tenantId, input.contactId, "whatsapp", "WHATSAPP");
  if (!consented) throw errors.consentRequired();

  // 2. Verifica janela de 24h (texto livre só dentro da janela).
  const conversation = await getOrCreateConversation(
    tenantId,
    input.contactId,
    input.whatsappAccountId,
  );
  if (!isWithinCustomerServiceWindow(conversation.customerServiceWindowExpiresAt)) {
    throw errors.messageNotAllowed();
  }

  // 3. Idempotência.
  if (input.idempotencyKey) {
    const existing = await db
      .select({ id: messages.id, status: messages.status })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return {
        id: existing[0]!.id,
        status: existing[0]!.status === "QUEUED" ? "queued" : "scheduled",
        createdAt: new Date().toISOString(),
      };
    }
  }

  // 4. Persiste mensagem + job.
  const msgId = newId();
  const scheduledAt = input.scheduledAt
    ? new Date(input.scheduledAt).getTime()
    : nowMs();

  await db.insert(messages).values({
    id: msgId,
    tenantId,
    conversationId: conversation.id,
    contactId: input.contactId,
    direction: "OUTBOUND",
    type: "TEXT",
    content: { text: input.text, previewUrl: input.previewUrl },
    status: "QUEUED",
    idempotencyKey: input.idempotencyKey,
    createdAt: nowMs(),
  });

  await db.insert(messageJobs).values({
    id: newId(),
    tenantId,
    messageId: msgId,
    scheduledAt,
    status: "PENDING",
    nextAttemptAt: scheduledAt,
  });

  // Atualiza a ordenação da lista e notifica o atendimento em tempo real.
  await db
    .update(conversations)
    .set({ lastMessageAt: nowMs() })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversation.id)));

  await publishEvent({
    tenantId,
    type: "message.outbound",
    conversationId: conversation.id,
    messageId: msgId,
    payload: {
      id: msgId,
      conversationId: conversation.id,
      contactId: input.contactId,
      direction: "OUTBOUND",
      type: "TEXT",
      content: { text: input.text, previewUrl: input.previewUrl },
      status: "QUEUED",
      createdAt: nowMs(),
    },
  });

  return {
    id: msgId,
    status: input.scheduledAt ? "scheduled" : "queued",
    createdAt: new Date().toISOString(),
  };
}

/** Envia uma mensagem via template aprovado (fora da janela de 24h). */
export async function sendTemplateMessage(
  tenantId: string,
  input: z.infer<typeof sendTemplateSchema>,
): Promise<SendMessageResult> {
  const db = getDb();

  const consented = await hasConsent(tenantId, input.contactId, "whatsapp", "WHATSAPP");
  if (!consented) throw errors.consentRequired();

  const conversation = await getOrCreateConversation(
    tenantId,
    input.contactId,
    input.whatsappAccountId,
  );

  if (input.idempotencyKey) {
    const existing = await db
      .select({ id: messages.id, status: messages.status })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return {
        id: existing[0]!.id,
        status: existing[0]!.status === "QUEUED" ? "queued" : "scheduled",
        createdAt: new Date().toISOString(),
      };
    }
  }

  const msgId = newId();
  const scheduledAt = input.scheduledAt
    ? new Date(input.scheduledAt).getTime()
    : nowMs();

  await db.insert(messages).values({
    id: msgId,
    tenantId,
    conversationId: conversation.id,
    contactId: input.contactId,
    direction: "OUTBOUND",
    type: "TEMPLATE",
    content: {
      templateName: input.templateName,
      language: input.language,
      components: input.components ?? [],
    },
    status: "QUEUED",
    idempotencyKey: input.idempotencyKey,
  });

  await db.insert(messageJobs).values({
    id: newId(),
    tenantId,
    messageId: msgId,
    scheduledAt,
    status: "PENDING",
    nextAttemptAt: scheduledAt,
  });

  await db
    .update(conversations)
    .set({ lastMessageAt: nowMs() })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversation.id)));

  await publishEvent({
    tenantId,
    type: "message.outbound",
    conversationId: conversation.id,
    messageId: msgId,
    payload: {
      id: msgId,
      conversationId: conversation.id,
      contactId: input.contactId,
      direction: "OUTBOUND",
      type: "TEMPLATE",
      content: {
        templateName: input.templateName,
        language: input.language,
        components: input.components ?? [],
      },
      status: "QUEUED",
      createdAt: nowMs(),
    },
  });

  return {
    id: msgId,
    status: input.scheduledAt ? "scheduled" : "queued",
    createdAt: new Date().toISOString(),
  };
}

/** Envia uma mensagem de mídia (imagem/vídeo/áudio/documento) por link público. */
export async function sendMediaMessage(
  tenantId: string,
  input: z.infer<typeof sendMediaSchema>,
): Promise<SendMessageResult> {
  const db = getDb();

  // 1. Consentimento.
  const consented = await hasConsent(tenantId, input.contactId, "whatsapp", "WHATSAPP");
  if (!consented) throw errors.consentRequired();

  // 2. Mídia é mensagem livre: só é permitida dentro da janela de 24h.
  const conversation = await getOrCreateConversation(
    tenantId,
    input.contactId,
    input.whatsappAccountId,
  );
  if (!isWithinCustomerServiceWindow(conversation.customerServiceWindowExpiresAt)) {
    throw errors.messageNotAllowed();
  }

  // 3. Idempotência.
  if (input.idempotencyKey) {
    const existing = await db
      .select({ id: messages.id, status: messages.status })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return {
        id: existing[0]!.id,
        status: existing[0]!.status === "QUEUED" ? "queued" : "scheduled",
        createdAt: new Date().toISOString(),
      };
    }
  }

  const messageType = input.mediaType.toUpperCase() as
    | "IMAGE"
    | "VIDEO"
    | "AUDIO"
    | "DOCUMENT";

  // Áudio não aceita legenda pela Meta.
  const caption = input.mediaType === "audio" ? undefined : input.caption;

  const msgId = newId();
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt).getTime() : nowMs();

  await db.insert(messages).values({
    id: msgId,
    tenantId,
    conversationId: conversation.id,
    contactId: input.contactId,
    direction: "OUTBOUND",
    type: messageType,
    content: {
      mediaType: input.mediaType,
      link: input.link,
      caption,
      filename: input.filename,
    },
    status: "QUEUED",
    idempotencyKey: input.idempotencyKey,
    createdAt: nowMs(),
  });

  await db.insert(messageJobs).values({
    id: newId(),
    tenantId,
    messageId: msgId,
    scheduledAt,
    status: "PENDING",
    nextAttemptAt: scheduledAt,
  });

  await db
    .update(conversations)
    .set({ lastMessageAt: nowMs() })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversation.id)));

  await publishEvent({
    tenantId,
    type: "message.outbound",
    conversationId: conversation.id,
    messageId: msgId,
    payload: {
      id: msgId,
      conversationId: conversation.id,
      contactId: input.contactId,
      direction: "OUTBOUND",
      type: messageType,
      content: {
        mediaType: input.mediaType,
        link: input.link,
        caption,
        filename: input.filename,
      },
      status: "QUEUED",
      createdAt: nowMs(),
    },
  });

  return {
    id: msgId,
    status: input.scheduledAt ? "scheduled" : "queued",
    createdAt: new Date().toISOString(),
  };
}

/** Lista mensagens de um tenant (com filtros). */
export async function listMessages(
  tenantId: string,
  query: { conversationId?: string; limit?: number; cursor?: string },
) {
  const db = getDb();
  const limit = Math.min(query.limit ?? 50, 100);

  const whereClause = query.conversationId
    ? and(
        eq(messages.tenantId, tenantId),
        eq(messages.conversationId, query.conversationId),
      )
    : eq(messages.tenantId, tenantId);

  const rows = await db
    .select()
    .from(messages)
    .where(whereClause)
    .orderBy(desc(messages.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? String(data[data.length - 1]!.createdAt) : null;

  return { data, nextCursor, hasMore };
}

/** Obtém uma mensagem. */
export async function getMessage(tenantId: string, messageId: string) {
  const db = getDb();
  const [msg] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.id, messageId)))
    .limit(1);

  if (!msg) throw errors.notFound("Mensagem");
  return msg;
}

/** Cancela uma mensagem agendada/pendente. */
export async function cancelMessage(tenantId: string, messageId: string) {
  const db = getDb();
  const msg = await getMessage(tenantId, messageId);

  if (!["PENDING", "QUEUED", "SCHEDULED"].includes(msg.status)) {
    throw errors.validation("Não é possível cancelar uma mensagem já processada.");
  }

  await db
    .update(messages)
    .set({ status: "CANCELLED" })
    .where(and(eq(messages.tenantId, tenantId), eq(messages.id, messageId)));

  await db
    .update(messageJobs)
    .set({ status: "CANCELLED" })
    .where(eq(messageJobs.messageId, messageId));

  return { id: messageId, status: "CANCELLED" };
}
