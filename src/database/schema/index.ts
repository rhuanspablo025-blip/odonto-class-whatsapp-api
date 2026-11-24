import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { newId } from "../../lib/ids.js";
import { createdAtCol, updatedAtCol } from "./columns.js";

/**
 * Schema completo da API WhatsApp.
 * Multi-tenant: todas as tabelas de negócio possuem `tenant_id` com FK para
 * `tenants.id`. As FKs compostas (tenant_id + resource_id) garantem que
 * referências cruzadas entre clínicas sejam impossíveis no banco.
 */

// ───────────────────────────────────────────────────────────────────────────
// TENANTS
// ───────────────────────────────────────────────────────────────────────────
export const tenants = sqliteTable(
  "tenants",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status", { enum: ["ACTIVE", "SUSPENDED", "DELETED"] })
      .notNull()
      .default("ACTIVE"),
    timezone: text("timezone").notNull().default("America/Sao_Paulo"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    slugIdx: uniqueIndex("tenants_slug_idx").on(t.slug),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// API_CLIENTS (credenciais de sistemas consumidores)
// ───────────────────────────────────────────────────────────────────────────
export const apiClients = sqliteTable(
  "api_clients",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    permissions: text("permissions", { mode: "json" }).notNull().default(sql`'[]'`),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    lastUsedAt: integer("last_used_at"),
    createdAt: createdAtCol(),
  },
  (t) => ({
    tenantIdx: index("api_clients_tenant_idx").on(t.tenantId),
    keyHashIdx: uniqueIndex("api_clients_key_hash_idx").on(t.keyHash),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// WHATSAPP_ACCOUNTS (conexões com a Meta por tenant)
// ───────────────────────────────────────────────────────────────────────────
export const whatsappAccounts = sqliteTable(
  "whatsapp_accounts",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    phoneNumberId: text("phone_number_id").notNull(),
    wabaId: text("waba_id").notNull(),
    displayPhoneNumber: text("display_phone_number"),
    status: text("status", { enum: ["CONNECTED", "DISCONNECTED", "REVOKED"] })
      .notNull()
      .default("CONNECTED"),
    encryptedCredentials: text("encrypted_credentials").notNull(),
    // Onboarding: como a conta foi conectada (manual, Embedded Signup ou coexistência).
    onboardingMode: text("onboarding_mode", {
      enum: ["CLOUD_API", "EMBEDDED_SIGNUP", "COEXISTENCE"],
    })
      .notNull()
      .default("CLOUD_API"),
    coexistenceEnabled: integer("coexistence_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    businessId: text("business_id"),
    // Faturamento (Opção A: a clínica paga diretamente à Meta).
    // `DIRECT` indica que a modalidade foi validada; `UNVERIFIED` é o estado inicial.
    billingMode: text("billing_mode", { enum: ["DIRECT", "UNVERIFIED"] })
      .notNull()
      .default("UNVERIFIED"),
    billingStatus: text("billing_status", {
      enum: ["UNKNOWN", "PENDING", "VERIFIED", "REJECTED"],
    })
      .notNull()
      .default("UNKNOWN"),
    billingVerifiedAt: integer("billing_verified_at"),
    connectionMetadata: text("connection_metadata", { mode: "json" }),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    tenantIdx: index("wa_accounts_tenant_idx").on(t.tenantId),
    phoneIdx: uniqueIndex("wa_accounts_phone_idx").on(t.phoneNumberId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// CONTACTS
// ───────────────────────────────────────────────────────────────────────────
export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    name: text("name").notNull(),
    phoneE164: text("phone_e164").notNull(),
    email: text("email"),
    status: text("status", { enum: ["ACTIVE", "OPTED_OUT", "DELETED"] })
      .notNull()
      .default("ACTIVE"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    tenantIdx: index("contacts_tenant_idx").on(t.tenantId),
    phoneIdx: uniqueIndex("contacts_phone_idx").on(t.tenantId, t.phoneE164),
    externalIdx: uniqueIndex("contacts_external_idx").on(t.tenantId, t.externalId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// CONSENTS
// ───────────────────────────────────────────────────────────────────────────
export const consents = sqliteTable(
  "consents",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    channel: text("channel", { enum: ["WHATSAPP", "SMS", "EMAIL"] }).notNull(),
    status: text("status", { enum: ["GRANTED", "REVOKED"] }).notNull(),
    source: text("source"),
    evidenceReference: text("evidence_reference"),
    grantedAt: integer("granted_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (t) => ({
    contactIdx: index("consents_contact_idx").on(t.contactId),
    tenantIdx: index("consents_tenant_idx").on(t.tenantId),
    uniquePurpose: uniqueIndex("consents_unique_purpose").on(
      t.tenantId,
      t.contactId,
      t.purpose,
      t.channel,
    ),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// CONVERSATIONS
// ───────────────────────────────────────────────────────────────────────────
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    whatsappAccountId: text("whatsapp_account_id").references(
      () => whatsappAccounts.id,
    ),
    status: text("status", {
      enum: ["OPEN", "CLOSED", "TRANSFERRED"],
    })
      .notNull()
      .default("OPEN"),
    lastMessageAt: integer("last_message_at"),
    customerServiceWindowExpiresAt: integer("customer_service_window_expires_at"),
    // Atribuição de atendimento (Fase 6). `assigned_user_id` é o identificador
    // do atendente no CRM; a API o trata como opaco e apenas o persiste.
    assignedUserId: text("assigned_user_id"),
    assignedUserName: text("assigned_user_name"),
    assignedAt: integer("assigned_at"),
    // Contador de mensagens recebidas ainda não lidas pelo atendimento.
    unreadCount: integer("unread_count").notNull().default(0),
    lastReadAt: integer("last_read_at"),
    closedAt: integer("closed_at"),
    createdAt: createdAtCol(),
  },
  (t) => ({
    tenantIdx: index("conversations_tenant_idx").on(t.tenantId),
    contactIdx: index("conversations_contact_idx").on(t.contactId),
    statusIdx: index("conversations_status_idx").on(t.tenantId, t.status),
    assignedIdx: index("conversations_assigned_idx").on(t.tenantId, t.assignedUserId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// MESSAGES
// ───────────────────────────────────────────────────────────────────────────
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["INBOUND", "OUTBOUND"] }).notNull(),
    type: text("type", {
      enum: ["TEXT", "TEMPLATE", "IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "LOCATION"],
    })
      .notNull()
      .default("TEXT"),
    content: text("content", { mode: "json" }),
    templateId: text("template_id"),
    providerMessageId: text("provider_message_id"),
    status: text("status", {
      enum: [
        "PENDING",
        "QUEUED",
        "SENT",
        "DELIVERED",
        "READ",
        "FAILED",
        "CANCELLED",
      ],
    })
      .notNull()
      .default("PENDING"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAtCol(),
    sentAt: integer("sent_at"),
    deliveredAt: integer("delivered_at"),
    readAt: integer("read_at"),
    failedAt: integer("failed_at"),
  },
  (t) => ({
    convIdx: index("messages_conv_idx").on(t.conversationId),
    tenantIdx: index("messages_tenant_idx").on(t.tenantId),
    providerIdx: uniqueIndex("messages_provider_idx").on(t.tenantId, t.providerMessageId),
    idemIdx: uniqueIndex("messages_idem_idx").on(t.tenantId, t.idempotencyKey),
    statusIdx: index("messages_status_idx").on(t.tenantId, t.status),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// MESSAGE_JOBS (fila persistente)
// ───────────────────────────────────────────────────────────────────────────
export const messageJobs = sqliteTable(
  "message_jobs",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    scheduledAt: integer("scheduled_at").notNull(),
    status: text("status", {
      enum: ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED", "DEAD_LETTER"],
    })
      .notNull()
      .default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    lastError: text("last_error"),
    createdAt: createdAtCol(),
  },
  (t) => ({
    tenantIdx: index("jobs_tenant_idx").on(t.tenantId),
    statusIdx: index("jobs_status_idx").on(t.status, t.nextAttemptAt),
    leaseIdx: index("jobs_lease_idx").on(t.leaseExpiresAt),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// CAMPAIGNS
// ───────────────────────────────────────────────────────────────────────────
export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    templateId: text("template_id"),
    status: text("status", {
      enum: ["DRAFT", "SCHEDULED", "RUNNING", "PAUSED", "COMPLETED", "CANCELLED", "FAILED"],
    })
      .notNull()
      .default("DRAFT"),
    scheduledAt: integer("scheduled_at"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    tenantIdx: index("campaigns_tenant_idx").on(t.tenantId),
    statusIdx: index("campaigns_status_idx").on(t.tenantId, t.status),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// CAMPAIGN_RECIPIENTS
// ───────────────────────────────────────────────────────────────────────────
export const campaignRecipients = sqliteTable(
  "campaign_recipients",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id),
    status: text("status", {
      enum: ["PENDING", "SENT", "DELIVERED", "READ", "FAILED", "SKIPPED"],
    })
      .notNull()
      .default("PENDING"),
    error: text("error"),
    createdAt: createdAtCol(),
  },
  (t) => ({
    campaignIdx: index("recipients_campaign_idx").on(t.campaignId),
    tenantIdx: index("recipients_tenant_idx").on(t.tenantId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// TEMPLATES (cache local dos templates aprovados pela Meta)
// ───────────────────────────────────────────────────────────────────────────
export const templates = sqliteTable(
  "templates",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    whatsappAccountId: text("whatsapp_account_id").references(
      () => whatsappAccounts.id,
    ),
    name: text("name").notNull(),
    language: text("language").notNull().default("pt_BR"),
    category: text("category", {
      enum: ["MARKETING", "UTILITY", "AUTHENTICATION"],
    }).notNull(),
    status: text("status", {
      enum: ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"],
    })
      .notNull()
      .default("PENDING"),
    components: text("components", { mode: "json" }),
    syncedAt: integer("synced_at"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    tenantIdx: index("templates_tenant_idx").on(t.tenantId),
    nameIdx: uniqueIndex("templates_name_idx").on(t.tenantId, t.name, t.language),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// AUTOMATIONS
// ───────────────────────────────────────────────────────────────────────────
export const automations = sqliteTable(
  "automations",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    triggerType: text("trigger_type").notNull(),
    conditions: text("conditions", { mode: "json" }),
    actions: text("actions", { mode: "json" }).notNull().default(sql`'[]'`),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    runLimit: integer("run_limit"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    tenantIdx: index("automations_tenant_idx").on(t.tenantId),
    triggerIdx: index("automations_trigger_idx").on(t.tenantId, t.triggerType, t.enabled),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// AUTOMATION_RUNS (log de execução)
// ───────────────────────────────────────────────────────────────────────────
export const automationRuns = sqliteTable(
  "automation_runs",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    automationId: text("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    triggerEvent: text("trigger_event").notNull(),
    payload: text("payload", { mode: "json" }),
    status: text("status", { enum: ["SUCCESS", "FAILED", "SKIPPED"] }).notNull(),
    error: text("error"),
    createdAt: createdAtCol(),
  },
  (t) => ({
    automationIdx: index("runs_automation_idx").on(t.automationId),
    tenantIdx: index("runs_tenant_idx").on(t.tenantId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// WEBHOOK_EVENTS
// ───────────────────────────────────────────────────────────────────────────
export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    provider: text("provider").notNull().default("META"),
    eventKey: text("event_key").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status", { enum: ["PENDING", "PROCESSED", "FAILED"] })
      .notNull()
      .default("PENDING"),
    receivedAt: integer("received_at").notNull(),
    processedAt: integer("processed_at"),
    error: text("error"),
  },
  (t) => ({
    eventKeyIdx: uniqueIndex("webhook_event_key_idx").on(t.eventKey),
    statusIdx: index("webhook_status_idx").on(t.status),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// EVENTS (log durável de eventos para o canal em tempo real)
// ───────────────────────────────────────────────────────────────────────────
export const events = sqliteTable(
  "events",
  {
    // `seq` é o cursor monotônico do stream: garante ordenação total mesmo
    // quando várias instâncias gravam eventos no mesmo milissegundo. O log é
    // durável, portanto sobrevive a quedas e a consultas de múltiplas instâncias.
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    conversationId: text("conversation_id"),
    messageId: text("message_id"),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: createdAtCol(),
  },
  (t) => ({
    tenantSeqIdx: index("events_tenant_seq_idx").on(t.tenantId, t.seq),
    typeIdx: index("events_type_idx").on(t.tenantId, t.type),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// AUDIT_LOGS
// ───────────────────────────────────────────────────────────────────────────
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    resource: text("resource").notNull(),
    resourceId: text("resource_id"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: createdAtCol(),
  },
  (t) => ({
    tenantIdx: index("audit_tenant_idx").on(t.tenantId),
    resourceIdx: index("audit_resource_idx").on(t.tenantId, t.resource, t.resourceId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// WHATSAPP_ONBOARDING_SESSIONS (fluxos de Embedded Signup / coexistência)
// ───────────────────────────────────────────────────────────────────────────
export const whatsappOnboardingSessions = sqliteTable(
  "whatsapp_onboarding_sessions",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // `state` é o valor anti-CSRF enviado ao SDK e devolvido no callback.
    state: text("state").notNull(),
    mode: text("mode", { enum: ["EMBEDDED_SIGNUP", "COEXISTENCE"] })
      .notNull()
      .default("EMBEDDED_SIGNUP"),
    status: text("status", {
      enum: ["PENDING", "COMPLETED", "FAILED", "EXPIRED"],
    })
      .notNull()
      .default("PENDING"),
    businessId: text("business_id"),
    wabaId: text("waba_id"),
    phoneNumberId: text("phone_number_id"),
    whatsappAccountId: text("whatsapp_account_id").references(
      () => whatsappAccounts.id,
      { onDelete: "set null" },
    ),
    error: text("error"),
    metadata: text("metadata", { mode: "json" }),
    expiresAt: integer("expires_at").notNull(),
    createdAt: createdAtCol(),
    completedAt: integer("completed_at"),
  },
  (t) => ({
    stateIdx: uniqueIndex("wa_onboarding_state_idx").on(t.state),
    tenantIdx: index("wa_onboarding_tenant_idx").on(t.tenantId, t.status),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// WHATSAPP_PRICING_RATES (tabela de preços por categoria/moeda)
// ───────────────────────────────────────────────────────────────────────────
export const whatsappPricingRates = sqliteTable(
  "whatsapp_pricing_rates",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    // `tenant_id` nulo representa o tarifário padrão (fallback) da plataforma.
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    category: text("category", {
      enum: ["MARKETING", "UTILITY", "AUTHENTICATION", "SERVICE"],
    }).notNull(),
    currency: text("currency").notNull().default("BRL"),
    // Valor em micro-unidades da moeda (1 BRL = 1_000_000 micro) para evitar float.
    amountMicros: integer("amount_micros").notNull(),
    effectiveFrom: integer("effective_from").notNull(),
    effectiveTo: integer("effective_to"),
    createdAt: createdAtCol(),
  },
  (t) => ({
    lookupIdx: index("wa_rates_lookup_idx").on(
      t.tenantId,
      t.category,
      t.currency,
      t.effectiveFrom,
    ),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// WHATSAPP_MESSAGE_COSTS (livro-razão financeiro por mensagem)
// ───────────────────────────────────────────────────────────────────────────
export const whatsappMessageCosts = sqliteTable(
  "whatsapp_message_costs",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    whatsappAccountId: text("whatsapp_account_id").references(
      () => whatsappAccounts.id,
      { onDelete: "set null" },
    ),
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    providerMessageId: text("provider_message_id").notNull(),
    category: text("category", {
      enum: ["MARKETING", "UTILITY", "AUTHENTICATION", "SERVICE", "UNKNOWN"],
    })
      .notNull()
      .default("UNKNOWN"),
    pricingModel: text("pricing_model"),
    billable: integer("billable", { mode: "boolean" }).notNull().default(false),
    currency: text("currency").notNull().default("BRL"),
    amountMicros: integer("amount_micros").notNull().default(0),
    // Origem do valor: `RATE_CARD` quando encontrado na tabela de preços.
    rateSource: text("rate_source", { enum: ["RATE_CARD", "UNKNOWN"] })
      .notNull()
      .default("UNKNOWN"),
    occurredAt: integer("occurred_at").notNull(),
    createdAt: createdAtCol(),
  },
  (t) => ({
    tenantIdx: index("wa_costs_tenant_idx").on(t.tenantId, t.occurredAt),
    dedupeIdx: uniqueIndex("wa_costs_provider_idx").on(
      t.tenantId,
      t.providerMessageId,
    ),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// WHATSAPP_BUDGETS (orçamento mensal por clínica)
// ───────────────────────────────────────────────────────────────────────────
export const whatsappBudgets = sqliteTable(
  "whatsapp_budgets",
  {
    id: text("id").primaryKey().$defaultFn(newId),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // Período no formato `YYYY-MM`.
    periodMonth: text("period_month").notNull(),
    currency: text("currency").notNull().default("BRL"),
    limitAmountMicros: integer("limit_amount_micros").notNull(),
    alertThresholdPercent: integer("alert_threshold_percent").notNull().default(80),
    // `MONITOR` apenas sinaliza; `BLOCK_MARKETING` impede novas campanhas de marketing.
    enforceMode: text("enforce_mode", { enum: ["MONITOR", "BLOCK_MARKETING"] })
      .notNull()
      .default("MONITOR"),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    periodIdx: uniqueIndex("wa_budgets_period_idx").on(t.tenantId, t.periodMonth),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// RELAÇÕES
// ───────────────────────────────────────────────────────────────────────────
export const tenantsRelations = relations(tenants, ({ many }) => ({
  apiClients: many(apiClients),
  whatsappAccounts: many(whatsappAccounts),
  contacts: many(contacts),
  conversations: many(conversations),
  messages: many(messages),
  campaigns: many(campaigns),
  automations: many(automations),
  auditLogs: many(auditLogs),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  tenant: one(tenants, { fields: [contacts.tenantId], references: [tenants.id] }),
  consents: many(consents),
  conversations: many(conversations),
  messages: many(messages),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  tenant: one(tenants, { fields: [conversations.tenantId], references: [tenants.id] }),
  contact: one(contacts, { fields: [conversations.contactId], references: [contacts.id] }),
  whatsappAccount: one(whatsappAccounts, {
    fields: [conversations.whatsappAccountId],
    references: [whatsappAccounts.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  tenant: one(tenants, { fields: [messages.tenantId], references: [tenants.id] }),
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  contact: one(contacts, { fields: [messages.contactId], references: [contacts.id] }),
  jobs: many(messageJobs),
}));

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  tenant: one(tenants, { fields: [campaigns.tenantId], references: [tenants.id] }),
  recipients: many(campaignRecipients),
}));

export const automationsRelations = relations(automations, ({ one, many }) => ({
  tenant: one(tenants, { fields: [automations.tenantId], references: [tenants.id] }),
  runs: many(automationRuns),
}));

export const schema = {
  tenants,
  apiClients,
  whatsappAccounts,
  contacts,
  consents,
  conversations,
  messages,
  messageJobs,
  campaigns,
  campaignRecipients,
  templates,
  automations,
  automationRuns,
  webhookEvents,
  auditLogs,
  events,
  whatsappOnboardingSessions,
  whatsappPricingRates,
  whatsappMessageCosts,
  whatsappBudgets,
};
