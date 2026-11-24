import { randomToken } from "../../config/security.js";
import type {
  CoexistenceFeatures,
  EmbeddedSignupClient,
  EmbeddedSignupToken,
  PhoneNumberSummary,
  WabaSummary,
} from "./client.js";

/**
 * Duplo determinístico do Embedded Signup — sem chamadas reais à Meta.
 * Usado em `WHATSAPP_PROVIDER=test` (padrão em desenvolvimento).
 */
export class TestEmbeddedSignupClient implements EmbeddedSignupClient {
  public readonly isTestClient = true;

  async exchangeCodeForToken(input: {
    code: string;
    appId: string;
    appSecret: string;
  }): Promise<EmbeddedSignupToken> {
    if (input.code.startsWith("invalid")) {
      throw new Error("Code de Embedded Signup inválido (cliente de teste).");
    }
    return {
      accessToken: `test-es-token-${randomToken(8)}`,
      expiresInSeconds: 3600,
    };
  }

  async fetchWaba(input: { accessToken: string; wabaId: string }): Promise<WabaSummary> {
    return {
      wabaId: input.wabaId,
      name: `WABA de teste ${input.wabaId}`,
      currency: "BRL",
      accountReviewStatus: "APPROVED",
    };
  }

  async fetchPhoneNumbers(input: {
    accessToken: string;
    wabaId: string;
  }): Promise<PhoneNumberSummary[]> {
    return [
      {
        phoneNumberId: `phone-${input.wabaId}`,
        displayPhoneNumber: "+5500000000000",
        verifiedName: "Número de teste",
        platformType: "CLOUD_API",
        qualityRating: "GREEN",
      },
    ];
  }

  async fetchCoexistenceFeatures(input: {
    accessToken: string;
    phoneNumberId: string;
  }): Promise<CoexistenceFeatures> {
    return {
      phoneNumberId: input.phoneNumberId,
      platformType: "CLOUD_API",
      isCoexistenceEnabled: true,
      status: "CONNECTED",
    };
  }
}
