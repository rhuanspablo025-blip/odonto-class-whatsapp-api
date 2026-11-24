import { and, eq, lt } from "drizzle-orm";

import { getDb } from "../database/client.js";
import { messageJobs, webhookEvents } from "../database/schema/index.js";
import { nowMs } from "../lib/ids.js";
import { processPersistedWebhookEvents } from "../modules/webhooks/service.js";

/**
 * Worker de recuperação de jobs abandonados.
 *
 * Libera jobs com lease expirado (instância que travou ou caiu) para que
 * outra instância possa processá-los.
 */
export async function runRecoveryCycle(): Promise<{ recovered: number }> {
  const db = getDb();
  const now = nowMs();

  const result = await db
    .update(messageJobs)
    .set({
      status: "PENDING",
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(messageJobs.status, "PROCESSING"),
        lt(messageJobs.leaseExpiresAt ?? 0, now),
      ),
    );

  const staleWebhookEvents = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.status, "PENDING"),
        lt(webhookEvents.receivedAt, now - 60_000),
      ),
    )
    .limit(25);

  if (staleWebhookEvents.length > 0) {
    try {
      await processPersistedWebhookEvents(staleWebhookEvents.map((event) => event.id));
    } catch (error) {
      console.error("[recovery] Falha ao reprocessar webhook persistido:", error);
    }
  }

  return { recovered: result.rowsAffected };
}

/** Loop principal de recovery. */
export async function startRecovery(): Promise<void> {
  console.log("[recovery] Iniciando worker de recuperação...");
  while (true) {
    try {
      const { recovered } = await runRecoveryCycle();
      if (recovered > 0) {
        console.log(`[recovery] ${recovered} job(s) recuperado(s).`);
      }
    } catch (error) {
      console.error("[recovery] Erro:", error);
    }
    await new Promise((r) => setTimeout(r, 30_000)); // a cada 30s
  }
}
