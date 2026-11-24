import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageNotAllowedError } from "./errors.js";
import { MetaClient } from "./meta-client.js";

const mockFetch = vi.fn<typeof fetch>();

describe("MetaClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it("envia texto no contrato da Messages API atual", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.mock.1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = new MetaClient("test-access-token", "phone-number-123", "v27.0");
    const result = await client.sendText({
      to: "+5511999990001",
      text: "Olá",
      previewUrl: true,
    });

    expect(result).toEqual({
      providerMessageId: "wamid.mock.1",
      phoneNumberId: "phone-number-123",
    });
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "https://graph.facebook.com/v27.0/phone-number-123/messages",
    );

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-access-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+5511999990001",
      type: "text",
      text: { body: "Olá", preview_url: true },
    });
  });

  it("usa media ID quando o valor não é uma URL e não envia caption para áudio", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.mock.audio" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await new MetaClient("test-access-token", "phone-number-123", "v27.0").sendMedia(
      "+5511999990001",
      "audio",
      "meta-media-id",
      "caption ignored",
    );

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      type: "audio",
      audio: { id: "meta-media-id" },
    });
    expect(JSON.parse(String(init.body)).audio.caption).toBeUndefined();
  });

  it("respeita Retry-After e reconhece limitação de throughput da Meta", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "(#130429) Rate limit hit",
            code: 130429,
            error_data: { details: "Throughput limit reached" },
            fbtrace_id: "trace-test",
          },
        }),
        { status: 400, headers: { "content-type": "application/json", "retry-after": "17" } },
      ),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = new MetaClient("test-access-token", "phone-number-123", "v27.0");
    await expect(client.sendText({ to: "+5511999990001", text: "Oi" })).rejects.toMatchObject({
      name: "RateLimitError",
      retryAfterSeconds: 17,
      metaErrorCode: 130429,
      fbTraceId: "trace-test",
    });
  });

  it("classifica janela de atendimento fechada sem confundir erro de allowlist", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Re-engagement required", code: 131047 } }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = new MetaClient("test-access-token", "phone-number-123", "v27.0");
    await expect(client.sendText({ to: "+5511999990001", text: "Oi" })).rejects.toBeInstanceOf(
      MessageNotAllowedError,
    );
  });

  it("sincroniza páginas de templates pela WABA e envia token somente no header", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "template-1",
                name: "appointment_reminder",
                language: "pt_BR",
                status: "APPROVED",
                category: "UTILITY",
                components: [],
              },
            ],
            paging: { cursors: { after: "cursor-1" } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const templates = await new MetaClient(
      "test-access-token",
      "phone-number-123",
      "v27.0",
    ).listMessageTemplates("waba-123");

    expect(templates).toHaveLength(1);
    expect(templates[0]?.name).toBe("appointment_reminder");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain(
      "/v27.0/waba-123/message_templates?fields=",
    );
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("after=cursor-1");
    expect(String(mockFetch.mock.calls[0]?.[0])).not.toContain("test-access-token");
    expect((mockFetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-access-token",
    });
  });
});
