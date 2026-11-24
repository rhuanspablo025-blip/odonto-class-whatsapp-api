import type { FastifyInstance } from "fastify";

import { authenticate, getAuth, requirePermission } from "../auth/auth.js";
import { getLatestCursor, listEventsSince } from "./service.js";

/**
 * Rotas do canal em tempo real.
 *
 * `GET /events`  — polling com cursor (fallback simples e testável).
 * `GET /events/stream` — Server-Sent Events com heartbeat e retomada por cursor.
 *
 * O stream é isolado por tenant (derivado da credencial) e a leitura é feita
 * diretamente do log durável, o que o torna seguro em ambiente multi-instância.
 */

const POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 15_000;

export async function eventsRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  app.get(
    "/events",
    { preHandler: requirePermission("messages:read") },
    async (request) => {
      const { tenantId } = getAuth(request);
      const { cursor, limit } = request.query as { cursor?: string; limit?: string };

      const startCursor = cursor ? Number(cursor) : await getLatestCursor(tenantId);
      const events = await listEventsSince(
        tenantId,
        Number.isFinite(startCursor) ? startCursor : 0,
        limit ? Number(limit) : 200,
      );
      return {
        events,
        cursor: events.length > 0 ? events[events.length - 1]!.seq : startCursor,
      };
    },
  );

  app.get(
    "/events/stream",
    { preHandler: requirePermission("messages:read") },
    async (request, reply) => {
      const { tenantId } = getAuth(request);
      const { cursor } = request.query as { cursor?: string };

      let lastSeq = cursor ? Number(cursor) : await getLatestCursor(tenantId);
      if (!Number.isFinite(lastSeq)) lastSeq = 0;

      // Assume o controle da resposta para manter a conexão aberta.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      raw.write("retry: 3000\n\n");
      raw.write(`event: ready\ndata: ${JSON.stringify({ cursor: lastSeq })}\n\n`);

      let closed = false;
      let polling = false;

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        try {
          raw.end();
        } catch {
          // Conexão já encerrada.
        }
      };

      request.raw.on("close", close);
      request.raw.on("error", close);

      const poll = async () => {
        if (closed || polling) return;
        polling = true;
        try {
          const batch = await listEventsSince(tenantId, lastSeq, 200);
          if (batch.length === 0) return;
          for (const event of batch) {
            raw.write(`id: ${event.seq}\n`);
            raw.write(`event: ${event.type}\n`);
            raw.write(`data: ${JSON.stringify(event)}\n\n`);
            lastSeq = event.seq;
          }
        } catch {
          // Falha transitória de leitura: será retentada no próximo ciclo.
        } finally {
          polling = false;
        }
      };

      const heartbeat = () => {
        if (closed) return;
        raw.write(`: ping ${Date.now()}\n\n`);
      };

      const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
      const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

      // Envia de imediato o que já existir após o cursor.
      void poll();
    },
  );
}
