import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { getEnv } from "../config/env.js";
import * as schema from "./schema/index.js";

/**
 * Cliente libSQL + Drizzle (Turso).
 * Singleton em `globalThis` para evitar múltiplas conexões em dev/HMR.
 */

export type Database = LibSQLDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __whatsappApiDb?: Database };

export function getDb(): Database {
  if (globalForDb.__whatsappApiDb) return globalForDb.__whatsappApiDb;

  const env = getEnv();
  const client = createClient({
    url: env.DATABASE_URL,
    authToken: env.DATABASE_AUTH_TOKEN,
  });

  const db = drizzle(client, { schema });
  globalForDb.__whatsappApiDb = db;
  return db;
}
