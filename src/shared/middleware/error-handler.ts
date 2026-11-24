import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { AppError } from "../../lib/errors.js";

/**
 * Handler global de erros do Fastify.
 * Converte AppError em respostas estruturadas e não vaza stack traces
 * em produção.
 */
export async function errorHandler(
  this: unknown,
  error: Error,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const correlationId = (request.headers["x-correlation-id"] as string) ?? request.id;

  if (error instanceof AppError) {
    request.log.warn({ err: error.code, correlationId }, error.message);
    return reply.status(error.status).send(error.toJSON(correlationId));
  }

  // Erros de validação de entrada (Zod) → 400 com detalhes por campo.
  if (error instanceof ZodError) {
    request.log.warn({ correlationId }, "Falha de validação de entrada.");
    return reply.status(400).send({
      error: {
        code: "VALIDATION_ERROR",
        message: "Dados de entrada inválidos.",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
        correlation_id: correlationId,
      },
    });
  }

  // Erros de validação do Fastify/Zod.
  if ("validation" in error || error.name === "FastifyError") {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
    return reply.status(statusCode).send({
      error: {
        code: "VALIDATION_ERROR",
        message: error.message,
        correlation_id: correlationId,
      },
    });
  }

  request.log.error({ err: error, correlationId }, "Erro interno não tratado.");

  return reply.status(500).send({
    error: {
      code: "INTERNAL_ERROR",
      message:
        process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging"
          ? "Erro interno não esperado."
          : error.message,
      correlation_id: correlationId,
    },
  });
}
