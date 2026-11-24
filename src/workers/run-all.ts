/**
 * Entry point que executa todos os workers em um único processo.
 * Útil para desenvolvimento. Em produção, cada worker roda separadamente.
 */
import { startDispatcher } from "./dispatcher.js";
import { startRecovery } from "./recovery.js";

async function main() {
  console.log("[workers] Iniciando todos os workers...");
  await Promise.all([startDispatcher(), startRecovery()]);
}

main().catch((error) => {
  console.error("[workers] Falha fatal:", error);
  process.exit(1);
});
