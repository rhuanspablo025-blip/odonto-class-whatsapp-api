import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";

import { getDb } from "../../database/client.js";
import { apiClients, tenants } from "../../database/schema/index.js";
import { errors } from "../../lib/errors.js";
import { hashApiKey, safeEqual } from "../../config/security.js";

/**
 * Autenticação de API clients e resolução de tenant.
 *
 * Regra fundamental (seção 8): o NUNCA aceita tenant_id informado pelo cliente
 * como prova de autorização. O tenant é SEMPRE derivado da credencial.
 */

export interface AuthContext {
  tenantId: string;
  tenantSlug: string;
  clientId: string;
  permissions: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** Extrai a API key do header `x-api-key` ou `Authorization: Bearer`. */
function extractApiKey(request: FastifyRequest): string | null {
  const header = request.headers["x-api-key"] as string | undefined;
  if (header) return header;

  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();

  return null;
}

/** Middleware de autenticação. */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
  const rawKey = extractApiKey(request);
  if (!rawKey) throw errors.authentication();

  const keyHash = hashApiKey(rawKey);
  const db = getDb();

  const [client] = await db
    .select({
      id: apiClients.id,
      tenantId: apiClients.tenantId,
      permissions: apiClients.permissions,
      revokedAt: apiClients.revokedAt,
      expiresAt: apiClients.expiresAt,
      keyHash: apiClients.keyHash,
    })
    .from(apiClients)
    .where(eq(apiClients.keyHash, keyHash))
    .limit(1);

  if (!client) throw errors.authentication();

  // Comparação em tempo constante (defesa em profundidade).
  if (!safeEqual(client.keyHash, keyHash)) throw errors.authentication();

  if (client.revokedAt) throw errors.authentication("Credencial revogada.");
  if (client.expiresAt && client.expiresAt < Date.now()) {
    throw errors.authentication("Credencial expirada.");
  }

  const [tenant] = await db
    .select({ id: tenants.id, slug: tenants.slug, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, client.tenantId))
    .limit(1);

  if (!tenant || tenant.status !== "ACTIVE") {
    throw errors.authentication("Tenant inativo ou inexistente.");
  }

  // Atualiza last_used_at de forma não-bloqueante.
  db.update(apiClients)
    .set({ lastUsedAt: Date.now() })
    .where(eq(apiClients.id, client.id))
    .catch(() => undefined);

  request.auth = {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    clientId: client.id,
    permissions: client.permissions as string[],
  };
}

/** Verifica se o client possui a permissão exigida. */
export function requirePermission(permission: string) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const perms = request.auth?.permissions ?? [];
    if (perms.includes("admin:manage") || perms.includes(permission)) return;
    throw errors.authorization();
  };
}

/** Helper para obter o contexto de autenticação (garante que existe). */
export function getAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw errors.authentication();
  return request.auth;
}
