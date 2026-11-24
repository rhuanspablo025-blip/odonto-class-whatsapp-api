import { sql } from "drizzle-orm";
import { integer } from "drizzle-orm/sqlite-core";

/**
 * Builders de colunas compartilhadas.
 * Timestamps armazenados como INTEGER (milissegundos).
 *
 * IMPORTANTE: defaults usam expressões SQL puras (sem interpolação de valores
 * JS), porque o drizzle-kit não suporta parâmetros em `sql` default.
 */

/** Coluna `created_at` preenchida automaticamente na inserção (ms). */
export function createdAtCol() {
  return integer("created_at")
    .notNull()
    .default(sql`(strftime('%s', 'now') * 1000)`);
}

/** Coluna `updated_at` preenchida na inserção e atualizações (ms). */
export function updatedAtCol() {
  return integer("updated_at")
    .notNull()
    .default(sql`(strftime('%s', 'now') * 1000)`)
    .$onUpdateFn(() => Date.now());
}
