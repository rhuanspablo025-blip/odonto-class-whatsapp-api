import { describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { signEventContent } from "./service.js";

describe("eventos em tempo real", () => {
  it("assina o conteúdo de forma determinística e sensível a alterações", () => {
    const a = signEventContent("1.evt-1.message.inbound");
    const b = signEventContent("1.evt-1.message.inbound");
    const c = signEventContent("1.evt-2.message.inbound");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f\d]{64}$/);
  });

  it("exige credencial para ler o canal de eventos", async () => {
    const app = createApp();
    try {
      const json = await app.inject({ method: "GET", url: "/api/v1/events" });
      expect(json.statusCode).toBe(401);

      const stream = await app.inject({ method: "GET", url: "/api/v1/events/stream" });
      expect(stream.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
