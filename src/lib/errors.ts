/**
 * Códigos de erro estáveis da API (seção 19 do spec).
 * Cada erro possui: código, mensagem, status HTTP e correlation ID.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "AUTHENTICATION_ERROR"
  | "AUTHORIZATION_ERROR"
  | "RESOURCE_NOT_FOUND"
  | "CONSENT_REQUIRED"
  | "TEMPLATE_NOT_APPROVED"
  | "MESSAGE_NOT_ALLOWED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "DATABASE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface ErrorDetails {
  code: ErrorCode;
  message: string;
  status: number;
  details?: unknown;
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  AUTHENTICATION_ERROR: 401,
  AUTHORIZATION_ERROR: 403,
  RESOURCE_NOT_FOUND: 404,
  CONSENT_REQUIRED: 403,
  TEMPLATE_NOT_APPROVED: 409,
  MESSAGE_NOT_ALLOWED: 403,
  RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 502,
  DATABASE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  toJSON(correlationId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        correlation_id: correlationId,
      },
    };
  }
}

// Helpers de conveniência.
export const errors = {
  validation: (message: string, details?: unknown) =>
    new AppError("VALIDATION_ERROR", message, details),
  authentication: (message = "Credencial inválida ou ausente.") =>
    new AppError("AUTHENTICATION_ERROR", message),
  authorization: (message = "Permissão insuficiente para este recurso.") =>
    new AppError("AUTHORIZATION_ERROR", message),
  notFound: (resource: string) =>
    new AppError("RESOURCE_NOT_FOUND", `${resource} não encontrado(a).`),
  consentRequired: (message = "Consentimento do contato é obrigatório para esta ação.") =>
    new AppError("CONSENT_REQUIRED", message),
  templateNotApproved: (message = "Template não está aprovado no provedor.") =>
    new AppError("TEMPLATE_NOT_APPROVED", message),
  messageNotAllowed: (message = "Mensagem não permitida fora da janela de atendimento.") =>
    new AppError("MESSAGE_NOT_ALLOWED", message),
  rateLimited: (message = "Limite de requisições excedido.") =>
    new AppError("RATE_LIMITED", message),
  provider: (message = "Provedor (Meta) indisponível no momento.") =>
    new AppError("PROVIDER_UNAVAILABLE", message),
  database: (message = "Banco de dados indisponível.") =>
    new AppError("DATABASE_UNAVAILABLE", message),
  internal: (message = "Erro interno não esperado.") =>
    new AppError("INTERNAL_ERROR", message),
};
