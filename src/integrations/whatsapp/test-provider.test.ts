import { describe, it, expect, beforeEach } from "vitest";

import { TestWhatsAppProvider } from "./test-provider.js";

describe("TestWhatsAppProvider", () => {
  let provider: TestWhatsAppProvider;

  beforeEach(() => {
    provider = new TestWhatsAppProvider();
  });

  it("é identificado como provider de teste", () => {
    expect(provider.isTestProvider).toBe(true);
  });

  it("sendText retorna providerMessageId", async () => {
    const result = await provider.sendText({ to: "+5511999990001", text: "Olá" });
    expect(result.providerMessageId).toMatch(/^wamid\.test\./);
    expect(result.phoneNumberId).toBe("test-phone-id");
  });

  it("sendTemplate funciona sem chamadas externas", async () => {
    const result = await provider.sendTemplate({
      to: "+5511999990001",
      templateName: "welcome",
      language: "pt_BR",
    });
    expect(result.providerMessageId).toMatch(/^wamid\.test\./);
  });

  it("getTemplateStatus sempre retorna APPROVED", async () => {
    const status = await provider.getTemplateStatus("qualquer", "pt_BR");
    expect(status).toBe("APPROVED");
  });

  it("getProviderHealth retorna ok", async () => {
    const health = await provider.getProviderHealth();
    expect(health.status).toBe("ok");
  });
});
