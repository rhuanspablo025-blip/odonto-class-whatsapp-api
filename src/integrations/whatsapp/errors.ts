/**
 * Erros específicos da integração com a Meta.
 */

export class WhatsAppProviderError extends Error {
  public readonly code: string;
  public readonly httpStatus?: number;
  public readonly metaErrorCode?: number;
  public readonly metaErrorSubcode?: number;
  public readonly fbTraceId?: string;

  constructor(
    message: string,
    opts: {
      code: string;
      httpStatus?: number;
      metaErrorCode?: number;
      metaErrorSubcode?: number;
      fbTraceId?: string;
    } = {
      code: "PROVIDER_ERROR",
    },
  ) {
    super(message);
    this.name = "WhatsAppProviderError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.metaErrorCode = opts.metaErrorCode;
    this.metaErrorSubcode = opts.metaErrorSubcode;
    this.fbTraceId = opts.fbTraceId;
  }

  /** Indica se o erro é recuperável (retry). */
  isRetryable(): boolean {
    if (this.code === "META_NETWORK_ERROR") return true;
    if (this.httpStatus === 429) return true;
    if (this.httpStatus && this.httpStatus >= 500) return true;
    return [4, 17, 32, 613, 80007, 130429, 131056].includes(
      this.metaErrorCode ?? -1,
    );
  }
}

/** Erro de limite de taxa da Meta. */
export class RateLimitError extends WhatsAppProviderError {
  public readonly retryAfterSeconds: number;

  constructor(
    message: string,
    retryAfterSeconds = 60,
    opts: { httpStatus?: number; metaErrorCode?: number; fbTraceId?: string } = {},
  ) {
    super(message, {
      code: "RATE_LIMITED",
      httpStatus: opts.httpStatus ?? 429,
      metaErrorCode: opts.metaErrorCode,
      fbTraceId: opts.fbTraceId,
    });
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Erro de mensagem não permitida (fora da janela de 24h). */
export class MessageNotAllowedError extends WhatsAppProviderError {
  constructor(
    message = "Mensagem não permitida. Use um template aprovado.",
    metaErrorCode?: number,
  ) {
    super(message, {
      code: "MESSAGE_NOT_ALLOWED",
      httpStatus: 400,
      metaErrorCode,
    });
    this.name = "MessageNotAllowedError";
  }
}
