import type { FastifyInstance } from "fastify";

import { authenticate, getAuth, requirePermission } from "../auth/auth.js";
import {
  checkConnectionHealth,
  connectAccount,
  connectAccountSchema,
  disconnectAccount,
  getConnection,
  listConnections,
  reconnectAccount,
  revokeAccount,
  rotateCredentials,
  rotateCredentialsSchema,
} from "./service.js";

/**
 * Rotas do WhatsApp Connection Manager.
 * Todas protegidas por autenticação e escopo por tenant.
 */
export async function connectionsRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  app.get(
    "/whatsapp/connections",
    { preHandler: requirePermission("whatsapp:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      return listConnections(tenantId);
    },
  );

  app.post(
    "/whatsapp/connections",
    { preHandler: requirePermission("whatsapp:manage") },
    async (request, reply) => {
      const { tenantId } = getAuth(request);
      const parsed = connectAccountSchema.parse(request.body);
      const connection = await connectAccount(tenantId, parsed);
      return reply.status(201).send(connection);
    },
  );

  app.get(
    "/whatsapp/connections/:id",
    { preHandler: requirePermission("whatsapp:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return getConnection(tenantId, id);
    },
  );

  app.post(
    "/whatsapp/connections/:id/disconnect",
    { preHandler: requirePermission("whatsapp:manage") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return disconnectAccount(tenantId, id);
    },
  );

  app.post(
    "/whatsapp/connections/:id/reconnect",
    { preHandler: requirePermission("whatsapp:manage") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return reconnectAccount(tenantId, id);
    },
  );

  app.post(
    "/whatsapp/connections/:id/revoke",
    { preHandler: requirePermission("whatsapp:manage") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return revokeAccount(tenantId, id);
    },
  );

  app.post(
    "/whatsapp/connections/:id/credentials",
    { preHandler: requirePermission("whatsapp:manage") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      const parsed = rotateCredentialsSchema.parse(request.body);
      return rotateCredentials(tenantId, id, parsed);
    },
  );

  app.get(
    "/whatsapp/connections/:id/health",
    { preHandler: requirePermission("whatsapp:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return checkConnectionHealth(tenantId, id);
    },
  );
}
