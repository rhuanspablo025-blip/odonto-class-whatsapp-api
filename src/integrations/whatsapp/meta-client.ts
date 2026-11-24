import { getEnv } from "../../config/env.js";
import {
  MessageNotAllowedError,
  RateLimitError,
  WhatsAppProviderError,
} from "./errors.js";
import type {
  MetaMessageTemplate,
  SendMediaInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
} from "./types.js";

interface MetaApiError {
  code?: number;
  message?: string;
  type?: string;
  error_subcode?: number;
  error_data?: { details?: string };
  fbtrace_id?: string;
}

interface MetaMessageResponse {
  messages?: Array<{ id?: string }>;
  error?: MetaApiError;
}

interface MetaTemplatePage {
  data?: MetaMessageTemplate[];
  paging?: { cursors?: { after?: string } };
  error?: MetaApiError;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131056]);

/**
 * Cliente HTTP para a Meta WhatsApp Cloud API.
 * Encapsula chamadas à Graph API e tratamento de erros.
 */
export class MetaClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly version: string;
  private readonly phoneNumberId: string;

  constructor(accessToken?: string, phoneNumberId?: string, version?: string) {
    const env = getEnv();
    this.accessToken = accessToken ?? env.META_ACCESS_TOKEN ?? "";
    this.version = version ?? env.META_GRAPH_API_VERSION;
    this.phoneNumberId = phoneNumberId ?? env.META_PHONE_NUMBER_ID ?? "";
    this.baseUrl = `https://graph.facebook.com/${this.version}/${this.phoneNumberId}`;
  }

  private async request<T>(
    body: Record<string, unknown>,
  ): Promise<T> {
    this.assertMessagingConfigured();

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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

    const data = (await res.json().catch(() => ({}))) as MetaMessageResponse;

    if (!res.ok) this.throwMetaError(res, data.error);

    if (!data.messages?.[0]?.id) {
      throw new WhatsAppProviderError(
        "A Meta aceitou a resposta HTTP sem retornar um ID de mensagem.",
        { code: "INVALID_META_RESPONSE", httpStatus: 502 },
      );
    }

    return data as T;
  }

  private assertMessagingConfigured(): void {
    if (!this.accessToken || !this.phoneNumberId) {
      throw new WhatsAppProviderError(
        "Credenciais da WhatsApp Cloud API não configuradas.",
        { code: "PROVIDER_NOT_CONFIGURED" },
      );
    }
  }

  private assertAccessToken(): void {
    if (!this.accessToken) {
      throw new WhatsAppProviderError("META_ACCESS_TOKEN não configurado.", {
        code: "PROVIDER_NOT_CONFIGURED",
      });
    }
  }

  private throwMetaError(response: Response, error?: MetaApiError): never {
    const metaCode = error?.code;
    const details = error?.error_data?.details;
    const message =
      [error?.message, details]
        .filter((part, index, all): part is string => Boolean(part) && all.indexOf(part) === index)
        .join(": ") || `HTTP ${response.status}`;

    if (response.status === 429 || RATE_LIMIT_CODES.has(metaCode ?? -1)) {
      throw new RateLimitError(
        message,
        this.getRetryAfterSeconds(response.headers.get("retry-after")),
        {
          httpStatus: response.status,
          metaErrorCode: metaCode,
          fbTraceId: error?.fbtrace_id,
        },
      );
    }
    // 131047: reengajamento exige template fora da janela de atendimento.
    if (metaCode === 131047) {
      throw new MessageNotAllowedError(message, metaCode);
    }
    throw new WhatsAppProviderError(message, {
      code: "META_API_ERROR",
      httpStatus: response.status,
      metaErrorCode: metaCode,
      metaErrorSubcode: error?.error_subcode,
      fbTraceId: error?.fbtrace_id,
    });
  }

  private getRetryAfterSeconds(header: string | null): number {
    if (!header) return 60;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.ceil(seconds), 3600);
    }
    const dateMs = Date.parse(header);
    if (Number.isNaN(dateMs)) return 60;
    return Math.min(Math.max(Math.ceil((dateMs - Date.now()) / 1000), 1), 3600);
  }

  /** Busca templates da WABA, seguindo paginação da Graph API. */
  async listMessageTemplates(wabaId: string): Promise<MetaMessageTemplate[]> {
    this.assertAccessToken();
    if (!wabaId) {
      throw new WhatsAppProviderError("META_WABA_ID não configurado.", {
        code: "PROVIDER_NOT_CONFIGURED",
      });
    }

    const templates: MetaMessageTemplate[] = [];
    const seenCursors = new Set<string>();
    let after: string | undefined;

    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({
        fields: "id,name,language,status,category,components",
        limit: "100",
      });
      if (after) query.set("after", after);

      let response: Response;
      try {
        response = await fetch(
          `https://graph.facebook.com/${this.version}/${encodeURIComponent(wabaId)}/message_templates?${query}`,
          {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch (error) {
        throw new WhatsAppProviderError(
          error instanceof Error && error.name === "TimeoutError"
            ? "Tempo limite excedido ao consultar templates na Meta."
            : "Falha de rede ao consultar templates na Meta.",
          { code: "META_NETWORK_ERROR" },
        );
      }

      const result = (await response.json().catch(() => ({}))) as MetaTemplatePage;
      if (!response.ok) this.throwMetaError(response, result.error);

      const pageTemplates = result.data ?? [];
      templates.push(...pageTemplates);
      const next = result.paging?.cursors?.after;
      if (!next || pageTemplates.length === 0) return templates;
      if (seenCursors.has(next)) {
        throw new WhatsAppProviderError("Paginação repetida ao consultar templates Meta.", {
          code: "INVALID_META_RESPONSE",
          httpStatus: 502,
        });
      }
      seenCursors.add(next);
      after = next;
    }

    throw new WhatsAppProviderError("A paginação de templates excedeu o limite de segurança.", {
      code: "INVALID_META_RESPONSE",
      httpStatus: 502,
    });
  }

  /** Envia mensagem de texto livre (dentro da janela de 24h). */
  async sendText(input: SendTextInput): Promise<SendResult> {
    const res = await this.request<{ messages: Array<{ id: string }> }>({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "text",
      text: {
        body: input.text,
        ...(input.previewUrl === undefined ? {} : { preview_url: input.previewUrl }),
      },
    });

    return {
      providerMessageId: res.messages[0]!.id,
      phoneNumberId: this.phoneNumberId,
    };
  }

  /** Envia mensagem via template aprovado. */
  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const res = await this.request<{ messages: Array<{ id: string }> }>({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.language },
        components: input.components ?? [],
      },
    });

    return {
      providerMessageId: res.messages[0]!.id,
      phoneNumberId: this.phoneNumberId,
    };
  }

  /** Envia mídia. */
  async sendMedia(
    to: string,
    mediaType: SendMediaInput["mediaType"],
    mediaLink: string,
    caption?: string,
  ): Promise<SendResult> {
    const isHttpUrl = (value: string) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    };
    const media = isHttpUrl(mediaLink) ? { link: mediaLink } : { id: mediaLink };
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: mediaType,
      [mediaType]: {
        ...media,
        ...(caption && mediaType !== "audio" ? { caption } : {}),
      },
    };
    const res = await this.request<{ messages: Array<{ id: string }> }>(body);
    return {
      providerMessageId: res.messages[0]!.id,
      phoneNumberId: this.phoneNumberId,
    };
  }
}
