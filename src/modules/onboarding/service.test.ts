import { describe, expect, it } from "vitest";

import type { PhoneNumberSummary } from "./client.js";
import {
  completeOnboardingSchema,
  isSessionExpired,
  selectPhoneNumber,
  startOnboardingSchema,
} from "./service.js";
import { TestEmbeddedSignupClient } from "./test-embedded-signup-client.js";

const numbers: PhoneNumberSummary[] = [
  { phoneNumberId: "phone-a", displayPhoneNumber: "+5511900000001" },
  { phoneNumberId: "phone-b", displayPhoneNumber: "+5511900000002" },
];

describe("seleção do número no onboarding", () => {
  it("usa o número informado no callback", () => {
    expect(selectPhoneNumber(numbers, "phone-b")?.phoneNumberId).toBe("phone-b");
  });

  it("usa o primeiro número quando não informado", () => {
    expect(selectPhoneNumber(numbers)?.phoneNumberId).toBe("phone-a");
  });

  it("retorna null sem números ou com número inexistente", () => {
    expect(selectPhoneNumber([], undefined)).toBeNull();
    expect(selectPhoneNumber(numbers, "phone-x")).toBeNull();
  });
});

describe("expiração da sessão", () => {
  it("considera expirada a sessão cujo TTL passou", () => {
    expect(isSessionExpired({ expiresAt: 1000 }, 1000)).toBe(true);
    expect(isSessionExpired({ expiresAt: 1001 }, 1000)).toBe(false);
  });
});

describe("validação de entrada do onboarding", () => {
  it("usa Embedded Signup como modo padrão", () => {
    expect(startOnboardingSchema.parse({}).mode).toBe("EMBEDDED_SIGNUP");
  });

  it("exige state, code e wabaId na conclusão", () => {
    expect(
      completeOnboardingSchema.safeParse({ state: "s".repeat(24), code: "c", wabaId: "w" }).success,
    ).toBe(true);
    expect(completeOnboardingSchema.safeParse({ code: "c", wabaId: "w" }).success).toBe(false);
    expect(
      completeOnboardingSchema.safeParse({ state: "s".repeat(24), wabaId: "w" }).success,
    ).toBe(false);
  });
});

describe("cliente de Embedded Signup de teste", () => {
  const client = new TestEmbeddedSignupClient();

  it("troca o code por um token determinístico sem chamar a Meta", async () => {
    const token = await client.exchangeCodeForToken({
      code: "valid-code",
      appId: "app",
      appSecret: "secret",
    });
    expect(token.accessToken).toMatch(/^test-es-token-/);
  });

  it("recusa code inválido", async () => {
    await expect(
      client.exchangeCodeForToken({ code: "invalid-code", appId: "app", appSecret: "secret" }),
    ).rejects.toThrowError();
  });

  it("retorna WABA, número e coexistência de forma determinística", async () => {
    const waba = await client.fetchWaba({ accessToken: "t", wabaId: "waba-1" });
    expect(waba.wabaId).toBe("waba-1");

    const phones = await client.fetchPhoneNumbers({ accessToken: "t", wabaId: "waba-1" });
    expect(phones[0]?.phoneNumberId).toBe("phone-waba-1");

    const features = await client.fetchCoexistenceFeatures({
      accessToken: "t",
      phoneNumberId: "phone-waba-1",
    });
    expect(features.isCoexistenceEnabled).toBe(true);
  });
});
