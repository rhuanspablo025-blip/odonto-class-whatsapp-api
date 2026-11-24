import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

import { getEnv, isDeployedEnv } from "./config/env.js";
import { errorHandler } from "./shared/middleware/error-handler.js";
import { correlationIdPlugin } from "./shared/middleware/correlation-id.js";
import { healthRoutes } from "./modules/health/routes.js";
import { contactsRoutes } from "./modules/contacts/routes.js";
import { messagesRoutes } from "./modules/messages/routes.js";
import { conversationsRoutes } from "./modules/conversations/routes.js";
import { eventsRoutes } from "./modules/events/routes.js";
import { webhookRoutes } from "./modules/webhooks/routes.js";
import { templatesRoutes } from "./modules/templates/routes.js";
import { campaignsRoutes } from "./modules/campaigns/routes.js";
import { automationsRoutes } from "./modules/automations/routes.js";
import { connectionsRoutes } from "./modules/connections/routes.js";
import { onboardingRoutes } from "./modules/onboarding/routes.js";
import { billingRoutes } from "./modules/billing/routes.js";

/**
 * Cria e configura a instância Fastify.
 * Separado de server.ts para facilitar testes.
 */
export function createApp(): FastifyInstance {
  const env = getEnv();

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      base: { service: "odonto-class-whatsapp-api" },
      transport:
        isDeployedEnv(env)
          ? undefined
          : {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "SYS:dd/mm/yyyy HH:MM:ss",
                ignore: "pid,hostname",
              },
            },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers['x-api-key']",
          "*.access_token",
          "*.password",
          "*.apiKey",
          "*.secret",
          "*.token",
        ],
        censor: "***REDACTED***",
      },
    },
    disableRequestLogging: isDeployedEnv(env),
    genReqId: (req) =>
      (req.headers["x-correlation-id"] as string) ??
      Math.random().toString(36).slice(2, 10),
  });

  // Plugins.
  app.register(helmet);
  app.register(cors, { origin: true, credentials: true });

  // Rate limiting (proteção contra abuso/flood).
  // A chave é o HASH da credencial (não o segredo em claro), agrupando as
  // requisições por clínica; sem credencial, cai para o IP de origem.
  // Health checks e a documentação ficam fora do limite.
  app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    allowList: (req) =>
      req.url === "/health/live" ||
      req.url === "/health/ready" ||
      req.url.startsWith("/docs"),
    keyGenerator: (req) => {
      const apiKey = req.headers["x-api-key"];
      if (typeof apiKey === "string" && apiKey.length > 0) {
        return "key:" + createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
      }
      return "ip:" + req.ip;
    },
    errorResponseBuilder: (req, context) => ({
      error: {
        code: "RATE_LIMITED",
        message: "Limite de requisições excedido. Tente novamente em instantes.",
        details: {
          retry_after_seconds: Math.ceil(context.ttl / 1000),
          correlation_id: req.id,
        },
      },
    }),
  });

  // Documentação OpenAPI / Swagger.
  app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Odonto Class WhatsApp API",
        description:
          "API REST de comunicação WhatsApp multi-tenant para o CRM Odonto Class.",
        version: "0.1.0",
      },
      servers: [{ url: "http://localhost:3001" }],
      components: {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            in: "header",
            name: "x-api-key",
          },
        },
      },
      security: [{ apiKey: [] }],
    },
  });
  app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  // Middlewares globais.
  app.addHook("onRequest", correlationIdPlugin);
  app.setErrorHandler(errorHandler);

  // Rotas públicas.
  app.register(healthRoutes);
  app.register(webhookRoutes);

  // Rotas versionadas e autenticadas.
  app.register(async (api) => {
    api.register(contactsRoutes, { prefix: "/api/v1" });
    api.register(messagesRoutes, { prefix: "/api/v1" });
    api.register(conversationsRoutes, { prefix: "/api/v1" });
    api.register(eventsRoutes, { prefix: "/api/v1" });
    api.register(templatesRoutes, { prefix: "/api/v1" });
    api.register(campaignsRoutes, { prefix: "/api/v1" });
    api.register(automationsRoutes, { prefix: "/api/v1" });
    api.register(connectionsRoutes, { prefix: "/api/v1" });
    api.register(onboardingRoutes, { prefix: "/api/v1" });
    api.register(billingRoutes, { prefix: "/api/v1" });
  });

  // Rota raiz.
  app.get("/", async () => ({
    service: "Odonto Class WhatsApp API",
    version: "0.1.0",
    docs: "/docs",
    health: "/health/live",
  }));

  return app;
}
