import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getEnv } from "../../config/env.js";
import { randomToken } from "../../config/security.js";
import { getDb } from "../../database/client.js";
import { whatsappOnboardingSessions } from "../../database/schema/index.js";
import { errors } from "../../lib/errors.js";
import { newId, nowMs } from "../../lib/ids.js";
import { connectAccount, connectAccountSchema } from "../connections/service.js";
import type { PublicConnection } from "../connections/credentials.js";
import { getEmbeddedSignupClient, type PhoneNumberSummary } from "./client.js";

/**
 * Meta Embedded Signup + coexistência.
 *
 * Fluxo: a clínica inicia uma sessão (state anti-CSRF) → o SDK da Meta no
 * frontend conduz o consentimento → o callback devolve `code`, `waba_id` e
 * `phone_number_id` → concluímos trocando o code por token, validando a WABA e
 * registrando a conexão via Connection Manager.
 *
 * Dependência externa: exige App ID/Secret e configuração de Embedded Signup
 * criadas no painel da Meta. Sem elas, apenas o cliente de teste é usado.
 */

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutos

type OnboardingMode = "EMBEDDED_SIGNUP" | "COEXISTENCE";
type OnboardingStatus = "PENDING" | "COMPLETED" | "FAILED" | "EXPIRED";

export const startOnboardingSchema = z.object({
  mode: z.enum(["EMBEDDED_SIGNUP", "COEXISTENCE"]).default("EMBEDDED_SIGNUP"),
  businessId: z.string().min(1).optional(),
});

export const completeOnboardingSchema = z.object({
  state: z.string().min(8),
  code: z.string().min(1),
  wabaId: z.string().min(1),
  phoneNumberId: z.string().min(1).optional(),
  businessId: z.string().min(1).optional(),
});

export interface OnboardingSessionView {
  id: string;
  state: string;
  mode: OnboardingMode;
  status: OnboardingStatus;
  businessId: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  whatsappAccountId: string | null;
  error: string | null;
  expiresAt: number;
  createdAt: number;
  completedAt: number | null;
}

type OnboardingSessionRow = typeof whatsappOnboardingSessions.$inferSelect;

function toSessionView(row: OnboardingSessionRow): OnboardingSessionView {
  return {
    id: row.id,
    state: row.state,
    mode: row.mode,
    status: row.status,
    businessId: row.businessId ?? null,
    wabaId: row.wabaId ?? null,
    phoneNumberId: row.phoneNumberId ?? null,
    whatsappAccountId: row.whatsappAccountId ?? null,
    error: row.error ?? null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
  };
}

/**
 * Escolhe o número de telefone alvo do onboarding.
 * Usa o número informado no callback ou, na ausência, o primeiro disponível.
 */
export function selectPhoneNumber(
  numbers: PhoneNumberSummary[],
  preferredId?: string,
): PhoneNumberSummary | null {
  if (preferredId) return numbers.find((n) => n.phoneNumberId === preferredId) ?? null;
  return numbers[0] ?? null;
}

/** Indica se a sessão já expirou. */
export function isSessionExpired(session: { expiresAt: number }, at: number): boolean {
  return session.expiresAt <= at;
}

/** Inicia uma sessão de Embedded Signup retornando o `state` para o SDK da Meta. */
export async function startOnboarding(
  tenantId: string,
  input: z.infer<typeof startOnboardingSchema>,
) {
  const db = getDb();
  const id = newId();
  const state = randomToken(24);
  const expiresAt = nowMs() + SESSION_TTL_MS;

  await db.insert(whatsappOnboardingSessions).values({
    id,
    tenantId,
    state,
    mode: input.mode,
    status: "PENDING",
    businessId: input.businessId ?? null,
    expiresAt,
  });

  return {
    sessionId: id,
    state,
    mode: input.mode,
    expiresAt,
    // Configuração de Embedded Signup (criada no painel da Meta).
    configId: getEnv().META_EMBEDDED_SIGNUP_CONFIG_ID ?? null,
  };
}

async function findSession(tenantId: string, sessionId: string): Promise<OnboardingSessionRow> {
  const db = getDb();
  const [session] = await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(
      and(
        eq(whatsappOnboardingSessions.tenantId, tenantId),
        eq(whatsappOnboardingSessions.id, sessionId),
      ),
    )
    .limit(1);
  if (!session) throw errors.notFound("Sessão de onboarding");
  return session;
}

export async function getOnboardingSession(
  tenantId: string,
  sessionId: string,
): Promise<OnboardingSessionView> {
  return toSessionView(await findSession(tenantId, sessionId));
}

export async function listOnboardingSessions(tenantId: string): Promise<OnboardingSessionView[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(eq(whatsappOnboardingSessions.tenantId, tenantId))
    .orderBy(desc(whatsappOnboardingSessions.createdAt));
  return rows.map(toSessionView);
}

export interface CompleteOnboardingResult {
  session: OnboardingSessionView;
  connection: PublicConnection;
}

/**
 * Conclui um onboarding: troca o `code` por token, valida a WABA, resolve a
 * coexistência e conecta a conta via Connection Manager.
 */
export async function completeOnboarding(
  tenantId: string,
  input: z.infer<typeof completeOnboardingSchema>,
): Promise<CompleteOnboardingResult> {
  const db = getDb();
  const [session] = await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(
      and(
        eq(whatsappOnboardingSessions.tenantId, tenantId),
        eq(whatsappOnboardingSessions.state, input.state),
      ),
    )
    .limit(1);

  if (!session) throw errors.notFound("Sessão de onboarding");
  if (session.status === "COMPLETED") {
    throw errors.validation("Sessão de onboarding já concluída.");
  }
  if (session.status === "FAILED") {
    throw errors.validation("Sessão de onboarding falhou. Inicie um novo fluxo.");
  }
  if (session.status === "EXPIRED" || isSessionExpired(session, nowMs())) {
    await db
      .update(whatsappOnboardingSessions)
      .set({ status: "EXPIRED", error: "Sessão expirada." })
      .where(
        and(
          eq(whatsappOnboardingSessions.tenantId, tenantId),
          eq(whatsappOnboardingSessions.id, session.id),
        ),
      );
    throw errors.validation("Sessão de onboarding expirada. Inicie novamente.");
  }

  const env = getEnv();
  const client = getEmbeddedSignupClient();

  try {
    const token = await client.exchangeCodeForToken({
      code: input.code,
      appId: env.META_APP_ID ?? "",
      appSecret: env.META_APP_SECRET ?? "",
    });

    const waba = await client.fetchWaba({
      accessToken: token.accessToken,
      wabaId: input.wabaId,
    });

    const numbers = await client.fetchPhoneNumbers({
      accessToken: token.accessToken,
      wabaId: waba.wabaId,
    });
    const selected = selectPhoneNumber(numbers, input.phoneNumberId);
    if (!selected) {
      throw errors.validation("Nenhum número de telefone disponível nesta WABA.");
    }

    // Coexistência: habilitada apenas quando o modo pede e a Meta confirma.
    let coexistenceEnabled = session.mode === "COEXISTENCE";
    if (session.mode === "COEXISTENCE") {
      const features = await client.fetchCoexistenceFeatures({
        accessToken: token.accessToken,
        phoneNumberId: selected.phoneNumberId,
      });
      coexistenceEnabled = features.isCoexistenceEnabled ?? true;
    }

    const businessId = input.businessId ?? session.businessId ?? undefined;

    const payload = connectAccountSchema.parse({
      wabaId: waba.wabaId,
      phoneNumberId: selected.phoneNumberId,
      displayPhoneNumber: selected.displayPhoneNumber,
      accessToken: token.accessToken,
      businessId,
      onboardingMode: session.mode === "COEXISTENCE" ? "COEXISTENCE" : "EMBEDDED_SIGNUP",
      coexistenceEnabled,
    });
    const connection = await connectAccount(tenantId, payload);

    await db
      .update(whatsappOnboardingSessions)
      .set({
        status: "COMPLETED",
        wabaId: waba.wabaId,
        phoneNumberId: selected.phoneNumberId,
        businessId: businessId ?? null,
        whatsappAccountId: connection.id,
        completedAt: nowMs(),
        error: null,
      })
      .where(
        and(
          eq(whatsappOnboardingSessions.tenantId, tenantId),
          eq(whatsappOnboardingSessions.id, session.id),
        ),
      );

    return {
      session: await getOnboardingSession(tenantId, session.id),
      connection,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido no onboarding";
    try {
      await db
        .update(whatsappOnboardingSessions)
        .set({ status: "FAILED", error: message.slice(0, 2000) })
        .where(
          and(
            eq(whatsappOnboardingSessions.tenantId, tenantId),
            eq(whatsappOnboardingSessions.id, session.id),
          ),
        );
    } catch {
      // A sessão permanece PENDING para uma nova tentativa.
    }
    throw error;
  }
}
