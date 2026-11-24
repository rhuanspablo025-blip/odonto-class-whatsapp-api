import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";

import { getEnv } from "../config/env.js";
import { generateApiKey, hashApiKey } from "../config/security.js";
import { newId } from "../lib/ids.js";
import { getDb } from "./client.js";
import { apiClients, tenants } from "./schema/index.js";

/**
 * Provisiona o tenant do CRM e emite a credencial de integração (x-api-key).
 *
 * Uso:
 *   npm run tenant:provision
 *   npm run tenant:provision -- --env-file=.env.staging
 *   npm run tenant:provision -- --slug=odonto-class --name="Odonto Class"
 *
 * A API key é gravada em arquivo (fora do Git) e NUNCA é impressa na tela,
 * conforme a política de segredos do projeto.
 */

/** Permissões concedidas ao cliente de integração do CRM. */
const CRM_PERMISSIONS = [
  "contacts:read",
  "contacts:write",
  "messages:read",
  "messages:send",
  "messages:write",
  "campaigns:read",
  "campaigns:write",
  "automations:read",
  "automations:write",
  "analytics:read",
  "whatsapp:read",
  "whatsapp:manage",
  "billing:read",
  "billing:manage",
];

/** Lê `--flag=valor` de process.argv. */
function argValue(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found?.slice(prefix.length);
}

// Carrega o arquivo de ambiente (permite apontar para staging/produção).
const envFile = argValue("env-file") ?? ".env";
try {
  process.loadEnvFile(envFile);
} catch {
  // Sem arquivo: usa variáveis já presentes no processo.
}

async function main(): Promise<void> {
  const slug = argValue("slug") ?? "odonto-class";
  const name = argValue("name") ?? "Odonto Class";
  const outFile = argValue("out") ?? path.join(".local", "api-credential.txt");

  const env = getEnv();
  const db = getDb();

  console.log(`Provisionando tenant "${slug}" em ${env.DATABASE_URL} ...`);

  // Tenant (idempotente por slug).
  await db
    .insert(tenants)
    .values({ name, slug, timezone: "America/Sao_Paulo" })
    .onConflictDoNothing();

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  if (!tenant) throw new Error("Não foi possível criar/obter o tenant.");

  // Credencial: a chave em texto puro só existe em memória e no arquivo de saída.
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const clientId = newId();

  await db.insert(apiClients).values({
    id: clientId,
    tenantId: tenant.id,
    name: "CRM Odonto Class",
    keyHash,
    keyPrefix: apiKey.slice(0, 12),
    permissions: CRM_PERMISSIONS,
  });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    [
      "# Credencial de integração do CRM (NÃO versionar).",
      `DATABASE_URL=${env.DATABASE_URL}`,
      `TENANT_ID=${tenant.id}`,
      `API_CLIENT_ID=${clientId}`,
      `API_KEY=${apiKey}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  console.log("Tenant provisionado.");
  console.log(`TENANT_ID=${tenant.id}`);
  console.log(`API_CLIENT_ID=${clientId}`);
  console.log(`KEY_PREFIX=${apiKey.slice(0, 12)}`);
  console.log(`API key gravada em ${outFile} (não exibida).`);
}

main().catch((error: unknown) => {
  console.error("Falha ao provisionar tenant:", error);
  process.exitCode = 1;
});
