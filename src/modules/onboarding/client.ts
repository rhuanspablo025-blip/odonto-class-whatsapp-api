import { getEnv, isLocalEnv } from "../../config/env.js";
import { MetaEmbeddedSignupClient } from "./meta-embedded-signup-client.js";
import { TestEmbeddedSignupClient } from "./test-embedded-signup-client.js";

/**
 * Contrato do cliente de Embedded Signup da Meta.
 * Permite trocar a implementação real por um duplo determinístico em dev/testes.
 */

export interface EmbeddedSignupToken {
  accessToken: string;
  expiresInSeconds?: number;
}

export interface WabaSummary {
  wabaId: string;
  name?: string;
  currency?: string;
  accountReviewStatus?: string;
}

export interface PhoneNumberSummary {
  phoneNumberId: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  platformType?: string;
  qualityRating?: string;
}

export interface CoexistenceFeatures {
  phoneNumberId: string;
  platformType?: string;
  isCoexistenceEnabled?: boolean;
  status?: string;
}

export interface EmbeddedSignupClient {
  /** Troca o `code` do SDK por um token de negócio. */
  exchangeCodeForToken(input: {
    code: string;
    appId: string;
    appSecret: string;
  }): Promise<EmbeddedSignupToken>;

  /** Detalhes da WABA recém-conectada. */
  fetchWaba(input: { accessToken: string; wabaId: string }): Promise<WabaSummary>;

  /** Números de telefone disponíveis na WABA. */
  fetchPhoneNumbers(input: {
    accessToken: string;
    wabaId: string;
  }): Promise<PhoneNumberSummary[]>;

  /** Recursos de coexistência do número (quando expostos pela Meta). */
  fetchCoexistenceFeatures(input: {
    accessToken: string;
    phoneNumberId: string;
  }): Promise<CoexistenceFeatures>;
}

/**
 * Retorna o cliente conforme `WHATSAPP_PROVIDER`.
 * `test` (padrão em dev) evita qualquer chamada real à Meta.
 */
export function getEmbeddedSignupClient(): EmbeddedSignupClient {
  const env = getEnv();
  const force = process.env.WHATSAPP_PROVIDER;
  const useTest = force === "test" || (!force && isLocalEnv(env));
  return useTest
    ? new TestEmbeddedSignupClient()
    : new MetaEmbeddedSignupClient(env.META_GRAPH_API_VERSION);
}
