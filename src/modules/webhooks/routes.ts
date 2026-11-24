import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getEnv } from "../../config/env.js";
import { safeEqual } from "../../config/security.js";
import {
  persistMetaWebhook,
  processPersistedWebhookEvents,
  verifyWebhookSignature,
} from "./service.js";

const metaWebhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string().min(1),
      changes: z.array(
        z.object({
          field: z.string().min(1),
          value: z.record(z.string(), z.unknown()),
        }).passthrough(),
      ),
    }).passthrough(),
  ),
}).passthrough();

/**
 * Rotas de webhook da Meta.
 * - GET /webhooks/meta: verificação (hub challenge).
 * - POST /webhooks/meta: recebimento de eventos.
 */
export async function webhookRoutes(app: FastifyInstance) {
  // A assinatura da Meta é calculada sobre os bytes exatos recebidos.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, payload, done) => {
      const raw = payload.toString("utf-8");
      (request as unknown as { rawBody?: string }).rawBody = raw;
      try {
        done(null, JSON.parse(raw));
      } catch {
        const error = new Error("JSON inválido no webhook.") as Error & { statusCode: number };
        error.statusCode = 400;
        done(error);
      }
    },
  );

  // Verificação do webhook.
  app.get("/webhooks/meta", async (request, reply) => {
    const query = request.query as {
      "hub.mode"?: string;
      "hub.verify_token"?: string;
      "hub.challenge"?: string;
    };
    const env = getEnv();

    const configuredToken = env.META_WEBHOOK_VERIFY_TOKEN;
    const challenge = query["hub.challenge"];

    if (
      configuredToken &&
      query["hub.mode"] === "subscribe" &&
      query["hub.verify_token"] &&
      challenge !== undefined &&
      safeEqual(query["hub.verify_token"], configuredToken)
    ) {
      return reply.type("text/plain").send(challenge);
    }

    return reply.status(403).send({ error: "Verificação falhou." });
  });

  // Recebimento de eventos.
  app.post("/webhooks/meta", async (request, reply) => {
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? "";

    if (!verifyWebhookSignature(rawBody, signature)) {
      return reply.status(401).send({ error: "Assinatura inválida." });
    }

    const parsed = metaWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Payload de webhook inválido." });
    }

    // Primeiro grava de forma durável; só então confirma o recebimento à Meta.
    const eventIds = await persistMetaWebhook(parsed.data);
    reply.status(200).send({ status: "received" });

    // O processamento de negócio é assíncrono, mas o evento bruto já está salvo.
    void processPersistedWebhookEvents(eventIds).catch((err) => {
      request.log.error({ err, eventIds }, "Falha ao processar webhook persistido.");
    });

    return reply;
  });
}
