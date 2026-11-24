# Homologação Meta WhatsApp — API Odonto Class (Web Plus)

Runbook operacional para levar a API WhatsApp do Odonto Class de um ambiente
local (SQLite) até a **homologação real com a Meta** e a conexão do primeiro
número WhatsApp Business.

> Escopo: infraestrutura (Turso Cloud + hospedagem + worker + webhook + Meta).
> Nada aqui deve ser executado em produção sem autorização explícita.

---

## 1. Arquitetura alvo

```
Meta Cloud API  ──HTTPS──▶  API (Fastify)  ──▶  Turso (libSQL)
      ▲                         │
      │                         ├── /webhooks/meta   (público, HMAC-SHA256)
      │                         ├── /api/v1/*        (x-api-key, multi-tenant)
      │                         └── /health/live | /health/ready
      │
      └── envio ──  Worker (dispatcher + recovery)  ──▶  Turso (fila message_jobs)
```

- **API** e **Worker** são o **mesmo artefato** (`Dockerfile`), com comandos
  diferentes. Escalam de forma independente.
- **Worker nunca em serverless** (Vercel). Precisa de processo persistente.
- Banco: **Turso Cloud** (libSQL remoto) para staging/produção.

---

## 2. Ambientes e credenciais (separação obrigatória)

| Ambiente | `NODE_ENV` | Banco | Provedor WhatsApp | Segredos |
|---|---|---|---|---|
| Desenvolvimento | `development` | `file:./.local/dev.db` | teste (simulado) | locais |
| Testes | `test` | `file:` (efêmero) | teste (simulado) | locais |
| Homologação | `staging` | Turso `odontoclass-api-staging` | **real** (ou `WHATSAPP_PROVIDER=test` p/ simular) | próprios de staging |
| Produção | `production` | Turso `odontoclass-api` | real | próprios de produção |

Em `staging`/`production` a aplicação se comporta como implantada: provedor
**real** da Meta (a menos que `WHATSAPP_PROVIDER=test` seja definido
explicitamente), logs em **JSON**, sem stack traces nas respostas e `seed`
desabilitado.

**Nunca** reutilize entre ambientes: `META_APP_SECRET`, `ENCRYPTION_KEY`,
`API_KEY_PEPPER`, `INTERNAL_WORKER_TOKEN`, `EVENTS_SIGNING_SECRET` ou banco.

Variáveis obrigatórias (ver `.env.example` para a lista completa):

- `DATABASE_URL`, `DATABASE_AUTH_TOKEN`
- `API_KEY_PEPPER`, `ENCRYPTION_KEY`, `INTERNAL_WORKER_TOKEN`
- `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`
- `META_WEBHOOK_VERIFY_TOKEN`
- `META_GRAPH_API_VERSION` (default `v27.0`)

---

## 3. Turso Cloud

> **BLOQUEIO ATUAL:** não há CLI `turso` nem token (`TURSO_API_TOKEN`) no
> ambiente, e ambos os projetos ainda apontam para SQLite local. Os comandos
> abaixo exigem credenciais e devem ser autorizados antes de executados.

```bash
# 1. Autenticar (uma vez).
turso auth login

# 2. Criar o banco de homogação (SEPARADO do de produção).
turso db create odontoclass-api-staging --region aws-sa-east-1

# 3. URL de conexão e token (guardar em cofre de segredos, nunca no repo).
turso db show odontoclass-api-staging --url
turso db tokens create odontoclass-api-staging

# 4. Aplicar as migrations versionadas (4 arquivos em drizzle/).
DATABASE_URL="libsql://odontoclass-api-staging-<org>.turso.io" \
DATABASE_AUTH_TOKEN="<token>" \
npm run db:migrate

# 5. Conferir schema (deve resultar em 22 tabelas / 65 índices).
turso db shell odontoclass-api-staging ".tables"
```

Regras:
- **Não** modificar o banco `sistema-de-treino` nem `odontoclass-api` (produção).
- Migrations são **idempotentes**, mas aplicá-las uma vez, como passo de
  release (não no boot de cada réplica, para evitar corrida).
- **Nunca** copiar dados reais de pacientes para staging — usar o `seed` de
  desenvolvimento ou dados sintéticos.
- Resultado esperado: `22 tabelas`, `65 índices`, 4 migrations na tabela
  `__drizzle_migrations`.

---

## 4. Hospedagem da API

### Opções (execução persistente)

| Opção | Custo aprox. | Prós | Contras |
|---|---|---|---|
| **Railway** | ~US$ 5/mês (Hobby) + uso | Deploy por Dockerfile, logs, secrets, 2 serviços no mesmo repo | Custos por uso |
| **Render** | ~US$ 7/mês (Web) + Worker | Web Service + Background Worker nativos (ideal p/ fila) | Free tier dorme |
| **VPS + Docker** | ~US$ 5/mês | Controle total, custo fixo | Manutenção/segurança por conta própria |

Recomendação: **Render** (Web Service + Background Worker separados) ou
**Railway** (dois serviços do mesmo repositório).

### Passos (Railway — exemplo)

1. Criar projeto e conectar o repositório da API (build via `Dockerfile`).
2. Criar **serviço API**: comando padrão `node dist/server.js`; healthcheck
   `/health/live`; definir as variáveis de ambiente de staging.
3. Criar **serviço Worker**: mesma imagem, comando
   `node dist/workers/run-all.js`; **sem** porta pública.
4. Configurar o **release command**: `node dist/database/migrate.js`
   (aplica migrations antes de subir a nova versão).
5. Domínio HTTPS automático → usar como base do webhook.

### Requisitos atendidos pela aplicação

- **Health checks:** `GET /health/live` (liveness, inclui `env`) e
  `GET /health/ready` (readiness, verifica o banco).
- **HTTPS:** fornecido pela plataforma (Railway/Render) ou proxy reverso na VPS.
- **Logs estruturados:** Pino em JSON fora de `development`, com `redact` de
  `x-api-key`/`authorization`/tokens/segredos.
- **Encerramento gracioso:** `SIGTERM`/`SIGINT` → `app.close()`.
- **Reinício automático:** política de restart da plataforma.
- **Identificação do ambiente:** `env` exposto em `/health/live` e base do
  logger (`service: odonto-class-whatsapp-api`).
- **Controle de conexões:** rate limiting global (600 req/min por credencial/IP).
- **Imagem:** multi-stage, usuário não-root, `HEALTHCHECK` embutido.

> **AÇÃO NECESSÁRIA (release):** o `.gitignore` atual da API ignora
> `drizzle/*.sql`. Se o deploy for feito a partir do Git, os SQL de migration
> **não** subirão e `db:migrate` falhará. Remover essa linha do `.gitignore`
> (ou versionar `drizzle/*.sql`) antes do primeiro deploy via Git.

---

## 5. Worker e Dispatcher

- Entrypoint combinado: `node dist/workers/run-all.js` (dispatcher + recovery).
- Inicialização **independente** da API HTTP.
- Persistência da fila em `message_jobs` (Turso) — sobrevive a reinícios.
- **Leases atômicos:** `UPDATE ... WHERE status IN (PENDING, lease expirado)`
  + checagem de `rowsAffected`. Duas instâncias disputando o mesmo job →
  **apenas uma** processa (validado por teste automatizado).
- **Backoff** exponencial (`1s * 2^attempts` + jitter de 500ms), `maxAttempts=5`.
- **Dead-letter** após esgotar tentativas (`DEAD_LETTER`).
- **Campanhas pausadas/canceladas** não são despachadas.
- **Recovery:** reprocessa `webhook_events` pendentes.
- Sem scheduler externo: o agendamento usa `message_jobs.nextAttemptAt`,
  polido pelo próprio dispatcher.

Verificação (provider simulado, sem envio real):

```bash
npm test -- dispatcher.concurrency   # duas instâncias disputando o mesmo job
```

---

## 6. Webhook Meta

- URL pública: `https://<host-da-api>/webhooks/meta`
- **GET** (verificação): responde `hub.challenge` em `text/plain` quando
  `hub.verify_token === META_WEBHOOK_VERIFY_TOKEN` (comparação timing-safe).
- **POST** (eventos): exige header `X-Hub-Signature-256` (HMAC-SHA256 do corpo
  bruto com `META_APP_SECRET`). Sem assinatura válida → **401**.
- Persistência **durável antes** do ACK (200) → deduplicação por `eventKey`.
- Associação do evento ao tenant por `phone_number_id`.
- Processamento de negócio **assíncrono** após o ACK.

> Se `META_APP_SECRET` real não estiver disponível, o POST responde 401 —
> comportamento **correto**. Registrar como pendência até ter o secret oficial.

---

## 7. Checklist — Configuração na Meta

> Não criar apps duplicados. Não considerar nada "aprovado" sem evidência no
> painel. Cada item exige ação administrativa no Meta for Developers.

- [ ] App **Web Plus** criado em <https://developers.facebook.com/apps>.
- [ ] Produto **WhatsApp Business Platform** adicionado ao app.
- [ ] **Business Verification** da empresa concluída (obrigatório p/ produção).
- [ ] **Tech Provider** habilitado (necessário para onboarding de clientes).
- [ ] **Advanced Access** solicitado para as permissões de mensageria
      (`whatsapp_business_messaging`, `whatsapp_business_management`).
- [ ] **Embedded Signup** configurado (Flow/Configuration ID).
- [ ] Anotar **App ID** → `META_APP_ID`.
- [ ] Anotar **App Secret** → `META_APP_SECRET` (cofre de segredos).
- [ ] Anotar **Configuration ID** → `META_EMBEDDED_SIGNUP_CONFIG_ID`.
- [ ] **Webhook** configurado: URL `https://<host>/webhooks/meta`,
      Verify Token = `META_WEBHOOK_VERIFY_TOKEN`, assinado pelo App Secret.
- [ ] Assinar os campos de webhook: `messages`, `message_template_status_update`,
      `message_template_quality_update` (e demais pertinentes).
- [ ] Anotar **WABA ID** → `META_WABA_ID`.
- [ ] Confirmar o **Phone Number ID** do número de homologação.

---

## 8. Faturamento direto (Opção A)

- A **clínica** paga o consumo das próprias mensagens **diretamente à Meta**.
- A **Web Plus** cobra apenas o uso do CRM — **não** é intermediária de créditos.
- O estado de validação por conta fica em `whatsapp_accounts.billing_mode`
  (`UNVERIFIED` → `DIRECT`) e `billing_status`.
- Orçamentos/alertas: `whatsapp_budgets`, custos estimados em
  `whatsapp_message_costs`.

Não configurar a Web Plus como responsável pelo pagamento das mensagens das
clínicas. Não ativar envio real sem confirmar o modelo comercial.

---

## 9. Procedimento — conectar o primeiro número real

> **NÃO executar sem autorização explícita.** `WHATSAPP_PROVIDER` **não** deve
> ser alterado para `meta` automaticamente.

1. **Conta autorizada:** garantir que a clínica piloto autorizou o teste e que
   possui método de pagamento válido na Meta.
2. **Configuração Meta:** confirmar App, WABA, Phone Number ID e permissões
   (seção 7).
3. **Faturamento:** confirmar a modalidade da conta (Opção A) na Meta.
4. **Webhook:** validar GET de verificação e um POST de teste assinado.
5. **Número conectado:** confirmar `phone_number_id` e status `CONNECTED`.
6. **Mensagem de teste autorizada:** enviar para um número sob controle (nunca
   para um paciente real sem consentimento).
7. **Resposta:** responder pelo WhatsApp e confirmar a chegada do inbound.
8. **Persistência:** conferir `messages`, `message_jobs`, `webhook_events` no
   Turso (staging) — nada em produção.
9. **CRM:** abrir a conversa no Atendimento e confirmar atualização em tempo
   real (SSE).
10. **Estados de entrega:** acompanhar `SENT` → `DELIVERED` → `READ`.

Antes de qualquer envio real, rodar tudo com `WHATSAPP_PROVIDER=test` e por
último trocar apenas no serviço de staging, com rollback preparado.

---

## 10. Pendências e bloqueios externos

- **Turso:** CLI/token ausentes → criação do banco de staging não executada.
- **Meta:** App ID, App Secret, Configuration ID, WABA, Phone Number ID e
  Business Verification não disponíveis → webhook real retorna 401 (correto).
- **Credenciais de hospedagem:** nenhuma plataforma conectada; deploy não
  realizado (requer autorização e possível custo).
- **Git:** `.gitignore` da API ignora `drizzle/*.sql` (ver §4).
