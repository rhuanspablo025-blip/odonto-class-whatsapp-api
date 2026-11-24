import { afterEach, describe, expect, it } from "vitest";

import { resetEnvCache } from "../../config/env.js";
import { createApp } from "../../app.js";

const originalVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

afterEach(() => {
  if (originalVerifyToken === undefined) delete process.env.META_WEBHOOK_VERIFY_TOKEN;
  else process.env.META_WEBHOOK_VERIFY_TOKEN = originalVerifyToken;
  resetEnvCache();
});

describe("Meta webhook verification endpoint", () => {
  it("retorna hub.challenge como texto sem converter seu conteúdo", async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test-token";
    resetEnvCache();
    const app = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-test-token&hub.challenge=0000123",
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("0000123");
    } finally {
      await app.close();
    }
  });

  it("recusa a verificação quando o verify token não está configurado", async () => {
    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
    resetEnvCache();
    const app = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/webhooks/meta?hub.mode=subscribe&hub.challenge=123",
      });

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("rejeita POST sem assinatura antes de persistir eventos", async () => {
    const app = createApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/meta",
        payload: { object: "whatsapp_business_account", entry: [] },
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
