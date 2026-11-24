import type { FastifyInstance } from "fastify";

import { authenticate, getAuth, requirePermission } from "../auth/auth.js";
import { createTemplate, createTemplateSchema, listTemplates, syncTemplates } from "./service.js";

export async function templatesRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  app.get(
    "/templates",
    { preHandler: requirePermission("messages:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      return listTemplates(tenantId);
    },
  );

  app.post(
    "/templates/sync",
    { preHandler: requirePermission("messages:write") },
    async (request) => {
      const { tenantId } = getAuth(request);
      return syncTemplates(tenantId);
    },
  );

  app.post(
    "/templates",
    { preHandler: requirePermission("messages:write") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const parsed = createTemplateSchema.parse(request.body);
      return createTemplate(tenantId, parsed);
    },
  );
}
