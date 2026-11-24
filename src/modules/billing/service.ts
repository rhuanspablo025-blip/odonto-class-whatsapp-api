import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../database/client.js";
import {
  whatsappAccounts,
  whatsappBudgets,
  whatsappMessageCosts,
  whatsappPricingRates,
} from "../../database/schema/index.js";
import { errors } from "../../lib/errors.js";
import { newId, nowMs } from "../../lib/ids.js";

/**
 * Módulo financeiro — modelo OPÇÃO A.
 *
 * Cada clínica paga DIRETAMENTE à Meta pelo consumo de mensagens quando essa
 * modalidade está habilitada para a conta. Esta API NÃO revende créditos nem
 * intermedeia cobrança: apenas:
 *  - valida que a clínica possui faturamento direto configurado;
 *  - registra o custo estimado por mensagem (livro-razão);
 *  - monitora o gasto e aplica orçamentos (monitoramento / bloqueio de campanhas).
 *
 * Valores monetários são armazenados em micro-unidades (1 BRL = 1_000_000 micro)
 * para evitar erros de ponto flutuante.
 */

export const MICROS_PER_UNIT = 1_000_000;

export type MessageCostCategory =
  | "MARKETING"
  | "UTILITY"
  | "AUTHENTICATION"
  | "SERVICE"
  | "UNKNOWN";

// ───────────────────────────────────────────────────────────────────────────
// Schemas de validação
// ───────────────────────────────────────────────────────────────────────────

export const upsertBudgetSchema = z.object({
  periodMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use o formato YYYY-MM."),
  limitAmountMicros: z.number().int().nonnegative(),
  alertThresholdPercent: z.number().int().min(0).max(100).default(80),
  enforceMode: z.enum(["MONITOR", "BLOCK_MARKETING"]).default("MONITOR"),
  currency: z.string().length(3).default("BRL"),
});

export const createPricingRateSchema = z.object({
  category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION", "SERVICE"]),
  currency: z.string().length(3).default("BRL"),
  amountMicros: z.number().int().nonnegative(),
  effectiveFrom: z.number().int().nonnegative().optional(),
  effectiveTo: z.number().int().nonnegative().nullable().optional(),
});

export const verifyBillingSchema = z.object({
  businessId: z.string().min(1).optional(),
  currency: z.string().length(3).default("BRL"),
  // Declaração explícita de que a clínica configurou o pagamento direto na Meta.
  directBillingConfirmed: z.boolean(),
  notes: z.string().max(1000).optional(),
});

// ───────────────────────────────────────────────────────────────────────────
// Funções puras (testáveis sem banco)
// ───────────────────────────────────────────────────────────────────────────

/** Converte um timestamp em período `YYYY-MM` (UTC). */
export function periodMonthFromTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}`;
}

/** Limites [início, fim) do mês em UTC para consultas de custo. */
export function monthRangeUtc(periodMonth: string): { start: number; end: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(periodMonth);
  if (!match) throw errors.validation("Período inválido. Use o formato YYYY-MM.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw errors.validation("Mês inválido no período informado.");
  return { start: Date.UTC(year, month - 1, 1), end: Date.UTC(year, month, 1) };
}

export interface PricingRateLike {
  tenantId: string | null;
  amountMicros: number;
  effectiveFrom: number;
  effectiveTo: number | null;
}

/**
 * Seleciona o tarifário aplicável em um instante.
 * Prioriza a vigência mais recente e, em empate, o tarifário específico da clínica.
 */
export function pickApplicableRate<T extends PricingRateLike>(
  rates: T[],
  at: number,
): T | null {
  const applicable = rates.filter(
    (rate) => rate.effectiveFrom <= at && (rate.effectiveTo == null || rate.effectiveTo > at),
  );
  if (applicable.length === 0) return null;

  applicable.sort((a, b) => {
    if (b.effectiveFrom !== a.effectiveFrom) return b.effectiveFrom - a.effectiveFrom;
    const aSpecific = a.tenantId ? 1 : 0;
    const bSpecific = b.tenantId ? 1 : 0;
    return bSpecific - aSpecific;
  });
  return applicable[0] ?? null;
}

/**
 * Deriva a categoria de cobrança a partir do tipo da mensagem.
 * Mensagens de template usam a categoria do template; as demais entram como
 * atendimento (SERVICE).
 */
export function deliveryCategoryForMessage(
  messageType: string | null | undefined,
  templateCategory?: string | null,
): MessageCostCategory {
  if (messageType === "TEMPLATE") {
    if (
      templateCategory === "MARKETING" ||
      templateCategory === "UTILITY" ||
      templateCategory === "AUTHENTICATION"
    ) {
      return templateCategory;
    }
    return "UNKNOWN";
  }
  return "SERVICE";
}

export interface CostEstimate {
  messageCount: number;
  amountMicrosPerMessage: number;
  totalMicros: number;
  rateSource: "RATE_CARD" | "UNKNOWN";
}

/** Estimativa de custo para um volume de mensagens. */
export function estimateMessagesCost(
  messageCount: number,
  amountMicrosPerMessage: number | null,
): CostEstimate {
  const perMessage = amountMicrosPerMessage ?? 0;
  const safeCount = Math.max(0, Math.floor(messageCount));
  return {
    messageCount: safeCount,
    amountMicrosPerMessage: perMessage,
    totalMicros: safeCount * perMessage,
    rateSource: amountMicrosPerMessage == null ? "UNKNOWN" : "RATE_CARD",
  };
}

export interface BudgetStatus {
  currency: string;
  limitMicros: number;
  spentMicros: number;
  remainingMicros: number;
  percentUsed: number;
  thresholdPercent: number;
  thresholdReached: boolean;
  exceeded: boolean;
  enforceMode: "MONITOR" | "BLOCK_MARKETING";
}

/** Calcula o estado do orçamento a partir do limite e do gasto acumulado. */
export function computeBudgetStatus(input: {
  currency: string;
  limitMicros: number;
  spentMicros: number;
  alertThresholdPercent: number;
  enforceMode: "MONITOR" | "BLOCK_MARKETING";
}): BudgetStatus {
  const { currency, limitMicros, spentMicros, alertThresholdPercent, enforceMode } = input;
  const remainingMicros = Math.max(0, limitMicros - spentMicros);
  const rawPercent = limitMicros > 0 ? (spentMicros / limitMicros) * 100 : spentMicros > 0 ? 100 : 0;
  const percentUsed = Math.round(Math.min(rawPercent, 100) * 100) / 100;

  return {
    currency,
    limitMicros,
    spentMicros,
    remainingMicros,
    percentUsed,
    thresholdPercent: alertThresholdPercent,
    thresholdReached: rawPercent >= alertThresholdPercent,
    exceeded: spentMicros > limitMicros,
    enforceMode,
  };
}

/** Indica se novas campanhas de marketing devem ser bloqueadas pelo orçamento. */
export function shouldBlockMarketing(input: {
  enforceMode: string;
  spentMicros: number;
  limitMicros: number;
}): boolean {
  return input.enforceMode === "BLOCK_MARKETING" && input.spentMicros >= input.limitMicros;
}

// ───────────────────────────────────────────────────────────────────────────
// Tarifário
// ───────────────────────────────────────────────────────────────────────────

/** Lista o tarifário aplicável à clínica (específico + padrão da plataforma). */
export async function listPricingRates(tenantId: string) {
  const db = getDb();
  return db
    .select()
    .from(whatsappPricingRates)
    .where(
      or(
        eq(whatsappPricingRates.tenantId, tenantId),
        isNull(whatsappPricingRates.tenantId),
      ),
    )
    .orderBy(desc(whatsappPricingRates.effectiveFrom));
}

/** Cria um tarifário específico da clínica. */
export async function createPricingRate(
  tenantId: string,
  input: z.infer<typeof createPricingRateSchema>,
) {
  const db = getDb();
  const id = newId();
  await db.insert(whatsappPricingRates).values({
    id,
    tenantId,
    category: input.category,
    currency: input.currency,
    amountMicros: input.amountMicros,
    effectiveFrom: input.effectiveFrom ?? nowMs(),
    effectiveTo: input.effectiveTo ?? null,
  });
  return { id, ...input, tenantId };
}

/** Resolve o valor por mensagem aplicável (clínica → padrão). */
export async function resolveRateMicros(
  tenantId: string,
  category: MessageCostCategory,
  currency: string,
  at: number,
): Promise<number | null> {
  if (category === "UNKNOWN") return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(whatsappPricingRates)
    .where(
      and(
        or(
          eq(whatsappPricingRates.tenantId, tenantId),
          isNull(whatsappPricingRates.tenantId),
        ),
        eq(whatsappPricingRates.category, category),
        eq(whatsappPricingRates.currency, currency),
      ),
    );

  const rate = pickApplicableRate(rows, at);
  return rate ? rate.amountMicros : null;
}

// ───────────────────────────────────────────────────────────────────────────
// Livro-razão de custos
// ───────────────────────────────────────────────────────────────────────────

export interface RecordMessageCostInput {
  tenantId: string;
  whatsappAccountId?: string | null;
  messageId?: string | null;
  providerMessageId: string;
  category: MessageCostCategory;
  pricingModel?: string | null;
  occurredAt: number;
  currency?: string;
}

/**
 * Registra o custo estimado de uma mensagem.
 * A deduplicação é garantida pela chave (tenant_id, provider_message_id).
 * Nunca lança: o registro de custo é acessório ao fluxo de entrega.
 */
export async function recordMessageCost(input: RecordMessageCostInput): Promise<void> {
  try {
    const db = getDb();
    const currency = input.currency ?? "BRL";
    const rateMicros = await resolveRateMicros(
      input.tenantId,
      input.category,
      currency,
      input.occurredAt,
    );
    const amountMicros = rateMicros ?? 0;

    await db
      .insert(whatsappMessageCosts)
      .values({
        id: newId(),
        tenantId: input.tenantId,
        whatsappAccountId: input.whatsappAccountId ?? null,
        messageId: input.messageId ?? null,
        providerMessageId: input.providerMessageId,
        category: input.category,
        pricingModel: input.pricingModel ?? null,
        billable: amountMicros > 0,
        currency,
        amountMicros,
        rateSource: rateMicros == null ? "UNKNOWN" : "RATE_CARD",
        occurredAt: input.occurredAt,
      })
      .onConflictDoNothing();
  } catch {
    // Custo é informação acessória; falha aqui não deve interromper a entrega.
  }
}

async function sumSpentMicros(tenantId: string, periodMonth: string): Promise<number> {
  const db = getDb();
  const { start, end } = monthRangeUtc(periodMonth);
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${whatsappMessageCosts.amountMicros}), 0)` })
    .from(whatsappMessageCosts)
    .where(
      and(
        eq(whatsappMessageCosts.tenantId, tenantId),
        gte(whatsappMessageCosts.occurredAt, start),
        lt(whatsappMessageCosts.occurredAt, end),
      ),
    );
  return Number(row?.total ?? 0);
}

export interface SpendingSummary {
  periodMonth: string;
  currency: string;
  totalMicros: number;
  totalMessages: number;
  billableMessages: number;
  byCategory: Array<{ category: MessageCostCategory; amountMicros: number; messages: number }>;
}

/** Resumo de gastos do período (monitoramento financeiro). */
export async function getSpendingSummary(
  tenantId: string,
  periodMonth: string,
): Promise<SpendingSummary> {
  const db = getDb();
  const { start, end } = monthRangeUtc(periodMonth);
  const rows = await db
    .select({
      category: whatsappMessageCosts.category,
      amountMicros: sql<number>`coalesce(sum(${whatsappMessageCosts.amountMicros}), 0)`,
      messages: sql<number>`count(*)`,
      billable: sql<number>`coalesce(sum(case when ${whatsappMessageCosts.billable} then 1 else 0 end), 0)`,
    })
    .from(whatsappMessageCosts)
    .where(
      and(
        eq(whatsappMessageCosts.tenantId, tenantId),
        gte(whatsappMessageCosts.occurredAt, start),
        lt(whatsappMessageCosts.occurredAt, end),
      ),
    )
    .groupBy(whatsappMessageCosts.category);

  let totalMicros = 0;
  let totalMessages = 0;
  let billableMessages = 0;
  const byCategory = rows.map((row) => {
    const amountMicros = Number(row.amountMicros ?? 0);
    const messages = Number(row.messages ?? 0);
    totalMicros += amountMicros;
    totalMessages += messages;
    billableMessages += Number(row.billable ?? 0);
    return { category: row.category as MessageCostCategory, amountMicros, messages };
  });

  return { periodMonth, currency: "BRL", totalMicros, totalMessages, billableMessages, byCategory };
}

/** Lista os lançamentos de custo do período (mais recentes primeiro). */
export async function listMessageCosts(
  tenantId: string,
  periodMonth: string,
  limit = 100,
) {
  const db = getDb();
  const { start, end } = monthRangeUtc(periodMonth);
  return db
    .select()
    .from(whatsappMessageCosts)
    .where(
      and(
        eq(whatsappMessageCosts.tenantId, tenantId),
        gte(whatsappMessageCosts.occurredAt, start),
        lt(whatsappMessageCosts.occurredAt, end),
      ),
    )
    .orderBy(desc(whatsappMessageCosts.occurredAt))
    .limit(Math.min(limit, 500));
}

// ───────────────────────────────────────────────────────────────────────────
// Orçamentos
// ───────────────────────────────────────────────────────────────────────────

/** Cria/atualiza o orçamento mensal da clínica. */
export async function upsertBudget(
  tenantId: string,
  input: z.infer<typeof upsertBudgetSchema>,
) {
  const db = getDb();
  const now = nowMs();
  const [existing] = await db
    .select({ id: whatsappBudgets.id })
    .from(whatsappBudgets)
    .where(
      and(
        eq(whatsappBudgets.tenantId, tenantId),
        eq(whatsappBudgets.periodMonth, input.periodMonth),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(whatsappBudgets)
      .set({
        limitAmountMicros: input.limitAmountMicros,
        alertThresholdPercent: input.alertThresholdPercent,
        enforceMode: input.enforceMode,
        currency: input.currency,
        updatedAt: now,
      })
      .where(and(eq(whatsappBudgets.tenantId, tenantId), eq(whatsappBudgets.id, existing.id)));
    return { id: existing.id, ...input };
  }

  const id = newId();
  await db.insert(whatsappBudgets).values({
    id,
    tenantId,
    periodMonth: input.periodMonth,
    currency: input.currency,
    limitAmountMicros: input.limitAmountMicros,
    alertThresholdPercent: input.alertThresholdPercent,
    enforceMode: input.enforceMode,
  });
  return { id, ...input };
}

export async function listBudgets(tenantId: string) {
  const db = getDb();
  return db
    .select()
    .from(whatsappBudgets)
    .where(eq(whatsappBudgets.tenantId, tenantId))
    .orderBy(desc(whatsappBudgets.periodMonth));
}

/** Visão consolidada de orçamento + gasto do período. */
export async function getBudgetOverview(tenantId: string, periodMonth: string) {
  const db = getDb();
  const [budget] = await db
    .select()
    .from(whatsappBudgets)
    .where(
      and(
        eq(whatsappBudgets.tenantId, tenantId),
        eq(whatsappBudgets.periodMonth, periodMonth),
      ),
    )
    .limit(1);

  const spentMicros = await sumSpentMicros(tenantId, periodMonth);

  if (!budget) {
    return {
      periodMonth,
      budget: null,
      spentMicros,
      currency: "BRL",
    };
  }

  const status = computeBudgetStatus({
    currency: budget.currency,
    limitMicros: budget.limitAmountMicros,
    spentMicros,
    alertThresholdPercent: budget.alertThresholdPercent,
    enforceMode: budget.enforceMode,
  });

  return {
    periodMonth,
    budget: {
      id: budget.id,
      limitAmountMicros: budget.limitAmountMicros,
      alertThresholdPercent: budget.alertThresholdPercent,
      enforceMode: budget.enforceMode,
    },
    spentMicros,
    currency: budget.currency,
    status,
  };
}

/**
 * Guarda de orçamento para o motor de mensagens.
 * Lança se o orçamento bloquear novas campanhas de marketing.
 */
export async function assertBudgetAllowsMarketing(
  tenantId: string,
  at: number = nowMs(),
): Promise<void> {
  const db = getDb();
  const periodMonth = periodMonthFromTimestamp(at);
  const [budget] = await db
    .select()
    .from(whatsappBudgets)
    .where(
      and(
        eq(whatsappBudgets.tenantId, tenantId),
        eq(whatsappBudgets.periodMonth, periodMonth),
      ),
    )
    .limit(1);

  if (!budget || budget.enforceMode !== "BLOCK_MARKETING") return;

  const spentMicros = await sumSpentMicros(tenantId, periodMonth);
  if (
    shouldBlockMarketing({
      enforceMode: budget.enforceMode,
      spentMicros,
      limitMicros: budget.limitAmountMicros,
    })
  ) {
    throw errors.validation(
      "Orçamento mensal de mensagens atingido. Novas campanhas de marketing estão bloqueadas.",
    );
  }
}

/** Estimativa de custo de uma campanha a partir do tarifário vigente. */
export async function estimateCampaignCost(
  tenantId: string,
  input: { messageCount: number; category: MessageCostCategory; currency?: string },
): Promise<CostEstimate> {
  const currency = input.currency ?? "BRL";
  const rateMicros = await resolveRateMicros(tenantId, input.category, currency, nowMs());
  return estimateMessagesCost(input.messageCount, rateMicros);
}

// ───────────────────────────────────────────────────────────────────────────
// Validação do faturamento direto da clínica
// ───────────────────────────────────────────────────────────────────────────

/**
 * Registra a validação do faturamento direto da clínica (OPÇÃO A).
 * A confirmação é atestada pela clínica e registrada como metadado auditável —
 * a API não processa pagamentos nem revende créditos.
 */
export async function verifyDirectBilling(
  tenantId: string,
  connectionId: string,
  input: z.infer<typeof verifyBillingSchema>,
) {
  const db = getDb();
  const [account] = await db
    .select()
    .from(whatsappAccounts)
    .where(
      and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, connectionId)),
    )
    .limit(1);

  if (!account) throw errors.notFound("Conexão WhatsApp");

  const now = nowMs();
  const verified = input.directBillingConfirmed;
  const metadata = {
    ...(typeof account.connectionMetadata === "object" && account.connectionMetadata
      ? (account.connectionMetadata as Record<string, unknown>)
      : {}),
    billing: {
      currency: input.currency,
      businessId: input.businessId ?? account.businessId ?? null,
      confirmed: verified,
      notes: input.notes ?? null,
      checkedAt: now,
    },
  };

  await db
    .update(whatsappAccounts)
    .set({
      billingMode: verified ? "DIRECT" : "UNVERIFIED",
      billingStatus: verified ? "VERIFIED" : "REJECTED",
      billingVerifiedAt: verified ? now : null,
      businessId: input.businessId ?? account.businessId ?? null,
      connectionMetadata: metadata,
      updatedAt: now,
    })
    .where(and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, connectionId)));

  return {
    connectionId,
    billingMode: verified ? ("DIRECT" as const) : ("UNVERIFIED" as const),
    billingStatus: verified ? ("VERIFIED" as const) : ("REJECTED" as const),
    billingVerifiedAt: verified ? now : null,
    currency: input.currency,
    businessId: input.businessId ?? account.businessId ?? null,
  };
}
