import { describe, expect, it } from "vitest";

import { createTemplateSchema } from "./service.js";

describe("Template schema", () => {
  it("não aceita aprovação informada pelo cliente", () => {
    const parsed = createTemplateSchema.parse({
      name: "appointment_reminder",
      status: "APPROVED",
    });

    expect(parsed).not.toHaveProperty("status");
  });
});
