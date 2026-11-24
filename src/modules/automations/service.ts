import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../database/client.js";
import {
  automationRuns,
  automations,
} from "../../database/schema/index.js";
import { errors } from "../../lib/errors.js";
import { newId, nowMs } from "../../lib/ids.js";
import { sendTemplateMessage } from "../messages/service.js";

/**
 * Módulo de Automações.
 *
 * Automações são gatilhos baseados em eventos que executam ações.
 * Prevenção de loops: cada execução registra a cadeia; uma automação não
 * pode disparar a si mesma ou a uma já na cadeia.
 */

export const createAutomationSchema = z.object({
  name: z.string().min(1).max(200),
  triggerType: z.enum([
    "MESSAGE_RECEIVED",
    "MESSAGE_READ",
    "MESSAGE_SENT",
    "CONTACT_CREATED",
  ]),
  conditions: z.record(z.string(), z.unknown()).default({}),
  actions: z.array(
    z.object({
      type: z.literal("SEND_TEMPLATE"),
      templateName: z.string(),
      language: z.string().default("pt_BR"),
    }),
  ),
  enabled: z.boolean().default(true),
  runLimit: z.number().int().positive().optional(),
});

type EventType =
  | "MESSAGE_RECEIVED"
  | "MESSAGE_READ"
  | "MESSAGE_SENT"
  | "CONTACT_CREATED";

/** Cria uma automação. */
export async function createAutomation(
  tenantId: string,
  input: z.infer<typeof createAutomationSchema>,
) {
  const db = getDb();
  const id = newId();

  await db.insert(automations).values({
    id,
    tenantId,
    name: input.name,
    triggerType: input.triggerType,
    conditions: input.conditions,
    actions: input.actions as unknown as Record<string, unknown>[],
    enabled: input.enabled,
    runLimit: input.runLimit,
  });

  const [created] = await db
    .select()
    .from(automations)
    .where(eq(automations.id, id))
    .limit(1);

  return created;
}

/** Lista automações do tenant. */
export async function listAutomations(tenantId: string) {
  const db = getDb();
  return db
    .select()
    .from(automations)
    .where(eq(automations.tenantId, tenantId));
}

/** Ativa/desativa uma automação. */
export async function toggleAutomation(
  tenantId: string,
  automationId: string,
  enabled: boolean,
) {
  const db = getDb();
  const result = await db
    .update(automations)
    .set({ enabled, updatedAt: nowMs() })
    .where(and(eq(automations.tenantId, tenantId), eq(automations.id, automationId)));

  if (result.rowsAffected === 0) throw errors.notFound("Automação");
  return { id: automationId, enabled };
}

/**
 * Avalia e executa automações para um evento.
 */
export async function evaluateAutomations(
  eventType: EventType,
  tenantId: string,
  contactId: string,
  chainIds: string[] = [],
): Promise<{ executed: number }> {
  const db = getDb();

  const activeAutomations = await db
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.tenantId, tenantId),
        eq(automations.enabled, true),
        eq(automations.triggerType, eventType),
      ),
    );

  let executed = 0;

  for (const automation of activeAutomations) {
    if (chainIds.includes(automation.id)) continue;

    const runId = newId();
    await db.insert(automationRuns).values({
      id: runId,
      tenantId,
      automationId: automation.id,
      triggerEvent: eventType,
      status: "SUCCESS",
    });

    const actions = (automation.actions ?? []) as Array<{
      type: string;
      templateName?: string;
      language?: string;
    }>;

    let failed = false;
    for (const action of actions) {
      if (action.type === "SEND_TEMPLATE" && action.templateName) {
        try {
          await sendTemplateMessage(tenantId, {
            contactId,
            templateName: action.templateName,
            language: action.language ?? "pt_BR",
          });
        } catch (error) {
          failed = true;
          await db
            .update(automationRuns)
            .set({
              status: "FAILED",
              error: error instanceof Error ? error.message : "Erro desconhecido",
            })
            .where(eq(automationRuns.id, runId));
          break;
        }
      }
    }

    if (!failed) {
      await db
        .update(automationRuns)
        .set({ status: "SUCCESS" })
        .where(eq(automationRuns.id, runId));
    }

    executed++;
  }

  return { executed };
}
