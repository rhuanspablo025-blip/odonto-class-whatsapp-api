import type { FastifyReply, FastifyRequest } from "fastify";

import { randomToken } from "../../config/security.js";

/**
 * Adiciona um correlation ID a cada requisição (se não fornecido pelo cliente).
 * Facilita rastreabilidade de ponta a ponta.
 */
export async function correlationIdPlugin(
  request: FastifyRequest,
  _reply: FastifyReply,
) {
  const existing = request.headers["x-correlation-id"] as string | undefined;
  request.headers["x-correlation-id"] = existing ?? randomToken(16);
}
