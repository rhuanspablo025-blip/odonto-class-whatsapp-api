import type { FastifyInstance } from "fastify";

import { authenticate, getAuth, requirePermission } from "../auth/auth.js";
import {
  cancelCampaign,
  createCampaign,
  createCampaignSchema,
  listCampaigns,
  pauseCampaign,
  startCampaign,
} from "./service.js";

export async function campaignsRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  app.get(
    "/campaigns",
    { preHandler: requirePermission("campaigns:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      return listCampaigns(tenantId);
    },
  );

  app.post(
    "/campaigns",
    { preHandler: requirePermission("campaigns:write") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const parsed = createCampaignSchema.parse(request.body);
      return createCampaign(tenantId, parsed);
    },
  );

  app.post(
    "/campaigns/:id/start",
    { preHandler: requirePermission("campaigns:write") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return startCampaign(tenantId, id);
    },
  );

  app.post(
    "/campaigns/:id/pause",
    { preHandler: requirePermission("campaigns:write") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return pauseCampaign(tenantId, id);
    },
  );

  app.post(
    "/campaigns/:id/cancel",
    { preHandler: requirePermission("campaigns:write") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return cancelCampaign(tenantId, id);
    },
  );
}
