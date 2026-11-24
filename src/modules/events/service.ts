import crypto from "node:crypto";

import { and, asc, desc, eq, gt } from "drizzle-orm";

import { getEnv } from "../../config/env.js";
import { getDb } from "../../database/client.js";
import { events } from "../../database/schema/index.js";
import { newId, nowMs } from "../../lib/ids.js";

/**
 * Serviço de eventos em tempo real.
 *
 * O log de eventos é DURÁVEL (tabela `events`) e ordenado por um cursor
 * monotônico (`seq`). Isso garante que:
 *  - qualquer instância da API enxerga todos os eventos (nada fica preso na
 *    memória de uma única instância);
 *  - o cliente consegue retomar o stream a partir do último cursor conhecido,
 *    recuperando eventos perdidos durante uma desconexão.
 *
 * Cada evento carrega uma assinatura HMAC-SHA256 que permite ao consumidor
 * server-side (CRM) validar a integridade e a origem do dado.
 */

export type EventType =
  | "message.inbound"
  | "message.outbound"
  | "message.status"
  | "conversation.assigned"
  | "conversation.transferred"
  | "conversation.closed"
  | "conversation.reopened"
  | "conversation.read";

export interface PublishEventInput {
  tenantId: string;
  type: EventType;
  conversationId?: string | null;
  messageId?: string | null;
  payload?: Record<string, unknown>;
}

export interface RealtimeEvent {
  seq: number;
  id: string;
  type: EventType;
  conversationId: string | null;
  messageId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
  /** Assinatura HMAC-SHA256 do conteúdo do evento. */
  signature: string;
}

/** Serialização estável (chaves ordenadas) para assinatura determinística. */
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

function signingSecret(): string {
  const env = getEnv();
  return env.EVENTS_SIGNING_SECRET ?? env.INTERNAL_WORKER_TOKEN;
}

/** Assina o conteúdo canônico de um evento. */
export function signEventContent(content: string): string {
  return crypto.createHmac("sha256", signingSecret()).update(content).digest("hex");
}

function eventContent(event: Omit<RealtimeEvent, "signature">): string {
  return [
    event.seq,
    event.id,
    event.type,
    event.createdAt,
    event.conversationId ?? "",
    event.messageId ?? "",
    stableJson(event.payload),
  ].join(".");
}

function toRealtimeEvent(row: {
  seq: number;
  id: string;
  type: string;
  conversationId: string | null;
  messageId: string | null;
  payload: unknown;
  createdAt: number;
}): RealtimeEvent {
  const base = {
    seq: row.seq,
    id: row.id,
    type: row.type as EventType,
    conversationId: row.conversationId,
    messageId: row.messageId,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
  return { ...base, signature: signEventContent(eventContent(base)) };
}

/** Persiste um evento no log durável. */
export async function publishEvent(input: PublishEventInput): Promise<RealtimeEvent> {
  const db = getDb();
  const [row] = await db
    .insert(events)
    .values({
      id: newId(),
      tenantId: input.tenantId,
      type: input.type,
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      payload: input.payload ?? {},
      createdAt: nowMs(),
    })
    .returning();

  return toRealtimeEvent(row!);
}

/** Retorna os eventos do tenant posteriores ao cursor informado. */
export async function listEventsSince(
  tenantId: string,
  cursor: number,
  limit = 200,
): Promise<RealtimeEvent[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), gt(events.seq, cursor)))
    .orderBy(asc(events.seq))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(toRealtimeEvent);
}

/** Cursor atual (último `seq`) do tenant — usado para iniciar o stream. */
export async function getLatestCursor(tenantId: string): Promise<number> {
  const db = getDb();
  const [last] = await db
    .select({ seq: events.seq })
    .from(events)
    .where(eq(events.tenantId, tenantId))
    .orderBy(desc(events.seq))
    .limit(1);
  return last?.seq ?? 0;
}
