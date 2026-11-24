import { createApp } from "./app.js";
import { getEnv } from "./config/env.js";

/**
 * Ponto de entrada do servidor HTTP.
 */
const env = getEnv();
const app = createApp();

async function start() {
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`Servidor rodando em http://localhost:${env.PORT}`);
  } catch (error) {
    app.log.error({ err: error }, "Falha ao iniciar o servidor.");
    process.exit(1);
  }
}

// Encerramento gracioso.
const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Encerrando servidor...");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start();
