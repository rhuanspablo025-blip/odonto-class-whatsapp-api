import { RateLimitError, WhatsAppProviderError } from "../../integrations/whatsapp/errors.js";
import type {
  CoexistenceFeatures,
  EmbeddedSignupClient,
  EmbeddedSignupToken,
  PhoneNumberSummary,
  WabaSummary,
} from "./client.js";

interface GraphError {
  code?: number;
  message?: string;
  error_subcode?: number;
  error_data?: { details?: string };
  fbtrace_id?: string;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131056]);

/**
 * Cliente Graph API para o fluxo de Embedded Signup e coexistência.
 *
 * NOTA: exige configuração externa da Meta (App ID, App Secret e configuração
 * de Embedded Signup). Sem essas credenciais o fluxo real não pode ser concluído;
 * em desenvolvimento o `TestEmbeddedSignupClient` é usado.
 */
export class MetaEmbeddedSignupClient implements EmbeddedSignupClient {
  private readonly baseUrl: string;

  constructor(version: string) {
    this.baseUrl = `https://graph.facebook.com/${version}`;
  }

  private async call<T>(
    path: string,
    options: {
      method?: "GET" | "POST";
      query?: Record<string, string | undefined>;
      token?: string;
    } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: options.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new WhatsAppProviderError(
        error instanceof Error && error.name === "TimeoutError"
          ? "Tempo limite excedido ao chamar a Meta."
          : "Falha de rede ao chamar a Meta.",
        { code: "META_NETWORK_ERROR" },
      );
    }

    const data = (await response.json().catch(() => ({}))) as T & { error?: GraphError };
    if (!response.ok) this.throwGraphError(response, data.error);
    return data;
  }

  private throwGraphError(response: Response, error?: GraphError): never {
    const message =
      [error?.message, error?.error_data?.details].filter(Boolean).join(": ") ||
      `HTTP ${response.status}`;

    if (response.status === 429 || RATE_LIMIT_CODES.has(error?.code ?? -1)) {
      throw new RateLimitError(message, 60, {
        httpStatus: response.status,
        metaErrorCode: error?.code,
        fbTraceId: error?.fbtrace_id,
      });
    }

    throw new WhatsAppProviderError(message, {
      code: "META_API_ERROR",
      httpStatus: response.status,
      metaErrorCode: error?.code,
      metaErrorSubcode: error?.error_subcode,
      fbTraceId: error?.fbtrace_id,
    });
  }

  async exchangeCodeForToken(input: {
    code: string;
    appId: string;
    appSecret: string;
  }): Promise<EmbeddedSignupToken> {
    const result = await this.call<{ access_token?: string; expires_in?: number }>(
      "/oauth/access_token",
      {
        method: "POST",
        query: {
          client_id: input.appId,
          client_secret: input.appSecret,
          code: input.code,
        },
      },
    );

    if (!result.access_token) {
      throw new WhatsAppProviderError(
        "A Meta não retornou um token ao trocar o code do Embedded Signup.",
        { code: "INVALID_META_RESPONSE", httpStatus: 502 },
      );
    }

    return { accessToken: result.access_token, expiresInSeconds: result.expires_in };
  }

  async fetchWaba(input: { accessToken: string; wabaId: string }): Promise<WabaSummary> {
    const result = await this.call<{
      id?: string;
      name?: string;
      currency?: string;
      account_review_status?: string;
    }>(`/${encodeURIComponent(input.wabaId)}`, {
      token: input.accessToken,
      query: { fields: "id,name,currency,account_review_status" },
    });

    return {
      wabaId: result.id ?? input.wabaId,
      name: result.name,
      currency: result.currency,
      accountReviewStatus: result.account_review_status,
    };
  }

  async fetchPhoneNumbers(input: {
    accessToken: string;
    wabaId: string;
  }): Promise<PhoneNumberSummary[]> {
    const result = await this.call<{
      data?: Array<{
        id?: string;
        display_phone_number?: string;
        verified_name?: string;
        platform_type?: string;
        quality_rating?: string;
      }>;
    }>(`/${encodeURIComponent(input.wabaId)}/phone_numbers`, {
      token: input.accessToken,
      query: {
        fields: "id,display_phone_number,verified_name,platform_type,quality_rating",
      },
    });

    const numbers: PhoneNumberSummary[] = [];
    for (const item of result.data ?? []) {
      if (!item.id) continue;
      numbers.push({
        phoneNumberId: item.id,
        displayPhoneNumber: item.display_phone_number,
        verifiedName: item.verified_name,
        platformType: item.platform_type,
        qualityRating: item.quality_rating,
      });
    }
    return numbers;
  }

  async fetchCoexistenceFeatures(input: {
    accessToken: string;
    phoneNumberId: string;
  }): Promise<CoexistenceFeatures> {
    const result = await this.call<{
      id?: string;
      platform_type?: string;
      is_coexistence_enabled?: boolean;
      status?: string;
    }>(`/${encodeURIComponent(input.phoneNumberId)}`, {
      token: input.accessToken,
      query: { fields: "id,platform_type,is_coexistence_enabled,status" },
    });

    return {
      phoneNumberId: result.id ?? input.phoneNumberId,
      platformType: result.platform_type,
      isCoexistenceEnabled: result.is_coexistence_enabled,
      status: result.status,
    };
  }
}
