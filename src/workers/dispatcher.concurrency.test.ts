import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resetEnvCache } from "../config/env.js";
import type { Database } from "../database/client.js";
import { getDb } from "../database/client.js";
import {
  campaignRecipients,
  campaigns,
  contacts,
  conversations,
  messageJobs,
  messages,
  tenants,
} from "../database/schema/index.js";

/**
 * Teste de concorrência do dispatcher (Fase 12 — Bloco 4).
 *
 * Simula DUAS instâncias independentes do worker (workerId distintos, obtidos
 * via `vi.resetModules()` + import dinâmico) disputando o MESMO job contra o
 * mesmo banco. O lease atômico (UPDATE condicional + rowsAffected) deve garantir
 * que APENAS UMA instância processe o job — sem envio duplicado.
 *
 * Nenhum disparo real é executado: usa sempre `WHATSAPP_PROVIDER=test`.
 */

let tempDir: string | undefined;
let db: Database;

async function seedJob(opts: {
  suffix: string;
  campaignStatus?: string;
}): Promise<{ jobId: string; messageId: string }> {
  const s = opts.suffix;
  const tenantId = `tnt-${s}`;
  const contactId = `ctt-${s}`;
  const conversationId = `cnv-${s}`;
  const messageId = `msg-${s}`;
  const jobId = `job-${s}`;

  await db.insert(tenants).values({ id: tenantId, name: `Tenant ${s}`, slug: `tenant-${s}` });
  await db.insert(contacts).values({
    id: contactId,
    tenantId,
    name: "Paciente Teste",
    phoneE164: "+5511999999999",
  });
  await db.insert(conversations).values({
    id: conversationId,
    tenantId,
    contactId,
    status: "OPEN",
  });
  await db.insert(messages).values({
    id: messageId,
    tenantId,
    conversationId,
    contactId,
    direction: "OUTBOUND",
    type: "TEXT",
    content: { text: "Mensagem de teste" },
    status: "PENDING",
  });

  if (opts.campaignStatus) {
    await db.insert(campaigns).values({
      id: `cmp-${s}`,
      tenantId,
      name: `Campanha ${s}`,
      status: opts.campaignStatus as "PAUSED",
    });
    await db.insert(campaignRecipients).values({
      id: `rcp-${s}`,
      tenantId,
      campaignId: `cmp-${s}`,
      contactId,
      messageId,
      status: "PENDING",
    });
  }

  const due = Date.now() - 1000;
  await db.insert(messageJobs).values({
    id: jobId,
    tenantId,
    messageId,
    scheduledAt: due,
    status: "PENDING",
    nextAttemptAt: due,
  });

  return { jobId, messageId };
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "odonto-jobs-"));
  process.env.DATABASE_URL = `file:${join(tempDir, "concurrency.db")}`;
  process.env.WHATSAPP_PROVIDER = "test";
  process.env.WORKER_CONCURRENCY = "1";
  process.env.API_KEY_PEPPER ??= "test-pepper-123456";
  process.env.ENCRYPTION_KEY ??= "test-encryption-key-32-bytes-xx";
  process.env.INTERNAL_WORKER_TOKEN ??= "test-internal-token";
  resetEnvCache();

  db = getDb();
  const { migrate } = await import("drizzle-orm/libsql/migrator");
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  const client = (db as unknown as { $client?: { close(): unknown } }).$client;
  try {
    await client?.close?.();
  } catch {
    // fechamento do cliente é best-effort
  }
  delete (globalThis as unknown as { __whatsappApiDb?: unknown }).__whatsappApiDb;
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // No Windows o SO pode segurar o lock do arquivo por alguns instantes;
      // o diretório temporário é descartável.
    }
  }
});

describe("dispatcher — concorrência entre instâncias", () => {
  it("apenas uma instância processa o mesmo job (lease atômico)", async () => {
    const { jobId, messageId } = await seedJob({ suffix: "race" });

    // Duas instâncias independentes (workerId distintos) do mesmo worker.
    vi.resetModules();
    const workerA = await import("./dispatcher.js");
    vi.resetModules();
    const workerB = await import("./dispatcher.js");

    const [a, b] = await Promise.all([
      workerA.runDispatcherCycle(),
      workerB.runDispatcherCycle(),
    ]);

    expect(a.processed + b.processed).toBe(1);

    const [job] = await db
      .select()
      .from(messageJobs)
      .where(eq(messageJobs.id, jobId));
    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId));

    expect(job!.status).toBe("COMPLETED");
    expect(msg!.status).toBe("SENT");
    expect(msg!.providerMessageId).toMatch(/^wamid\.test\./);
  });

  it("não processa jobs de campanhas pausadas", async () => {
    const { jobId } = await seedJob({ suffix: "paused", campaignStatus: "PAUSED" });

    vi.resetModules();
    const { runDispatcherCycle } = await import("./dispatcher.js");
    const result = await runDispatcherCycle();

    expect(result.processed).toBe(0);

    const [job] = await db
      .select()
      .from(messageJobs)
      .where(eq(messageJobs.id, jobId));
    expect(job!.status).toBe("PENDING");
  });
});
