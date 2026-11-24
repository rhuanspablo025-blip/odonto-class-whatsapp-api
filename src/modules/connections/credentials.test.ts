import { describe, expect, it } from "vitest";

import { encryptSecret } from "../../config/security.js";
import {
  decodeCredentials,
  encodeCredentials,
  toPublicConnection,
  type WhatsAppAccountRow,
} from "./credentials.js";
import { connectAccountSchema, rotateCredentialsSchema } from "./service.js";

describe("credenciais da conta WhatsApp", () => {
  it("faz round-trip do token criptografado sem expor o valor em claro", () => {
    const encrypted = encodeCredentials({ accessToken: "EAAG-token-secreto" });
    expect(encrypted).not.toContain("EAAG-token-secreto");
    expect(decodeCredentials(encrypted)).toEqual({ accessToken: "EAAG-token-secreto" });
  });

  it("lê o formato legado (apenas o token criptografado)", () => {
    expect(decodeCredentials(encryptSecret("legacy-token"))).toEqual({
      accessToken: "legacy-token",
    });
  });

  it("recusa credencial criptografada sem token", () => {
    const withoutToken = encryptSecret(JSON.stringify({ foo: "bar" }));
    expect(() => decodeCredentials(withoutToken)).toThrowError();
  });
});

describe("projeção pública da conexão", () => {
  const row: WhatsAppAccountRow = {
    id: "conn-1",
    tenantId: "tenant-1",
    phoneNumberId: "phone-1",
    wabaId: "waba-1",
    displayPhoneNumber: "+5511999990000",
    status: "CONNECTED",
    encryptedCredentials: "iv:tag:ciphertext-super-secreto",
    onboardingMode: "EMBEDDED_SIGNUP",
    coexistenceEnabled: false,
    businessId: "biz-1",
    billingMode: "UNVERIFIED",
    billingStatus: "UNKNOWN",
    billingVerifiedAt: null,
    connectionMetadata: null,
    createdAt: 1,
    updatedAt: 2,
  };

  it("nunca expõe as credenciais criptografadas", () => {
    const pub = toPublicConnection(row);
    expect(pub).not.toHaveProperty("encryptedCredentials");
    expect(JSON.stringify(pub)).not.toContain("ciphertext-super-secreto");
  });

  it("preserva os metadados de conexão e cobrança", () => {
    const pub = toPublicConnection(row);
    expect(pub.status).toBe("CONNECTED");
    expect(pub.onboardingMode).toBe("EMBEDDED_SIGNUP");
    expect(pub.coexistenceEnabled).toBe(false);
    expect(pub.billingMode).toBe("UNVERIFIED");
  });
});

describe("validação de entrada do Connection Manager", () => {
  it("aplica valores padrão seguros ao conectar", () => {
    const parsed = connectAccountSchema.parse({
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
      accessToken: "token-1",
    });
    expect(parsed.onboardingMode).toBe("CLOUD_API");
    expect(parsed.coexistenceEnabled).toBe(false);
  });

  it("exige token de acesso ao rotacionar credenciais", () => {
    expect(rotateCredentialsSchema.safeParse({ accessToken: "" }).success).toBe(false);
  });
});
