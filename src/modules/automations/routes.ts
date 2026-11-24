import type { FastifyInstance } from "fastify";

import { authenticate, getAuth, requirePermission } from "../auth/auth.js";
import {
  createAutomation,
  createAutomationSchema,
  listAutomations,
  toggleAutomation,
} from "./service.js";

export async function automationsRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  app.get(
    "/automations",
    { preHandler: requirePermission("automations:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      return listAutomations(tenantId);
    },
  );

  app.post(
    "/automations",
    { preHandler: requirePermission("automations:write") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const parsed = createAutomationSchema.parse(request.body);
      return createAutomation(tenantId, parsed);
    },
  );

  app.post(
    "/automations/:id/toggle",
    { preHandler: requirePermission("automations:write") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      const { enabled } = request.body as { enabled: boolean };
      return toggleAutomation(tenantId, id, enabled);
    },
  );
}
