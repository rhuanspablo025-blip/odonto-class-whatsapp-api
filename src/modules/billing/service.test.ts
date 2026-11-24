import { describe, expect, it } from "vitest";

import {
  computeBudgetStatus,
  createPricingRateSchema,
  deliveryCategoryForMessage,
  estimateMessagesCost,
  monthRangeUtc,
  periodMonthFromTimestamp,
  pickApplicableRate,
  shouldBlockMarketing,
  upsertBudgetSchema,
  verifyBillingSchema,
} from "./service.js";

describe("período de faturamento", () => {
  it("deriva YYYY-MM em UTC", () => {
    expect(periodMonthFromTimestamp(Date.UTC(2026, 10, 22, 13, 0, 0))).toBe("2026-11");
    expect(periodMonthFromTimestamp(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("2026-01");
  });

  it("calcula os limites [início, fim) do mês em UTC", () => {
    const { start, end } = monthRangeUtc("2026-02");
    expect(start).toBe(Date.UTC(2026, 1, 1));
    expect(end).toBe(Date.UTC(2026, 2, 1));
  });

  it("recusa períodos inválidos", () => {
    expect(() => monthRangeUtc("2026-13")).toThrowError();
    expect(() => monthRangeUtc("26-01")).toThrowError();
  });
});

describe("seleção de tarifário", () => {
  const rates = [
    { tenantId: null, amountMicros: 500_000, effectiveFrom: 1000, effectiveTo: null },
    { tenantId: "t1", amountMicros: 400_000, effectiveFrom: 2000, effectiveTo: null },
  ];

  it("prioriza a vigência mais recente", () => {
    expect(pickApplicableRate(rates, 2500)?.amountMicros).toBe(400_000);
  });

  it("usa o tarifário padrão quando não há específico vigente", () => {
    expect(pickApplicableRate(rates, 1500)?.amountMicros).toBe(500_000);
  });

  it("prefere o específico da clínica em empate de vigência", () => {
    const same = [
      { tenantId: null, amountMicros: 500_000, effectiveFrom: 3000, effectiveTo: null },
      { tenantId: "t1", amountMicros: 450_000, effectiveFrom: 3000, effectiveTo: null },
    ];
    expect(pickApplicableRate(same, 3000)?.amountMicros).toBe(450_000);
  });

  it("ignora tarifários fora da vigência e expirados", () => {
    const expired = [{ tenantId: null, amountMicros: 100, effectiveFrom: 0, effectiveTo: 500 }];
    expect(pickApplicableRate(expired, 600)).toBeNull();
    expect(pickApplicableRate([], 1000)).toBeNull();
  });
});

describe("categoria de cobrança por mensagem", () => {
  it("usa a categoria do template quando disponível", () => {
    expect(deliveryCategoryForMessage("TEMPLATE", "MARKETING")).toBe("MARKETING");
    expect(deliveryCategoryForMessage("TEMPLATE", "UTILITY")).toBe("UTILITY");
  });

  it("marca template sem categoria como UNKNOWN", () => {
    expect(deliveryCategoryForMessage("TEMPLATE", null)).toBe("UNKNOWN");
    expect(deliveryCategoryForMessage("TEMPLATE", "DESCONHECIDA")).toBe("UNKNOWN");
  });

  it("classifica mensagens livres como SERVICE", () => {
    expect(deliveryCategoryForMessage("TEXT")).toBe("SERVICE");
    expect(deliveryCategoryForMessage("IMAGE")).toBe("SERVICE");
  });
});

describe("estimativa de custo", () => {
  it("multiplica volume pelo valor unitário", () => {
    expect(estimateMessagesCost(100, 350_000)).toEqual({
      messageCount: 100,
      amountMicrosPerMessage: 350_000,
      totalMicros: 35_000_000,
      rateSource: "RATE_CARD",
    });
  });

  it("marca como UNKNOWN quando não há tarifário", () => {
    const estimate = estimateMessagesCost(10, null);
    expect(estimate.totalMicros).toBe(0);
    expect(estimate.rateSource).toBe("UNKNOWN");
  });

  it("normaliza contagens negativas", () => {
    expect(estimateMessagesCost(-5, 100).messageCount).toBe(0);
  });
});

describe("orçamento", () => {
  it("calcula percentual, restante e limites", () => {
    const status = computeBudgetStatus({
      currency: "BRL",
      limitMicros: 10_000_000,
      spentMicros: 8_500_000,
      alertThresholdPercent: 80,
      enforceMode: "MONITOR",
    });
    expect(status.percentUsed).toBe(85);
    expect(status.remainingMicros).toBe(1_500_000);
    expect(status.thresholdReached).toBe(true);
    expect(status.exceeded).toBe(false);
  });

  it("sinaliza estouro do orçamento", () => {
    const status = computeBudgetStatus({
      currency: "BRL",
      limitMicros: 1_000_000,
      spentMicros: 1_200_000,
      alertThresholdPercent: 80,
      enforceMode: "BLOCK_MARKETING",
    });
    expect(status.exceeded).toBe(true);
    expect(status.remainingMicros).toBe(0);
    expect(status.percentUsed).toBe(100);
  });

  it("bloqueia marketing somente quando configurado e estourado", () => {
    expect(
      shouldBlockMarketing({ enforceMode: "BLOCK_MARKETING", spentMicros: 100, limitMicros: 100 }),
    ).toBe(true);
    expect(
      shouldBlockMarketing({ enforceMode: "MONITOR", spentMicros: 100, limitMicros: 100 }),
    ).toBe(false);
    expect(
      shouldBlockMarketing({ enforceMode: "BLOCK_MARKETING", spentMicros: 99, limitMicros: 100 }),
    ).toBe(false);
  });
});

describe("validação de entrada financeira", () => {
  it("aplica padrões seguros ao orçamento", () => {
    const parsed = upsertBudgetSchema.parse({
      periodMonth: "2026-11",
      limitAmountMicros: 5_000_000,
    });
    expect(parsed.alertThresholdPercent).toBe(80);
    expect(parsed.enforceMode).toBe("MONITOR");
    expect(parsed.currency).toBe("BRL");
  });

  it("recusa período fora do formato YYYY-MM", () => {
    expect(
      upsertBudgetSchema.safeParse({ periodMonth: "2026/11", limitAmountMicros: 1 }).success,
    ).toBe(false);
  });

  it("valida o tarifário por categoria", () => {
    expect(
      createPricingRateSchema.parse({ category: "MARKETING", amountMicros: 100 }).currency,
    ).toBe("BRL");
    expect(
      createPricingRateSchema.safeParse({ category: "OUTRA", amountMicros: 100 }).success,
    ).toBe(false);
  });

  it("exige confirmação explícita do faturamento direto", () => {
    expect(verifyBillingSchema.safeParse({ directBillingConfirmed: true }).success).toBe(true);
    expect(verifyBillingSchema.safeParse({}).success).toBe(false);
  });
});
