CREATE TABLE `api_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `api_clients_tenant_idx` ON `api_clients` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_clients_key_hash_idx` ON `api_clients` (`key_hash`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`actor_id` text,
	`action` text NOT NULL,
	`resource` text NOT NULL,
	`resource_id` text,
	`metadata` text,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_tenant_idx` ON `audit_logs` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `audit_resource_idx` ON `audit_logs` (`tenant_id`,`resource`,`resource_id`);--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`trigger_event` text NOT NULL,
	`payload` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_automation_idx` ON `automation_runs` (`automation_id`);--> statement-breakpoint
CREATE INDEX `runs_tenant_idx` ON `automation_runs` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`trigger_type` text NOT NULL,
	`conditions` text,
	`actions` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`run_limit` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automations_tenant_idx` ON `automations` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `automations_trigger_idx` ON `automations` (`tenant_id`,`trigger_type`,`enabled`);--> statement-breakpoint
CREATE TABLE `campaign_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`message_id` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recipients_campaign_idx` ON `campaign_recipients` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `recipients_tenant_idx` ON `campaign_recipients` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`template_id` text,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`scheduled_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaigns_tenant_idx` ON `campaigns` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `campaigns_status_idx` ON `campaigns` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `consents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`purpose` text NOT NULL,
	`channel` text NOT NULL,
	`status` text NOT NULL,
	`source` text,
	`evidence_reference` text,
	`granted_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `consents_contact_idx` ON `consents` (`contact_id`);--> statement-breakpoint
CREATE INDEX `consents_tenant_idx` ON `consents` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `consents_unique_purpose` ON `consents` (`tenant_id`,`contact_id`,`purpose`,`channel`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`external_id` text,
	`name` text NOT NULL,
	`phone_e164` text NOT NULL,
	`email` text,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contacts_tenant_idx` ON `contacts` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_phone_idx` ON `contacts` (`tenant_id`,`phone_e164`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_external_idx` ON `contacts` (`tenant_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`whatsapp_account_id` text,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`last_message_at` integer,
	`customer_service_window_expires_at` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`whatsapp_account_id`) REFERENCES `whatsapp_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversations_tenant_idx` ON `conversations` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `conversations_contact_idx` ON `conversations` (`contact_id`);--> statement-breakpoint
CREATE INDEX `conversations_status_idx` ON `conversations` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `message_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`message_id` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_tenant_idx` ON `message_jobs` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `message_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `jobs_lease_idx` ON `message_jobs` (`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`direction` text NOT NULL,
	`type` text DEFAULT 'TEXT' NOT NULL,
	`content` text,
	`template_id` text,
	`provider_message_id` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`error_code` text,
	`error_message` text,
	`idempotency_key` text,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	`sent_at` integer,
	`delivered_at` integer,
	`read_at` integer,
	`failed_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conv_idx` ON `messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `messages_tenant_idx` ON `messages` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_provider_idx` ON `messages` (`tenant_id`,`provider_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_idem_idx` ON `messages` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `messages_status_idx` ON `messages` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`whatsapp_account_id` text,
	`name` text NOT NULL,
	`language` text DEFAULT 'pt_BR' NOT NULL,
	`category` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`components` text,
	`synced_at` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`whatsapp_account_id`) REFERENCES `whatsapp_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `templates_tenant_idx` ON `templates` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `templates_name_idx` ON `templates` (`tenant_id`,`name`,`language`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`timezone` text DEFAULT 'America/Sao_Paulo' NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_idx` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'META' NOT NULL,
	`event_key` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `webhook_event_key_idx` ON `webhook_events` (`event_key`);--> statement-breakpoint
CREATE INDEX `webhook_status_idx` ON `webhook_events` (`status`);--> statement-breakpoint
CREATE TABLE `whatsapp_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`phone_number_id` text NOT NULL,
	`waba_id` text NOT NULL,
	`display_phone_number` text,
	`status` text DEFAULT 'CONNECTED' NOT NULL,
	`encrypted_credentials` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wa_accounts_tenant_idx` ON `whatsapp_accounts` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `wa_accounts_phone_idx` ON `whatsapp_accounts` (`tenant_id`,`phone_number_id`);