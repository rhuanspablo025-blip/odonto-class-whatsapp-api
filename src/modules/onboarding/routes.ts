import type { FastifyInstance } from "fastify";

import { authenticate, getAuth, requirePermission } from "../auth/auth.js";
import {
  completeOnboarding,
  completeOnboardingSchema,
  getOnboardingSession,
  listOnboardingSessions,
  startOnboarding,
  startOnboardingSchema,
} from "./service.js";

/**
 * Rotas do Meta Embedded Signup / coexistência.
 * Todas autenticadas e isoladas por tenant.
 */
export async function onboardingRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  app.post(
    "/whatsapp/onboarding/sessions",
    { preHandler: requirePermission("whatsapp:manage") },
    async (request, reply) => {
      const { tenantId } = getAuth(request);
      const parsed = startOnboardingSchema.parse(request.body ?? {});
      const session = await startOnboarding(tenantId, parsed);
      return reply.status(201).send(session);
    },
  );

  app.get(
    "/whatsapp/onboarding/sessions",
    { preHandler: requirePermission("whatsapp:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      return listOnboardingSessions(tenantId);
    },
  );

  app.post(
    "/whatsapp/onboarding/sessions/complete",
    { preHandler: requirePermission("whatsapp:manage") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const parsed = completeOnboardingSchema.parse(request.body);
      return completeOnboarding(tenantId, parsed);
    },
  );

  app.get(
    "/whatsapp/onboarding/sessions/:id",
    { preHandler: requirePermission("whatsapp:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      return getOnboardingSession(tenantId, id);
    },
  );
}
