import { decryptSecret, encryptSecret } from "../../config/security.js";
import { errors } from "../../lib/errors.js";
import type { whatsappAccounts } from "../../database/schema/index.js";

/**
 * Credenciais da conta WhatsApp e projeção pública da conexão.
 *
 * As credenciais NUNCA são expostas pela API: apenas armazenadas criptografadas
 * (AES-256-GCM) e lidas internamente pelo factory de provedor.
 */

export interface WhatsAppAccountCredentials {
  accessToken: string;
}

/** Tipo completo da linha da tabela `whatsapp_accounts`. */
export type WhatsAppAccountRow = typeof whatsappAccounts.$inferSelect;

/** Serializa e criptografa as credenciais para persistência. */
export function encodeCredentials(credentials: WhatsAppAccountCredentials): string {
  return encryptSecret(JSON.stringify({ accessToken: credentials.accessToken }));
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Lê credenciais criptografadas.
 * Aceita o formato atual (`{"accessToken": "..."}`) e o legado (token puro).
 */
export function decodeCredentials(encrypted: string): WhatsAppAccountCredentials {
  const plain = decryptSecret(encrypted);
  const parsed = parseJson(plain);

  if (parsed) {
    const candidate = parsed.accessToken ?? parsed.access_token ?? parsed.token;
    if (typeof candidate === "string" && candidate.length > 0) {
      return { accessToken: candidate };
    }
    throw errors.validation("Credencial de acesso Meta ausente na conta conectada.");
  }

  // Formato legado: o valor criptografado continha apenas o token.
  if (plain.length === 0) {
    throw errors.validation("Credencial de acesso Meta ausente na conta conectada.");
  }
  return { accessToken: plain };
}

/** Visão pública de uma conexão (sem credenciais). */
export interface PublicConnection {
  id: string;
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber: string | null;
  status: WhatsAppAccountRow["status"];
  onboardingMode: WhatsAppAccountRow["onboardingMode"];
  coexistenceEnabled: boolean;
  businessId: string | null;
  billingMode: WhatsAppAccountRow["billingMode"];
  billingStatus: WhatsAppAccountRow["billingStatus"];
  billingVerifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Remove qualquer dado sensível antes de devolver a conexão pela API. */
export function toPublicConnection(account: WhatsAppAccountRow): PublicConnection {
  return {
    id: account.id,
    phoneNumberId: account.phoneNumberId,
    wabaId: account.wabaId,
    displayPhoneNumber: account.displayPhoneNumber ?? null,
    status: account.status,
    onboardingMode: account.onboardingMode,
    coexistenceEnabled: account.coexistenceEnabled,
    businessId: account.businessId ?? null,
    billingMode: account.billingMode,
    billingStatus: account.billingStatus,
    billingVerifiedAt: account.billingVerifiedAt ?? null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
