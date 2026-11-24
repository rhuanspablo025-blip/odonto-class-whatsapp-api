import { getEnv, isLocalEnv } from "../../config/env.js";
import { decryptSecret } from "../../config/security.js";
import { getDb } from "../../database/client.js";
import { whatsappAccounts } from "../../database/schema/index.js";
import { eq, and } from "drizzle-orm";
import { WhatsAppProviderError } from "./errors.js";
import { MetaCloudProvider } from "./meta-provider.js";
import type { WhatsAppProvider } from "./provider.js";
import { TestWhatsAppProvider } from "./test-provider.js";

/**
 * Factory do provedor WhatsApp.
 *
 * - Em `production`: usa MetaCloudProvider (exige credenciais).
 * - Em `development`/`test`: usa TestWhatsAppProvider.
 *
 * Também suporta override via variável WHATSAPP_PROVIDER=meta|test.
 */
let testProvider: TestWhatsAppProvider | undefined;

export async function getWhatsAppProvider(
  tenantId?: string,
  whatsappAccountId?: string | null,
): Promise<WhatsAppProvider> {
  const env = getEnv();
  const force = process.env.WHATSAPP_PROVIDER;
  const useTest = force === "test" || (!force && isLocalEnv(env));

  if (useTest) {
    testProvider ??= new TestWhatsAppProvider();
    return testProvider;
  }

  if (tenantId && whatsappAccountId) {
    const db = getDb();
    const [account] = await db
      .select({
        id: whatsappAccounts.id,
        tenantId: whatsappAccounts.tenantId,
        phoneNumberId: whatsappAccounts.phoneNumberId,
        wabaId: whatsappAccounts.wabaId,
        encryptedCredentials: whatsappAccounts.encryptedCredentials,
      })
      .from(whatsappAccounts)
      .where(
        and(
          eq(whatsappAccounts.id, whatsappAccountId),
          eq(whatsappAccounts.tenantId, tenantId),
          eq(whatsappAccounts.status, "CONNECTED"),
        ),
      )
      .limit(1);

    if (!account) {
      throw new WhatsAppProviderError("A conta WhatsApp da conversa não está conectada.", {
        code: "WHATSAPP_ACCOUNT_NOT_CONNECTED",
      });
    }

    let encryptedValue: string;
    try {
      encryptedValue = decryptSecret(account.encryptedCredentials);
    } catch {
      throw new WhatsAppProviderError("Não foi possível descriptografar as credenciais Meta.", {
        code: "WHATSAPP_CREDENTIALS_INVALID",
      });
    }

    let accessToken = encryptedValue;
    try {
      const credentials = JSON.parse(encryptedValue) as {
        accessToken?: string;
        access_token?: string;
        token?: string;
      };
      accessToken = credentials.accessToken ?? credentials.access_token ?? credentials.token ?? "";
    } catch {
      // Compatibilidade com o formato legado, que criptografava apenas o token.
    }
    if (!accessToken) {
      throw new WhatsAppProviderError("Credencial de acesso Meta ausente na conta.", {
        code: "WHATSAPP_CREDENTIALS_INVALID",
      });
    }

    return new MetaCloudProvider(
      accessToken,
      account.phoneNumberId,
      env.META_GRAPH_API_VERSION,
      account.id,
      account.tenantId,
      account.wabaId,
    );
  }

  if (tenantId) {
    throw new WhatsAppProviderError("A conversa não está vinculada a uma conta WhatsApp.", {
      code: "WHATSAPP_ACCOUNT_NOT_CONNECTED",
    });
  }
  return new MetaCloudProvider(env.META_ACCESS_TOKEN, env.META_PHONE_NUMBER_ID);
}

/** Reseta o cache (uso em testes). */
export function resetProviderCache(): void {
  testProvider = undefined;
}
