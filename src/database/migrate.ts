import { migrate } from "drizzle-orm/libsql/migrator";

import { getEnv } from "../config/env.js";
import { getDb } from "./client.js";

/**
 * Aplica as migrations versionadas de `drizzle/` no banco Turso/libSQL.
 * Uso: `npm run db:migrate`.
 */

// Carrega .env para os scripts standalone.
try {
  process.loadEnvFile?.();
} catch {
  // Sem .env: usa variáveis do processo.
}

async function main(): Promise<void> {
  const { DATABASE_URL } = getEnv();
  console.log(`Aplicando migrations em "${DATABASE_URL}" ...`);

  const db = getDb();
  await migrate(db, { migrationsFolder: "drizzle" });

  console.log("Migrations aplicadas com sucesso.");
}

main().catch((error: unknown) => {
  console.error("Falha ao aplicar migrations:", error);
  process.exitCode = 1;
});
