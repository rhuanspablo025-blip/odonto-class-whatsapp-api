import type { FastifyInstance } from "fastify";

import { authenticate, getAuth, requirePermission } from "../auth/auth.js";
import {
  consentSchema,
  createContact,
  createContactSchema,
  deleteContact,
  getContact,
  listConsents,
  listContacts,
  updateContact,
  updateContactSchema,
  upsertConsent,
} from "./service.js";

/**
 * Rotas de contatos.
 * Todas protegidas por autenticação + permissão.
 */
export async function contactsRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  // Listar contatos.
  app.get("/contacts", { preHandler: requirePermission("contacts:read") }, async (request) => {
    const { tenantId } = getAuth(request);
    const { limit, cursor } = request.query as { limit?: string; cursor?: string };
    return listContacts(tenantId, {
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  });

  // Criar contato.
  app.post(
    "/contacts",
    { preHandler: requirePermission("contacts:write") },
    async (request, reply) => {
      const { tenantId } = getAuth(request);
      const parsed = createContactSchema.parse(request.body);
      const contact = await createContact(tenantId, parsed);
      return reply.status(201).send(contact);
    },
  );

  // Obter contato.
  app.get(
    "/contacts/:id",
    { preHandler: requirePermission("contacts:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return getContact(tenantId, id);
    },
  );

  // Atualizar contato.
  app.patch(
    "/contacts/:id",
    { preHandler: requirePermission("contacts:write") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      const parsed = updateContactSchema.parse(request.body);
      return updateContact(tenantId, id, parsed);
    },
  );

  // Deletar contato.
  app.delete(
    "/contacts/:id",
    { preHandler: requirePermission("contacts:write") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return deleteContact(tenantId, id);
    },
  );

  // Listar consentimentos.
  app.get(
    "/contacts/:id/consents",
    { preHandler: requirePermission("contacts:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return listConsents(tenantId, id);
    },
  );

  // Criar/atualizar consentimento.
  app.post(
    "/contacts/:id/consents",
    { preHandler: requirePermission("contacts:write") },
    async (request, reply) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      const parsed = consentSchema.parse(request.body);
      const result = await upsertConsent(tenantId, id, parsed);
      return reply.status(201).send(result);
    },
  );
}
