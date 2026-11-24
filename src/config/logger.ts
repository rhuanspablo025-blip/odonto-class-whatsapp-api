import pino from "pino";

import { getEnv, isDeployedEnv } from "./env.js";

/**
 * Logger estruturado Pino. Em desenvolvimento usa pretty-print;
 * em produção usa JSON puro.
 */
const env = getEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    isDeployedEnv(env)
      ? undefined
      : {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:dd/mm/yyyy HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
  base: { service: "odonto-class-whatsapp-api" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-api-key']",
      "res.headers['set-cookie']",
      "*.access_token",
      "*.password",
      "*.passwordHash",
      "*.apiKey",
      "*.api_key",
      "*.secret",
      "*.token",
      "*.credentials",
      "*.encryptedCredentials",
    ],
    censor: "***REDACTED***",
  },
});

export type Logger = typeof logger;
