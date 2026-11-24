# syntax=docker/dockerfile:1
#
# Imagem de produção da API WhatsApp do Odonto Class (Fastify + libSQL/Turso).
#
# A MESMA imagem executa tanto o servidor HTTP quanto o worker de disparo.
# O papel é definido pelo comando do serviço:
#   - API HTTP : node dist/server.js            (padrão, CMD abaixo)
#   - Worker   : node dist/workers/run-all.js   (sobrescreva o comando no serviço)
#
# Migrações NÃO rodam no boot: aplique-as uma única vez, como passo de
# release, com `node dist/database/migrate.js` apontando para o Turso remoto.
# (Rodar migração em cada réplica pode causar corrida entre instâncias.)

# ─── Estágio 1: build (compila o TypeScript) ────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build

# ─── Estágio 2: dependências de produção ────────────────────────────────────
FROM node:22-alpine AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ─── Estágio 3: runtime ─────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Usuário sem privilégios.
RUN addgroup -S app && adduser -S app -G app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/dist          ./dist
COPY --from=build     /app/drizzle       ./drizzle
COPY package.json ./

USER app
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
