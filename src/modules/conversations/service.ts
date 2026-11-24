import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../database/client.js";
import {
  consents,
  contacts,
  conversations,
  messages,
} from "../../database/schema/index.js";
import { errors } from "../../lib/errors.js";
import { nowMs } from "../../lib/ids.js";
import { publishEvent } from "../events/service.js";

/**
 * Serviço de conversas / atendimento.
 *
 * Toda consulta é escopada por `tenantId` (derivado da credencial) — nunca por
 * um valor informado pelo cliente. Isso impede vazamento entre clínicas.
 */

const EXPIRING_THRESHOLD_MS = 60 * 60 * 1000;

export type ConversationStatusValue = "OPEN" | "CLOSED" | "TRANSFERRED";
export type WindowState = "OPEN" | "EXPIRING" | "CLOSED";

export interface ConversationSummary {
  id: string;
  status: ConversationStatusValue;
  contactId: string;
  contactName: string;
  contactPhone: string;
  contactStatus: string;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  lastMessageDirection: "INBOUND" | "OUTBOUND" | null;
  customerServiceWindowExpiresAt: number | null;
  windowState: WindowState;
  unreadCount: number;
  assignedUserId: string | null;
  assignedUserName: string | null;
  assignedAt: number | null;
  closedAt: number | null;
  createdAt: number;
}

export interface ConversationDetail extends ConversationSummary {
  whatsappAccountId: string | null;
  contactEmail: string | null;
  contactExternalId: string | null;
  consents: Array<{
    purpose: string;
    channel: string;
    status: "GRANTED" | "REVOKED";
    grantedAt: number;
    revokedAt: number | null;
  }>;
}

export interface ConversationListQuery {
  limit?: number;
  status?: ConversationStatusValue;
  assignedUserId?: string | null;
  search?: string;
}

/** Calcula o estado da janela de atendimento de 24h da Meta. */
export function resolveWindowState(
  windowExpiresAt: number | null | undefined,
): WindowState {
  if (!windowExpiresAt) return "CLOSED";
  const remaining = windowExpiresAt - nowMs();
  if (remaining <= 0) return "CLOSED";
  if (remaining <= EXPIRING_THRESHOLD_MS) return "EXPIRING";
  return "OPEN";
}

/** Extrai uma prévia textual legível do conteúdo de uma mensagem. */
function messagePreview(message: {
  type: string;
  direction: string;
  content: unknown;
}): string {
  const content = (message.content ?? {}) as Record<string, unknown>;
  if (message.type === "TEXT") {
    const text = typeof content.text === "string" ? content.text : "";
    if (text) return text;
    const body = content.body;
    if (typeof body === "string") return body;
  }
  if (message.type === "TEMPLATE") {
    const name = typeof content.templateName === "string" ? content.templateName : null;
    return name ? `Template: ${name}` : "Template enviado";
  }
  const labels: Record<string, string> = {
    IMAGE: "Imagem",
    VIDEO: "Vídeo",
    AUDIO: "Áudio",
    DOCUMENT: "Documento",
    LOCATION: "Localização",
  };
  return labels[message.type] ?? "Mensagem";
}

export async function listConversations(
  tenantId: string,
  query: ConversationListQuery = {},
): Promise<ConversationSummary[]> {
  const db = getDb();
  const limit = Math.min(query.limit ?? 50, 100);

  const conditions = [eq(conversations.tenantId, tenantId)];
  if (query.status) conditions.push(eq(conversations.status, query.status));
  if (query.assignedUserId === null) {
    conditions.push(isNull(conversations.assignedUserId));
  } else if (typeof query.assignedUserId === "string") {
    conditions.push(eq(conversations.assignedUserId, query.assignedUserId));
  }

  const rows = await db
    .select({
      conversation: conversations,
      contactName: contacts.name,
      contactPhone: contacts.phoneE164,
      contactStatus: contacts.status,
    })
    .from(conversations)
    .innerJoin(contacts, eq(conversations.contactId, contacts.id))
    .where(and(...conditions))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
    .limit(limit);

  if (rows.length === 0) return [];

  const conversationIds = rows.map((row) => row.conversation.id);
  const lastMessages = await db
    .select({
      conversationId: messages.conversationId,
      type: messages.type,
      direction: messages.direction,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        inArray(messages.conversationId, conversationIds),
      ),
    )
    .orderBy(desc(messages.createdAt));

  const previewByConversation = new Map<
    string,
    { preview: string; direction: "INBOUND" | "OUTBOUND" }
  >();
  for (const message of lastMessages) {
    if (previewByConversation.has(message.conversationId)) continue;
    previewByConversation.set(message.conversationId, {
      preview: messagePreview(message),
      direction: message.direction as "INBOUND" | "OUTBOUND",
    });
  }

  const search = query.search?.trim().toLowerCase();

  return rows
    .map((row) => toSummary(row, previewByConversation.get(row.conversation.id)))
    .filter((summary) => {
      if (!search) return true;
      return (
        summary.contactName.toLowerCase().includes(search) ||
        summary.contactPhone.toLowerCase().includes(search) ||
        (summary.lastMessagePreview ?? "").toLowerCase().includes(search)
      );
    });
}

type SummaryRow = {
  conversation: typeof conversations.$inferSelect;
  contactName: string;
  contactPhone: string;
  contactStatus: string;
};

function toSummary(
  row: SummaryRow,
  lastMessage?: { preview: string; direction: "INBOUND" | "OUTBOUND" },
): ConversationSummary {
  const conv = row.conversation;
  return {
    id: conv.id,
    status: conv.status as ConversationStatusValue,
    contactId: conv.contactId,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactStatus: row.contactStatus,
    lastMessageAt: conv.lastMessageAt,
    lastMessagePreview: lastMessage?.preview ?? null,
    lastMessageDirection: lastMessage?.direction ?? null,
    customerServiceWindowExpiresAt: conv.customerServiceWindowExpiresAt,
    windowState: resolveWindowState(conv.customerServiceWindowExpiresAt),
    unreadCount: conv.unreadCount,
    assignedUserId: conv.assignedUserId,
    assignedUserName: conv.assignedUserName,
    assignedAt: conv.assignedAt,
    closedAt: conv.closedAt,
    createdAt: conv.createdAt,
  };
}

/** Busca a conversa garantindo o isolamento por tenant. */
export async function getConversationRecord(tenantId: string, conversationId: string) {
  const db = getDb();
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
    .limit(1);
  if (!conv) throw errors.notFound("Conversa");
  return conv;
}

export async function getConversationDetail(
  tenantId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const db = getDb();
  const conv = await getConversationRecord(tenantId, conversationId);

  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, conv.contactId)))
    .limit(1);

  const [lastMessage] = await db
    .select({
      type: messages.type,
      direction: messages.direction,
      content: messages.content,
    })
    .from(messages)
    .where(
      and(eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId)),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const consentRows = await db
    .select()
    .from(consents)
    .where(and(eq(consents.tenantId, tenantId), eq(consents.contactId, conv.contactId)))
    .orderBy(desc(consents.grantedAt));

  return {
    ...toSummary(
      {
        conversation: conv,
        contactName: contact?.name ?? "Contato",
        contactPhone: contact?.phoneE164 ?? "",
        contactStatus: contact?.status ?? "ACTIVE",
      },
      lastMessage
        ? {
            preview: messagePreview(lastMessage),
            direction: lastMessage.direction as "INBOUND" | "OUTBOUND",
          }
        : undefined,
    ),
    whatsappAccountId: conv.whatsappAccountId,
    contactEmail: contact?.email ?? null,
    contactExternalId: contact?.externalId ?? null,
    consents: consentRows.map((consent) => ({
      purpose: consent.purpose,
      channel: consent.channel,
      status: consent.status as "GRANTED" | "REVOKED",
      grantedAt: consent.grantedAt,
      revokedAt: consent.revokedAt,
    })),
  };
}

// ── Atribuição de atendimento (Fase 6) ──────────────────────────────────────

export const assignConversationSchema = z.object({
  userId: z.string().min(1).max(200),
  userName: z.string().max(200).optional(),
  /**
   * Guarda de concorrência otimista: se informado, a atribuição só é aplicada
   * quando o responsável atual for exatamente este valor (`null` = sem dono).
   */
  expectedAssigneeUserId: z.string().max(200).nullable().optional(),
});

export const transferConversationSchema = z.object({
  toUserId: z.string().min(1).max(200),
  toUserName: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
  expectedAssigneeUserId: z.string().max(200).nullable().optional(),
});

type ConvRow = typeof conversations.$inferSelect;

async function applyAssignment(
  tenantId: string,
  conversationId: string,
  next: { userId: string | null; userName: string | null },
  expectedAssigneeUserId: string | null | undefined,
): Promise<ConvRow> {
  const db = getDb();
  const current = await getConversationRecord(tenantId, conversationId);

  if (expectedAssigneeUserId !== undefined) {
    const currentAssignee = current.assignedUserId ?? null;
    if (currentAssignee !== expectedAssigneeUserId) {
      throw errors.validation(
        "A conversa foi atribuída a outro atendente enquanto você editava. Recarregue e tente novamente.",
        { code: "ASSIGNMENT_CONFLICT", assignedUserId: currentAssignee },
      );
    }
  }

  const previousAssigneeUserId = current.assignedUserId ?? null;
  const previousAssigneeName = current.assignedUserName ?? null;

  await db
    .update(conversations)
    .set({
      assignedUserId: next.userId,
      assignedUserName: next.userName,
      assignedAt: next.userId ? nowMs() : null,
    })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));

  const updated = await getConversationRecord(tenantId, conversationId);

  await publishEvent({
    tenantId,
    type: previousAssigneeUserId ? "conversation.transferred" : "conversation.assigned",
    conversationId,
    payload: {
      assignedUserId: next.userId,
      assignedUserName: next.userName,
      previousAssigneeUserId,
      previousAssigneeName,
    },
  });

  return updated;
}

export async function assignConversation(
  tenantId: string,
  conversationId: string,
  input: z.infer<typeof assignConversationSchema>,
): Promise<ConversationSummary> {
  const updated = await applyAssignment(
    tenantId,
    conversationId,
    { userId: input.userId, userName: input.userName ?? null },
    input.expectedAssigneeUserId,
  );
  return getConversationDetail(tenantId, updated.id);
}

export async function transferConversation(
  tenantId: string,
  conversationId: string,
  input: z.infer<typeof transferConversationSchema>,
): Promise<ConversationSummary> {
  const updated = await applyAssignment(
    tenantId,
    conversationId,
    { userId: input.toUserId, userName: input.toUserName ?? null },
    input.expectedAssigneeUserId,
  );
  if (input.note) {
    await publishEvent({
      tenantId,
      type: "conversation.transferred",
      conversationId,
      payload: { note: input.note, toUserId: input.toUserId },
    });
  }
  return getConversationDetail(tenantId, updated.id);
}

export async function closeConversation(
  tenantId: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const db = getDb();
  const current = await getConversationRecord(tenantId, conversationId);
  if (current.status === "CLOSED") return getConversationDetail(tenantId, conversationId);

  await db
    .update(conversations)
    .set({ status: "CLOSED", closedAt: nowMs() })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));

  await publishEvent({
    tenantId,
    type: "conversation.closed",
    conversationId,
    payload: { closedAt: nowMs() },
  });

  return getConversationDetail(tenantId, conversationId);
}

export async function reopenConversation(
  tenantId: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const db = getDb();
  const current = await getConversationRecord(tenantId, conversationId);
  if (current.status === "OPEN") return getConversationDetail(tenantId, conversationId);

  // Reabrir mantém a janela real: se já expirou, o envio volta a exigir template
  // (a Meta não permite texto livre após 24h sem mensagem do contato).
  const windowExpiresAt =
    current.customerServiceWindowExpiresAt && current.customerServiceWindowExpiresAt > nowMs()
      ? current.customerServiceWindowExpiresAt
      : null;

  await db
    .update(conversations)
    .set({
      status: "OPEN",
      closedAt: null,
      customerServiceWindowExpiresAt: windowExpiresAt,
    })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));

  await publishEvent({
    tenantId,
    type: "conversation.reopened",
    conversationId,
    payload: { reopenedAt: nowMs() },
  });

  return getConversationDetail(tenantId, conversationId);
}

export async function markConversationRead(
  tenantId: string,
  conversationId: string,
): Promise<{ id: string; unreadCount: number }> {
  const db = getDb();
  const current = await getConversationRecord(tenantId, conversationId);
  if (current.unreadCount === 0) return { id: conversationId, unreadCount: 0 };

  await db
    .update(conversations)
    .set({ unreadCount: 0, lastReadAt: nowMs() })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));

  await publishEvent({
    tenantId,
    type: "conversation.read",
    conversationId,
    payload: { lastReadAt: nowMs() },
  });

  return { id: conversationId, unreadCount: 0 };
}

/** Marca como lidas todas as conversas atribuídas a um atendente. */
export async function markAllRead(
  tenantId: string,
  assignedUserId?: string,
): Promise<{ updated: number }> {
  const db = getDb();
  const conditions = [eq(conversations.tenantId, tenantId), sql`${conversations.unreadCount} > 0`];
  if (assignedUserId) conditions.push(eq(conversations.assignedUserId, assignedUserId));

  const result = await db
    .update(conversations)
    .set({ unreadCount: 0, lastReadAt: nowMs() })
    .where(and(...conditions));

  return { updated: result.rowsAffected };
}

/** Utilitário usado pelo webhook ao receber uma mensagem nova. */
export async function incrementUnread(
  tenantId: string,
  conversationId: string,
  windowExpiresAt: number,
): Promise<void> {
  const db = getDb();
  await db
    .update(conversations)
    .set({
      lastMessageAt: nowMs(),
      customerServiceWindowExpiresAt: windowExpiresAt,
      unreadCount: sql`${conversations.unreadCount} + 1`,
    })
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.id, conversationId),
      ),
    );
}
