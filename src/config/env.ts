import { z } from "zod";

/**
 * Validação de variáveis de ambiente.
 * Validação EAGER na inicialização: a API deve falhar explicitamente se
 * mal configurada (seção 6 do spec).
 */

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Banco
  DATABASE_URL: z.string().min(1),
  DATABASE_AUTH_TOKEN: z.string().optional(),

  // Meta
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v27.0"),
  META_ACCESS_TOKEN: z.string().optional(),
  META_PHONE_NUMBER_ID: z.string().optional(),
  META_WABA_ID: z.string().optional(),
  // App ID/Secret do app da Meta: necessários para o Embedded Signup real.
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  // Configuração de Embedded Signup (criada no painel da Meta) devolvida ao SDK.
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

  // Segurança
  API_KEY_PEPPER: z.string().min(8),
  ENCRYPTION_KEY: z.string().min(16),
  INTERNAL_WORKER_TOKEN: z.string().min(8),
  // Segredo usado para assinar os eventos do canal em tempo real (SSE).
  // Se ausente, usa o token interno do worker (servidor-a-servidor).
  EVENTS_SIGNING_SECRET: z.string().min(8).optional(),

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * `true` apenas em ambientes locais (development/test).
 *
 * Em `staging` e `production` o comportamento é de ambiente implantado:
 * provedor real da Meta (a menos que `WHATSAPP_PROVIDER=test` seja explícito),
 * logs em JSON, sem stack traces nas respostas e seed desabilitado.
 */
export function isLocalEnv(env: Env): boolean {
  return env.NODE_ENV === "development" || env.NODE_ENV === "test";
}

/** `true` em ambientes implantados (staging/production). */
export function isDeployedEnv(env: Env): boolean {
  return !isLocalEnv(env);
}

let cached: Env | null = null;

/** Lê, valida e cacheia as variáveis de ambiente. */
export function getEnv(): Env {
  if (cached) return cached;

  // Carrega .env em ambientes locais (Node >= 20.12).
  try {
    process.loadEnvFile?.();
  } catch {
    // Sem arquivo .env: segue com variáveis do processo.
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Variáveis de ambiente inválidas: ${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** Reseta o cache (uso em testes). */
export function resetEnvCache(): void {
  cached = null;
}
