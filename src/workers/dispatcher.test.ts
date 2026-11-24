import { describe, expect, it } from "vitest";

import { isCampaignDispatchable } from "./dispatcher.js";

describe("campaign job dispatch", () => {
  it("permite jobs sem campanha ou em campanha agendada/em execução", () => {
    expect(isCampaignDispatchable(null)).toBe(true);
    expect(isCampaignDispatchable("SCHEDULED")).toBe(true);
    expect(isCampaignDispatchable("RUNNING")).toBe(true);
  });

  it("bloqueia jobs de campanhas pausadas, canceladas ou em rascunho", () => {
    expect(isCampaignDispatchable("PAUSED")).toBe(false);
    expect(isCampaignDispatchable("CANCELLED")).toBe(false);
    expect(isCampaignDispatchable("DRAFT")).toBe(false);
  });
});
