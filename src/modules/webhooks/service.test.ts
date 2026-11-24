import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetEnvCache } from "../../config/env.js";
import { verifyWebhookSignature } from "./service.js";

const originalAppSecret = process.env.META_APP_SECRET;

describe("Meta webhook signature", () => {
  beforeEach(() => {
    process.env.META_APP_SECRET = "unit-test-app-secret";
    resetEnvCache();
  });

  afterEach(() => {
    if (originalAppSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = originalAppSecret;
    resetEnvCache();
  });

  it("valida HMAC-SHA256 do corpo bruto", () => {
    const rawBody = '{"object":"whatsapp_business_account","entry":[]}';
    const digest = crypto
      .createHmac("sha256", "unit-test-app-secret")
      .update(rawBody)
      .digest("hex");

    expect(verifyWebhookSignature(rawBody, `sha256=${digest}`)).toBe(true);
    expect(verifyWebhookSignature(`${rawBody} `, `sha256=${digest}`)).toBe(false);
  });

  it("falha fechado sem segredo, sem header ou com digest malformado", () => {
    const rawBody = '{"entry":[]}';
    const digest = crypto
      .createHmac("sha256", "unit-test-app-secret")
      .update(rawBody)
      .digest("hex");

    expect(verifyWebhookSignature(rawBody, undefined)).toBe(false);
    expect(verifyWebhookSignature(rawBody, "sha256=not-hex")).toBe(false);
    expect(() => verifyWebhookSignature(rawBody, "sha256=00")).not.toThrow();

    delete process.env.META_APP_SECRET;
    resetEnvCache();
    expect(verifyWebhookSignature(rawBody, `sha256=${digest}`)).toBe(false);
  });
});
