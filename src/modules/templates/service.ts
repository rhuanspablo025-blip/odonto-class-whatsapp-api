import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../database/client.js";
import { templates, whatsappAccounts } from "../../database/schema/index.js";
import { errors } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { getWhatsAppProvider } from "../../integrations/whatsapp/factory.js";

/**
 * Módulo de Templates WhatsApp.
 *
 * Templates são gerenciados na plataforma da Meta e sincronizados localmente.
 * Apenas templates APPROVED podem ser usados em envios.
 */

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(512),
  category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]).default("MARKETING"),
  language: z.string().default("pt_BR"),
  components: z.record(z.string(), z.unknown()).default({}),
});

/** Sincroniza templates da Meta para o banco local. */
export async function syncTemplates(tenantId: string): Promise<{ synced: number }> {
  const db = getDb();
  const accounts = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(
      and(
        eq(whatsappAccounts.tenantId, tenantId),
        eq(whatsappAccounts.status, "CONNECTED"),
      ),
    );

  if (accounts.length === 0) {
    const provider = await getWhatsAppProvider(tenantId);
    return { synced: await provider.syncTemplates() };
  }

  let synced = 0;
  for (const account of accounts) {
    const provider = await getWhatsAppProvider(tenantId, account.id);
    synced += await provider.syncTemplates();
  }
  return { synced };
}

/** Lista templates do tenant. */
export async function listTemplates(tenantId: string) {
  const db = getDb();
  return db
    .select()
    .from(templates)
    .where(eq(templates.tenantId, tenantId))
    .orderBy(desc(templates.createdAt));
}

/** Cria um template local (sem sincronizar com a Meta). */
export async function createTemplate(
  tenantId: string,
  input: z.infer<typeof createTemplateSchema>,
) {
  const db = getDb();

  const [existing] = await db
    .select({ id: templates.id })
    .from(templates)
    .where(
      and(
        eq(templates.tenantId, tenantId),
        eq(templates.name, input.name),
        eq(templates.language, input.language),
      ),
    )
    .limit(1);

  if (existing) throw errors.validation("Template já existe com este nome e idioma.");

  const id = newId();

  await db.insert(templates).values({
    id,
    tenantId,
    name: input.name,
    category: input.category,
    language: input.language,
    status: "PENDING",
    components: input.components,
  });

  const [created] = await db
    .select()
    .from(templates)
    .where(eq(templates.id, id))
    .limit(1);

  return created!;
}
