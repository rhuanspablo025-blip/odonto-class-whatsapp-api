import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authenticate, getAuth, requirePermission } from "../auth/auth.js";
import { nowMs } from "../../lib/ids.js";
import {
  createPricingRate,
  createPricingRateSchema,
  estimateCampaignCost,
  getBudgetOverview,
  getSpendingSummary,
  listBudgets,
  listMessageCosts,
  listPricingRates,
  periodMonthFromTimestamp,
  upsertBudget,
  upsertBudgetSchema,
  verifyBillingSchema,
  verifyDirectBilling,
} from "./service.js";

const periodQuerySchema = z.object({
  periodMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});

/**
 * Rotas financeiras (modelo OPÇÃO A).
 * A clínica paga diretamente à Meta; aqui apenas validamos a configuração,
 * monitoramos custos e aplicamos orçamentos. Não há revenda de créditos.
 */
export async function billingRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  // ── Tarifário ───────────────────────────────────────────────────────────
  app.get(
    "/billing/rates",
    { preHandler: requirePermission("billing:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      return listPricingRates(tenantId);
    },
  );

  app.post(
    "/billing/rates",
    { preHandler: requirePermission("billing:manage") },
    async (request, reply) => {
      const { tenantId } = getAuth(request);
      const parsed = createPricingRateSchema.parse(request.body);
      const rate = await createPricingRate(tenantId, parsed);
      return reply.status(201).send(rate);
    },
  );

  // ── Orçamentos ──────────────────────────────────────────────────────────
  app.get(
    "/billing/budgets",
    { preHandler: requirePermission("billing:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      return listBudgets(tenantId);
    },
  );

  app.post(
    "/billing/budgets",
    { preHandler: requirePermission("billing:manage") },
    async (request, reply) => {
      const { tenantId } = getAuth(request);
      const parsed = upsertBudgetSchema.parse(request.body);
      const budget = await upsertBudget(tenantId, parsed);
      return reply.status(201).send(budget);
    },
  );

  // ── Monitoramento financeiro ────────────────────────────────────────────
  app.get(
    "/billing/budget-overview",
    { preHandler: requirePermission("billing:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { periodMonth } = periodQuerySchema.parse(request.query);
      return getBudgetOverview(tenantId, periodMonth ?? periodMonthFromTimestamp(nowMs()));
    },
  );

  app.get(
    "/billing/spending",
    { preHandler: requirePermission("billing:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { periodMonth } = periodQuerySchema.parse(request.query);
      return getSpendingSummary(tenantId, periodMonth ?? periodMonthFromTimestamp(nowMs()));
    },
  );

  app.get(
    "/billing/costs",
    { preHandler: requirePermission("billing:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const query = periodQuerySchema
        .extend({ limit: z.coerce.number().int().positive().max(500).optional() })
        .parse(request.query);
      return listMessageCosts(
        tenantId,
        query.periodMonth ?? periodMonthFromTimestamp(nowMs()),
        query.limit ?? 100,
      );
    },
  );

  // ── Estimativas ─────────────────────────────────────────────────────────
  app.post(
    "/billing/estimate",
    { preHandler: requirePermission("billing:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const parsed = z
        .object({
          messageCount: z.number().int().nonnegative(),
          category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION", "SERVICE", "UNKNOWN"]),
          currency: z.string().length(3).default("BRL"),
        })
        .parse(request.body);
      return estimateCampaignCost(tenantId, parsed);
    },
  );

  // ── Validação do faturamento direto da clínica ──────────────────────────
  app.post(
    "/whatsapp/connections/:id/billing/verify",
    { preHandler: requirePermission("billing:manage") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { id } = request.params as { id: string };
      const parsed = verifyBillingSchema.parse(request.body);
      return verifyDirectBilling(tenantId, id, parsed);
    },
  );
}
