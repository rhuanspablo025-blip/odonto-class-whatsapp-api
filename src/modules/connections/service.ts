import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../database/client.js";
import { whatsappAccounts } from "../../database/schema/index.js";
import { getWhatsAppProvider } from "../../integrations/whatsapp/factory.js";
import { errors } from "../../lib/errors.js";
import { newId, nowMs } from "../../lib/ids.js";
import {
  decodeCredentials,
  encodeCredentials,
  toPublicConnection,
  type PublicConnection,
  type WhatsAppAccountRow,
} from "./credentials.js";

/**
 * WhatsApp Connection Manager.
 *
 * Gerencia o ciclo de vida das contas WhatsApp conectadas por clínica:
 * conectar, listar, desconectar, reconectar, revogar, rotacionar credenciais
 * e verificar a saúde da conexão.
 *
 * Isolamento multi-tenant: toda operação recebe `tenantId` e as queries sempre
 * filtram por ele. Um `phone_number_id` é único GLOBALMENTE — conectar um número
 * que pertence a outra clínica é recusado.
 */

export const connectAccountSchema = z.object({
  wabaId: z.string().min(1),
  phoneNumberId: z.string().min(1),
  displayPhoneNumber: z.string().min(1).optional(),
  accessToken: z.string().min(1),
  businessId: z.string().min(1).optional(),
  onboardingMode: z
    .enum(["CLOUD_API", "EMBEDDED_SIGNUP", "COEXISTENCE"])
    .default("CLOUD_API"),
  coexistenceEnabled: z.boolean().default(false),
});

export const rotateCredentialsSchema = z.object({
  accessToken: z.string().min(1),
});

async function findRow(tenantId: string, connectionId: string): Promise<WhatsAppAccountRow> {
  const db = getDb();
  const [account] = await db
    .select()
    .from(whatsappAccounts)
    .where(
      and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, connectionId)),
    )
    .limit(1);

  if (!account) throw errors.notFound("Conexão WhatsApp");
  return account;
}

/** Lista as conexões de uma clínica (sem credenciais). */
export async function listConnections(tenantId: string): Promise<PublicConnection[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.tenantId, tenantId))
    .orderBy(desc(whatsappAccounts.createdAt));
  return rows.map(toPublicConnection);
}

/** Obtém uma conexão da clínica. */
export async function getConnection(
  tenantId: string,
  connectionId: string,
): Promise<PublicConnection> {
  return toPublicConnection(await findRow(tenantId, connectionId));
}

/**
 * Conecta (ou reconecta) uma conta WhatsApp para a clínica.
 *
 * Se o `phone_number_id` já existir para a MESMA clínica, a conexão é atualizada.
 * Se existir para OUTRA clínica, a operação é recusada (isolamento).
 */
export async function connectAccount(
  tenantId: string,
  input: z.infer<typeof connectAccountSchema>,
): Promise<PublicConnection> {
  const db = getDb();
  const now = nowMs();
  const encryptedCredentials = encodeCredentials({ accessToken: input.accessToken });

  const [existing] = await db
    .select()
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.phoneNumberId, input.phoneNumberId))
    .limit(1);

  if (existing && existing.tenantId !== tenantId) {
    throw errors.validation(
      "Este número já está conectado a outra clínica e não pode ser reutilizado.",
    );
  }

  if (existing) {
    await db
      .update(whatsappAccounts)
      .set({
        wabaId: input.wabaId,
        displayPhoneNumber: input.displayPhoneNumber ?? existing.displayPhoneNumber,
        businessId: input.businessId ?? existing.businessId,
        onboardingMode: input.onboardingMode,
        coexistenceEnabled: input.coexistenceEnabled,
        encryptedCredentials,
        status: "CONNECTED",
        updatedAt: now,
      })
      .where(
        and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, existing.id)),
      );

    return getConnection(tenantId, existing.id);
  }

  const id = newId();
  await db.insert(whatsappAccounts).values({
    id,
    tenantId,
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
    displayPhoneNumber: input.displayPhoneNumber,
    businessId: input.businessId,
    onboardingMode: input.onboardingMode,
    coexistenceEnabled: input.coexistenceEnabled,
    encryptedCredentials,
    status: "CONNECTED",
  });

  return getConnection(tenantId, id);
}

/** Marca a conexão como desconectada, mantendo o histórico e as credenciais. */
export async function disconnectAccount(
  tenantId: string,
  connectionId: string,
): Promise<PublicConnection> {
  const account = await findRow(tenantId, connectionId);
  if (account.status === "REVOKED") {
    throw errors.validation("Uma conexão revogada não pode ser desconectada.");
  }

  const db = getDb();
  await db
    .update(whatsappAccounts)
    .set({ status: "DISCONNECTED", updatedAt: nowMs() })
    .where(and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, connectionId)));

  return getConnection(tenantId, connectionId);
}

/** Reconecta uma conexão previamente desconectada. */
export async function reconnectAccount(
  tenantId: string,
  connectionId: string,
): Promise<PublicConnection> {
  const account = await findRow(tenantId, connectionId);
  if (account.status === "CONNECTED") {
    throw errors.validation("A conexão já está ativa.");
  }

  const db = getDb();
  await db
    .update(whatsappAccounts)
    .set({ status: "CONNECTED", updatedAt: nowMs() })
    .where(and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, connectionId)));

  return getConnection(tenantId, connectionId);
}

/**
 * Revoga a conexão. Estado terminal: exige novo onboarding para voltar a operar.
 */
export async function revokeAccount(
  tenantId: string,
  connectionId: string,
): Promise<PublicConnection> {
  await findRow(tenantId, connectionId);
  const db = getDb();
  await db
    .update(whatsappAccounts)
    .set({
      status: "REVOKED",
      coexistenceEnabled: false,
      updatedAt: nowMs(),
    })
    .where(and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, connectionId)));

  return getConnection(tenantId, connectionId);
}

/** Rotaciona o token de acesso da conta (re-criptografa a credencial). */
export async function rotateCredentials(
  tenantId: string,
  connectionId: string,
  input: z.infer<typeof rotateCredentialsSchema>,
): Promise<PublicConnection> {
  await findRow(tenantId, connectionId);
  const db = getDb();
  await db
    .update(whatsappAccounts)
    .set({
      encryptedCredentials: encodeCredentials({ accessToken: input.accessToken }),
      updatedAt: nowMs(),
    })
    .where(and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, connectionId)));

  return getConnection(tenantId, connectionId);
}

/** Lê as credenciais descriptografadas (uso interno — nunca expor pela API). */
export async function readCredentials(
  tenantId: string,
  connectionId: string,
): Promise<{ accessToken: string }> {
  const account = await findRow(tenantId, connectionId);
  return decodeCredentials(account.encryptedCredentials);
}

export interface ConnectionHealth {
  connectionId: string;
  status: PublicConnection["status"];
  provider: "ok" | "degraded" | "down";
  phoneNumberId: string;
  displayPhoneNumber?: string;
  checkedAt: number;
}

/**
 * Verifica a saúde da conexão pelo provedor ativo.
 * Em `WHATSAPP_PROVIDER=test` a checagem é determinística e não dispara nada.
 */
export async function checkConnectionHealth(
  tenantId: string,
  connectionId: string,
): Promise<ConnectionHealth> {
  const account = await findRow(tenantId, connectionId);

  if (account.status !== "CONNECTED") {
    return {
      connectionId: account.id,
      status: account.status,
      provider: "down",
      phoneNumberId: account.phoneNumberId,
      checkedAt: nowMs(),
    };
  }

  try {
    const provider = await getWhatsAppProvider(tenantId, account.id);
    const health = await provider.getProviderHealth();
    return {
      connectionId: account.id,
      status: account.status,
      provider: health.status,
      phoneNumberId: account.phoneNumberId,
      displayPhoneNumber: account.displayPhoneNumber ?? undefined,
      checkedAt: nowMs(),
    };
  } catch {
    return {
      connectionId: account.id,
      status: account.status,
      provider: "degraded",
      phoneNumberId: account.phoneNumberId,
      checkedAt: nowMs(),
    };
  }
}
