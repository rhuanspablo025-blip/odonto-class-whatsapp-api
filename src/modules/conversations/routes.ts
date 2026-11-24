import type { FastifyInstance } from "fastify";

import { authenticate, getAuth, requirePermission } from "../auth/auth.js";
import { listMessages } from "../messages/service.js";
import {
  assignConversation,
  assignConversationSchema,
  closeConversation,
  getConversationDetail,
  listConversations,
  markAllRead,
  markConversationRead,
  reopenConversation,
  transferConversation,
  transferConversationSchema,
} from "./service.js";

/**
 * Rotas de conversas / atendimento.
 *
 * Leitura exige `messages:read`; operações de atendimento (atribuir, transferir,
 * encerrar, reabrir, marcar como lida) exigem `messages:send`.
 * O tenant é SEMPRE derivado da credencial — nunca do corpo/query.
 */
export async function conversationsRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  app.get(
    "/conversations",
    { preHandler: requirePermission("messages:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const query = request.query as {
        limit?: string;
        status?: string;
        assignedUserId?: string;
        search?: string;
      };

      const status =
        query.status === "OPEN" || query.status === "CLOSED" || query.status === "TRANSFERRED"
          ? query.status
          : undefined;

      return listConversations(tenantId, {
        limit: query.limit ? Number(query.limit) : undefined,
        status,
        // `assignedUserId=none` => sem responsável; ausente => todas.
        assignedUserId:
          query.assignedUserId === "none"
            ? null
            : query.assignedUserId
              ? query.assignedUserId
              : undefined,
        search: query.search,
      });
    },
  );

  app.post(
    "/conversations/read-all",
    { preHandler: requirePermission("messages:send") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const body = (request.body ?? {}) as { assignedUserId?: string };
      return markAllRead(tenantId, body.assignedUserId);
    },
  );

  app.get(
    "/conversations/:id",
    { preHandler: requirePermission("messages:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return getConversationDetail(tenantId, id);
    },
  );

  app.get(
    "/conversations/:id/messages",
    { preHandler: requirePermission("messages:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      const { limit, cursor } = request.query as { limit?: string; cursor?: string };
      // Reaproveita a listagem de mensagens (escopada por tenant) já existente.
      return listMessages(tenantId, {
        conversationId: id,
        limit: limit ? Number(limit) : undefined,
        cursor,
      });
    },
  );

  app.post(
    "/conversations/:id/assign",
    { preHandler: requirePermission("messages:send") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      const parsed = assignConversationSchema.parse(request.body);
      return assignConversation(tenantId, id, parsed);
    },
  );

  app.post(
    "/conversations/:id/transfer",
    { preHandler: requirePermission("messages:send") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      const parsed = transferConversationSchema.parse(request.body);
      return transferConversation(tenantId, id, parsed);
    },
  );

  app.post(
    "/conversations/:id/close",
    { preHandler: requirePermission("messages:send") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return closeConversation(tenantId, id);
    },
  );

  app.post(
    "/conversations/:id/reopen",
    { preHandler: requirePermission("messages:send") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return reopenConversation(tenantId, id);
    },
  );

  app.post(
    "/conversations/:id/read",
    { preHandler: requirePermission("messages:send") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return markConversationRead(tenantId, id);
    },
  );
}
