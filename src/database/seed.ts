import { eq } from "drizzle-orm";

import { getEnv, isDeployedEnv } from "../config/env.js";
import { generateApiKey, hashApiKey } from "../config/security.js";
import { newId, nowMs } from "../lib/ids.js";
import { getDb } from "./client.js";
import { apiClients, consents, contacts, tenants } from "./schema/index.js";

/**
 * Seed de desenvolvimento. Cria um tenant, conta WhatsApp, API client e
 * dados de exemplo para testes locais.
 *
 * Protegido por NODE_ENV !== "production".
 */

// Carrega .env.
try {
  process.loadEnvFile?.();
} catch {
  // ignora
}

if (isDeployedEnv(getEnv())) {
  console.warn("Seed desabilitado em produção.");
  process.exit(0);
}

async function main(): Promise<void> {
  const db = getDb();
  console.log("Iniciando seed de desenvolvimento...");

  // Tenant base.
  await db
    .insert(tenants)
    .values({
      name: "Odonto Class",
      slug: "odonto-class",
      timezone: "America/Sao_Paulo",
    })
    .onConflictDoNothing();

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, "odonto-class"))
    .limit(1);
  if (!tenant) throw new Error("Não foi possível criar o tenant base.");

  // API client (a chave é mostrada no log — só em dev).
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  await db
    .insert(apiClients)
    .values({
      tenantId: tenant.id,
      name: "CRM Odonto Class",
      keyHash,
      keyPrefix: apiKey.slice(0, 12),
      permissions: [
        "contacts:read",
        "contacts:write",
        "messages:read",
        "messages:send",
        // Gerenciamento de templates (sincronização com a Meta e criação local).
        "messages:write",
        "campaigns:read",
        "campaigns:write",
        "automations:read",
        "automations:write",
        "analytics:read",
        // Conexão de contas reais (WhatsApp Connection Manager / Embedded Signup).
        "whatsapp:read",
        "whatsapp:manage",
        // Faturamento direto, custos e orçamentos.
        "billing:read",
        "billing:manage",
      ],
    })
    .onConflictDoNothing();

  console.log("────────────────────────────────────────────────");
  console.log("API KEY (guarde — só aparece agora):");
  console.log(apiKey);
  console.log("────────────────────────────────────────────────");

  // Contato de exemplo.
  await db
    .insert(contacts)
    .values({
      tenantId: tenant.id,
      name: "Mariana Souza",
      phoneE164: "+5511999990001",
      email: "mariana@example.com",
      externalId: "crm-001",
    })
    .onConflictDoNothing();

  const [seededContact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.externalId, "crm-001"))
    .limit(1);

  // Consentimento do contato de exemplo.
  if (seededContact) {
    await db
      .insert(consents)
      .values({
        id: newId(),
        tenantId: tenant.id,
        contactId: seededContact.id,
        purpose: "whatsapp",
        channel: "WHATSAPP",
        status: "GRANTED",
        source: "manual",
        grantedAt: nowMs(),
      })
      .onConflictDoNothing();
  }

  console.log("Seed concluído.");
}

main().catch((error: unknown) => {
  console.error("Falha no seed:", error);
  process.exitCode = 1;
});
