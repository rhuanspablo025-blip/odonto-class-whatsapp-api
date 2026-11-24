import type { FastifyInstance } from "fastify";

import { authenticate, getAuth, requirePermission } from "../auth/auth.js";
import {
  cancelMessage,
  getMessage,
  listMessages,
  sendMediaMessage,
  sendMediaSchema,
  sendTemplateMessage,
  sendTemplateSchema,
  sendTextMessage,
  sendTextSchema,
} from "./service.js";

/**
 * Rotas de mensagens.
 * POST /messages — envia texto ou template (assíncrono, 202).
 */
export async function messagesRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  // Enviar mensagem.
  app.post(
    "/messages",
    { preHandler: requirePermission("messages:send") },
    async (request, reply) => {
      const { tenantId } = getAuth(request);
      const body = request.body as Record<string, unknown>;

      // Decide entre template, mídia e texto a partir do corpo.
      if (body.templateName) {
        const parsed = sendTemplateSchema.parse(body);
        const result = await sendTemplateMessage(tenantId, parsed);
        return reply.status(202).send(result);
      }

      if (body.mediaType) {
        const parsed = sendMediaSchema.parse(body);
        const result = await sendMediaMessage(tenantId, parsed);
        return reply.status(202).send(result);
      }

      const parsed = sendTextSchema.parse(body);
      const result = await sendTextMessage(tenantId, parsed);
      return reply.status(202).send(result);
    },
  );

  // Listar mensagens.
  app.get(
    "/messages",
    { preHandler: requirePermission("messages:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { conversationId, limit, cursor } = request.query as {
        conversationId?: string;
        limit?: string;
        cursor?: string;
      };
      return listMessages(tenantId, {
        conversationId,
        limit: limit ? Number(limit) : undefined,
        cursor,
      });
    },
  );

  // Obter mensagem.
  app.get(
    "/messages/:id",
    { preHandler: requirePermission("messages:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return getMessage(tenantId, id);
    },
  );

  // Cancelar mensagem.
  app.post(
    "/messages/:id/cancel",
    { preHandler: requirePermission("messages:send") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return cancelMessage(tenantId, id);
    },
  );
}
