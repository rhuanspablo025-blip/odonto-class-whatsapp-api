import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { getEnv } from "../../config/env.js";
import { getDb } from "../../database/client.js";

/**
 * Health checks.
 * - /health/live: liveness — NÃO depende de serviços externos.
 * - /health/ready: readiness — verifica dependências críticas.
 */
export async function healthRoutes(app: FastifyInstance) {
  app.get("/health/live", async () => ({
    status: "alive",
    service: "odonto-class-whatsapp-api",
    env: getEnv().NODE_ENV,
    timestamp: new Date().toISOString(),
  }));

  app.get("/health/ready", async (request, reply) => {
    try {
      const db = getDb();
      // Ping simples no banco via ORM.
      await db.get(sql`SELECT 1 as ok`);
      return { status: "ready", checks: { database: "ok" } };
    } catch (error) {
      request.log.error({ err: error }, "Readiness check falhou.");
      return reply
        .status(503)
        .send({ status: "not-ready", checks: { database: "fail" } });
    }
  });
}
