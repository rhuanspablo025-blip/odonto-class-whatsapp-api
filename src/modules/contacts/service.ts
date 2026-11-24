import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../database/client.js";
import { consents, contacts } from "../../database/schema/index.js";
import { errors } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";

/**
 * Serviço de contatos.
 * Isolamento multi-tenant: todas as queries incluem `tenantId`.
 */

export const createContactSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z
    .string()
    .regex(/^\+\d{6,15}$/, "Telefone deve estar no formato E.164 (ex: +5511999990000)"),
  email: z.string().email().optional(),
  externalId: z.string().max(100).optional(),
});

export const updateContactSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional().nullable(),
  status: z.enum(["ACTIVE", "OPTED_OUT", "DELETED"]).optional(),
});

export interface ContactListQuery {
  limit?: number;
  cursor?: string;
}

export async function listContacts(tenantId: string, query: ContactListQuery) {
  const db = getDb();
  const limit = Math.min(query.limit ?? 50, 100);

  const whereClause = query.cursor
    ? and(
        eq(contacts.tenantId, tenantId),
        lt(contacts.createdAt, Number(query.cursor)),
      )
    : eq(contacts.tenantId, tenantId);

  const rows = await db
    .select()
    .from(contacts)
    .where(whereClause)
    .orderBy(desc(contacts.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? String(data[data.length - 1]!.createdAt) : null;

  return { data, nextCursor, hasMore };
}

export async function getContact(tenantId: string, contactId: string) {
  const db = getDb();
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)))
    .limit(1);

  if (!contact) throw errors.notFound("Contato");
  return contact;
}

export async function createContact(
  tenantId: string,
  input: z.infer<typeof createContactSchema>,
) {
  const db = getDb();
  const id = newId();

  try {
    await db.insert(contacts).values({
      id,
      tenantId,
      name: input.name,
      phoneE164: input.phone,
      email: input.email,
      externalId: input.externalId,
    });
  } catch (e) {
    // Violação de unicidade (telefone ou external_id).
    throw errors.validation("Telefone ou ID externo já cadastrado para esta clínica.");
  }

  return getContact(tenantId, id);
}

export async function updateContact(
  tenantId: string,
  contactId: string,
  input: z.infer<typeof updateContactSchema>,
) {
  const db = getDb();
  const existing = await getContact(tenantId, contactId);

  await db
    .update(contacts)
    .set({
      name: input.name ?? existing.name,
      email: input.email ?? existing.email,
      status: input.status ?? existing.status,
    })
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)));

  return getContact(tenantId, contactId);
}

export async function deleteContact(tenantId: string, contactId: string) {
  const db = getDb();
  const result = await db
    .delete(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)));

  if (result.rowsAffected === 0) throw errors.notFound("Contato");
  return { deleted: true };
}

// ── Consentimentos ─────────────────────────────────────────────────────────

export const consentSchema = z.object({
  purpose: z.string().min(1).max(100),
  channel: z.enum(["WHATSAPP", "SMS", "EMAIL"]),
  status: z.enum(["GRANTED", "REVOKED"]),
  source: z.string().max(200).optional(),
  evidenceReference: z.string().max(200).optional(),
});

export async function listConsents(tenantId: string, contactId: string) {
  // Garante que o contato pertence ao tenant.
  await getContact(tenantId, contactId);

  const db = getDb();
  return db
    .select()
    .from(consents)
    .where(and(eq(consents.tenantId, tenantId), eq(consents.contactId, contactId)))
    .orderBy(desc(consents.grantedAt));
}

export async function upsertConsent(
  tenantId: string,
  contactId: string,
  input: z.infer<typeof consentSchema>,
) {
  await getContact(tenantId, contactId);
  const db = getDb();
  const now = Date.now();

  await db
    .insert(consents)
    .values({
      id: newId(),
      tenantId,
      contactId,
      purpose: input.purpose,
      channel: input.channel,
      status: input.status,
      source: input.source,
      evidenceReference: input.evidenceReference,
      grantedAt: now,
      revokedAt: input.status === "REVOKED" ? now : null,
    })
    .onConflictDoUpdate({
      target: [consents.tenantId, consents.contactId, consents.purpose, consents.channel],
      set: {
        status: input.status,
        source: input.source,
        evidenceReference: input.evidenceReference,
        revokedAt: input.status === "REVOKED" ? now : null,
      },
    });

  return listConsents(tenantId, contactId);
}

/** Verifica se o contato tem consentimento válido para um propósito/canal. */
export async function hasConsent(
  tenantId: string,
  contactId: string,
  purpose: string,
  channel: "WHATSAPP" | "SMS" | "EMAIL" = "WHATSAPP",
): Promise<boolean> {
  const db = getDb();
  const [consent] = await db
    .select({ status: consents.status })
    .from(consents)
    .where(
      and(
        eq(consents.tenantId, tenantId),
        eq(consents.contactId, contactId),
        eq(consents.purpose, purpose),
        eq(consents.channel, channel),
      ),
    )
    .limit(1);
  return consent?.status === "GRANTED";
}
