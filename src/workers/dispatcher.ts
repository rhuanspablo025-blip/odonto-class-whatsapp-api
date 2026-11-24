import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";

import { getEnv } from "../config/env.js";
import { getDb } from "../database/client.js";
import {
  contacts,
  conversations,
  campaignRecipients,
  campaigns,
  messageJobs,
  messages,
} from "../database/schema/index.js";
import { getWhatsAppProvider } from "../integrations/whatsapp/factory.js";
import {
  RateLimitError,
  WhatsAppProviderError,
} from "../integrations/whatsapp/errors.js";
import { nowMs } from "../lib/ids.js";

/**
 * Worker de envio de mensagens.
 *
 * - Adquire leases atômicos em jobs PENDING.
 * - Envia via provedor WhatsApp.
 * - Aplica retries com backoff exponencial + jitter.
 * - Move jobs com falhas permanentes para DEAD_LETTER.
 */

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000; // 1s
const JITTER_MS = 500;
const LEASE_TTL_MS = 60_000; // 1 minuto de lease

/** Tipos de mensagem que são entregues pelo provedor como mídia por link. */
const MEDIA_MESSAGE_TYPES = new Set(["IMAGE", "VIDEO", "AUDIO", "DOCUMENT"]);

const workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

export function isCampaignDispatchable(status: string | null | undefined): boolean {
  return status == null || status === "SCHEDULED" || status === "RUNNING";
}

/** Calcula o próximo tempo de tentativa com backoff exponencial + jitter. */
function nextAttemptDelay(attempts: number): number {
  const backoff = BASE_BACKOFF_MS * Math.pow(2, attempts);
  const jitter = Math.floor(Math.random() * JITTER_MS);
  return backoff + jitter;
}

/**
 * Tenta adquirir um job pendente de forma atômica.
 * Atualiza o lease apenas se o job ainda estiver PENDING e com lease expirado.
 */
async function acquireNextJob(): Promise<typeof messageJobs.$inferSelect | null> {
  const db = getDb();
  const now = nowMs();

  // Seleciona jobs elegíveis (PENDING ou PROCESSING com lease expirado).
  const eligible = await db
    .select({ job: messageJobs })
    .from(messageJobs)
    .innerJoin(
      messages,
      and(
        eq(messages.id, messageJobs.messageId),
        eq(messages.tenantId, messageJobs.tenantId),
      ),
    )
    .leftJoin(
      campaignRecipients,
      and(
        eq(campaignRecipients.messageId, messages.id),
        eq(campaignRecipients.tenantId, messages.tenantId),
      ),
    )
    .leftJoin(
      campaigns,
      and(
        eq(campaigns.id, campaignRecipients.campaignId),
        eq(campaigns.tenantId, campaignRecipients.tenantId),
      ),
    )
    .where(
      and(
        or(
          isNull(campaignRecipients.id),
          inArray(campaigns.status, ["SCHEDULED", "RUNNING"]),
        ),
        lt(messageJobs.nextAttemptAt, now),
        or(
          eq(messageJobs.status, "PENDING"),
          and(
            eq(messageJobs.status, "PROCESSING"),
            lt(messageJobs.leaseExpiresAt ?? 0, now),
          ),
        ),
      ),
    )
    .orderBy(messageJobs.nextAttemptAt)
    .limit(1);

  if (eligible.length === 0) return null;

  const job = eligible[0]!.job;

  // Lease atômico: atualiza apenas se o status ainda for elegível.
  const result = await db
    .update(messageJobs)
    .set({
      status: "PROCESSING",
      leaseOwner: workerId,
      leaseExpiresAt: now + LEASE_TTL_MS,
    })
    .where(
      and(
        eq(messageJobs.id, job.id),
        or(
          eq(messageJobs.status, "PENDING"),
          and(
            eq(messageJobs.status, "PROCESSING"),
            lt(messageJobs.leaseExpiresAt ?? 0, now),
          ),
        ),
      ),
    );

  // Se outra instância pegou o job, tenta novamente.
  if (result.rowsAffected === 0) return null;

  return { ...job, status: "PROCESSING" as const };
}

/** Processa um único job. */
async function processJob(job: typeof messageJobs.$inferSelect): Promise<void> {
  const db = getDb();

  // Carrega a mensagem e dados relacionados.
  const [message] = await db
    .select({
      id: messages.id,
      tenantId: messages.tenantId,
      type: messages.type,
      content: messages.content,
      direction: messages.direction,
      status: messages.status,
    })
    .from(messages)
    .where(eq(messages.id, job.messageId))
    .limit(1);

  if (!message) {
    await db
      .update(messageJobs)
      .set({ status: "DEAD_LETTER", lastError: "Mensagem não encontrada." })
      .where(eq(messageJobs.id, job.id));
    return;
  }

  const [campaign] = await db
    .select({ status: campaigns.status })
    .from(campaignRecipients)
    .innerJoin(
      campaigns,
      and(
        eq(campaigns.id, campaignRecipients.campaignId),
        eq(campaigns.tenantId, campaignRecipients.tenantId),
      ),
    )
    .where(
      and(
        eq(campaignRecipients.messageId, message.id),
        eq(campaignRecipients.tenantId, message.tenantId),
      ),
    )
    .limit(1);

  if (campaign && !isCampaignDispatchable(campaign.status)) {
    await db
      .update(messageJobs)
      .set({ status: "PENDING", leaseOwner: null, leaseExpiresAt: null })
      .where(
        and(
          eq(messageJobs.id, job.id),
          eq(messageJobs.leaseOwner, workerId),
        ),
      );
    return;
  }

  // Busca o telefone do contato através da conversa.
  const [conv] = await db
    .select({
      contactId: conversations.contactId,
      whatsappAccountId: conversations.whatsappAccountId,
    })
    .from(conversations)
    .innerJoin(messages, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(messages.id, job.messageId),
        eq(messages.tenantId, message.tenantId),
        eq(conversations.tenantId, message.tenantId),
      ),
    )
    .limit(1);

  if (!conv?.contactId) {
    await markFailed(job, "Conversa ou contato não encontrado.");
    return;
  }

  const [contactRow] = await db
    .select({ phone: contacts.phoneE164 })
    .from(contacts)
    .where(
      and(
        eq(contacts.id, conv.contactId),
        eq(contacts.tenantId, message.tenantId),
      ),
    )
    .limit(1);

  const phone = contactRow?.phone;
  if (!phone) {
    await markFailed(job, "Contato sem telefone.");
    return;
  }

  try {
    const provider = await getWhatsAppProvider(
      message.tenantId,
      conv.whatsappAccountId,
    );
    const content = message.content as Record<string, unknown>;

    let providerResult;
    if (message.type === "TEMPLATE") {
      providerResult = await provider.sendTemplate({
        to: phone,
        templateName: content.templateName as string,
        language: (content.language as string) ?? "pt_BR",
        components: content.components as never[],
      });
    } else if (MEDIA_MESSAGE_TYPES.has(message.type)) {
      providerResult = await provider.sendMedia({
        to: phone,
        mediaType: (content.mediaType as string)?.toLowerCase() as
          | "image"
          | "video"
          | "audio"
          | "document",
        mediaIdOrLink: content.link as string,
        caption: content.caption as string | undefined,
      });
    } else {
      providerResult = await provider.sendText({
        to: phone,
        text: content.text as string,
        previewUrl: content.previewUrl as boolean | undefined,
      });
    }

    // Sucesso.
    const now = nowMs();
    await db
      .update(messages)
      .set({
        status: "SENT",
        providerMessageId: providerResult.providerMessageId,
        sentAt: now,
      })
      .where(eq(messages.id, message.id));

    await db
      .update(messageJobs)
      .set({ status: "COMPLETED", lastError: null })
      .where(eq(messageJobs.id, job.id));
  } catch (error) {
    await handleSendFailure(job, message.id, error);
  }
}

/** Trata falha de envio com retry ou dead-letter. */
async function handleSendFailure(
  job: typeof messageJobs.$inferSelect,
  messageId: string,
  error: unknown,
): Promise<void> {
  const db = getDb();
  const attempts = job.attempts + 1;
  const maxAttempts = job.maxAttempts ?? MAX_ATTEMPTS;

  const isRetryable =
    attempts < maxAttempts &&
    (error instanceof WhatsAppProviderError
      ? error.isRetryable()
      : error instanceof Error);

  if (isRetryable) {
    const delay =
      error instanceof RateLimitError
        ? error.retryAfterSeconds * 1000
        : nextAttemptDelay(attempts);
    await db
      .update(messageJobs)
      .set({
        status: "PENDING",
        attempts,
        nextAttemptAt: nowMs() + delay,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: error instanceof Error ? error.message : "Erro desconhecido",
      })
      .where(eq(messageJobs.id, job.id));

    await db
      .update(messages)
      .set({
        status: "FAILED",
        errorCode: error instanceof RateLimitError ? "RATE_LIMITED" : "SEND_FAILED",
        errorMessage: error instanceof Error ? error.message : "Erro desconhecido",
        failedAt: nowMs(),
      })
      .where(eq(messages.id, messageId));
  } else {
    // Falha permanente → dead letter.
    await markFailed(job, error instanceof Error ? error.message : "Erro desconhecido");
    await db
      .update(messages)
      .set({
        status: "FAILED",
        errorCode: "PERMANENT_FAILURE",
        errorMessage: error instanceof Error ? error.message : "Erro desconhecido",
        failedAt: nowMs(),
      })
      .where(eq(messages.id, messageId));
  }
}

/** Marca um job como DEAD_LETTER. */
async function markFailed(
  job: typeof messageJobs.$inferSelect,
  error: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(messageJobs)
    .set({
      status: "DEAD_LETTER",
      lastError: error,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(messageJobs.id, job.id));
}

/** Executa um ciclo de processamento. */
export async function runDispatcherCycle(): Promise<{ processed: number }> {
  let processed = 0;
  const env = getEnv();
  const concurrency = env.WORKER_CONCURRENCY;

  // Processa jobs em paralelo até atingir a concorrência.
  const promises: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    promises.push(
      (async () => {
        const job = await acquireNextJob();
        if (job) {
          await processJob(job);
          processed++;
        }
      })(),
    );
  }

  await Promise.all(promises);
  return { processed };
}

/** Loop principal do dispatcher. */
export async function startDispatcher(): Promise<void> {
  const env = getEnv();
  const interval = env.WORKER_POLL_INTERVAL_MS;

  console.log(`[dispatcher] Iniciando (worker=${workerId}, concurrency=${env.WORKER_CONCURRENCY})`);

  while (true) {
    try {
      const { processed } = await runDispatcherCycle();
      if (processed === 0) {
        await new Promise((r) => setTimeout(r, interval));
      }
    } catch (error) {
      console.error("[dispatcher] Erro no ciclo:", error);
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}
