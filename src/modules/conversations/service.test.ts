import { describe, expect, it } from "vitest";

import {
  assignConversationSchema,
  resolveWindowState,
  transferConversationSchema,
} from "./service.js";

describe("janela de atendimento (regras da Meta)", () => {
  it("considera CLOSED quando não há expiração", () => {
    expect(resolveWindowState(null)).toBe("CLOSED");
    expect(resolveWindowState(undefined)).toBe("CLOSED");
  });

  it("considera CLOSED quando a janela já expirou", () => {
    expect(resolveWindowState(Date.now() - 1000)).toBe("CLOSED");
  });

  it("considera EXPIRING quando falta menos de uma hora", () => {
    expect(resolveWindowState(Date.now() + 30 * 60 * 1000)).toBe("EXPIRING");
  });

  it("considera OPEN quando falta mais de uma hora", () => {
    expect(resolveWindowState(Date.now() + 2 * 60 * 60 * 1000)).toBe("OPEN");
  });
});

describe("atribuição de atendimento", () => {
  it("aceita atribuição com guarda de concorrência opcional", () => {
    const parsed = assignConversationSchema.parse({
      userId: "user-1",
      userName: "Helena",
      expectedAssigneeUserId: null,
    });
    expect(parsed.userId).toBe("user-1");
    expect(parsed.expectedAssigneeUserId).toBeNull();
  });

  it("rejeita atribuição sem identificação do atendente", () => {
    expect(() => assignConversationSchema.parse({})).toThrow();
  });

  it("exige destinatário na transferência", () => {
    const parsed = transferConversationSchema.parse({ toUserId: "user-2" });
    expect(parsed.toUserId).toBe("user-2");
    expect(() => transferConversationSchema.parse({ note: "sem destino" })).toThrow();
  });
});
