import { describe, expect, it } from "vitest";

import { sendMediaSchema, sendTemplateSchema, sendTextSchema } from "./service.js";

describe("WhatsApp message schemas", () => {
  it("aceita preview de link conforme o payload da Messages API", () => {
    expect(
      sendTextSchema.parse({
        contactId: "contact-1",
        text: "Acesse https://example.com",
        previewUrl: true,
      }).previewUrl,
    ).toBe(true);
  });

  it("aceita parâmetros de mídia para header de template", () => {
    const result = sendTemplateSchema.parse({
      contactId: "contact-1",
      templateName: "appointment_reminder",
      components: [
        {
          type: "header",
          parameters: [{ type: "image", image: { link: "https://example.com/header.jpg" } }],
        },
        {
          type: "body",
          parameters: [{ type: "text", text: "Mariana", parameter_name: "patient_name" }],
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: "appointment/123" }],
        },
      ],
    });

    expect(result.components).toHaveLength(3);
  });

  it("exige um media ID ou link para parâmetros de mídia", () => {
    const result = sendTemplateSchema.safeParse({
      contactId: "contact-1",
      templateName: "appointment_reminder",
      components: [
        { type: "header", parameters: [{ type: "image", image: {} }] },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("aceita envio de mídia por link público", () => {
    const parsed = sendMediaSchema.parse({
      contactId: "contact-1",
      mediaType: "image",
      link: "https://example.com/foto.jpg",
      caption: "Antes e depois",
    });

    expect(parsed.mediaType).toBe("image");
    expect(parsed.link).toBe("https://example.com/foto.jpg");
  });

  it("rejeita mídia sem link válido", () => {
    const result = sendMediaSchema.safeParse({
      contactId: "contact-1",
      mediaType: "document",
      link: "não-é-url",
    });

    expect(result.success).toBe(false);
  });
});
