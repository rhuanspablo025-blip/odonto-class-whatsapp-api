CREATE TABLE `whatsapp_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`period_month` text NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`limit_amount_micros` integer NOT NULL,
	`alert_threshold_percent` integer DEFAULT 80 NOT NULL,
	`enforce_mode` text DEFAULT 'MONITOR' NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wa_budgets_period_idx` ON `whatsapp_budgets` (`tenant_id`,`period_month`);--> statement-breakpoint
CREATE TABLE `whatsapp_message_costs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`whatsapp_account_id` text,
	`message_id` text,
	`provider_message_id` text NOT NULL,
	`category` text DEFAULT 'UNKNOWN' NOT NULL,
	`pricing_model` text,
	`billable` integer DEFAULT false NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`amount_micros` integer DEFAULT 0 NOT NULL,
	`rate_source` text DEFAULT 'UNKNOWN' NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`whatsapp_account_id`) REFERENCES `whatsapp_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `wa_costs_tenant_idx` ON `whatsapp_message_costs` (`tenant_id`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `wa_costs_provider_idx` ON `whatsapp_message_costs` (`tenant_id`,`provider_message_id`);--> statement-breakpoint
CREATE TABLE `whatsapp_onboarding_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`state` text NOT NULL,
	`mode` text DEFAULT 'EMBEDDED_SIGNUP' NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`business_id` text,
	`waba_id` text,
	`phone_number_id` text,
	`whatsapp_account_id` text,
	`error` text,
	`metadata` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`whatsapp_account_id`) REFERENCES `whatsapp_accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wa_onboarding_state_idx` ON `whatsapp_onboarding_sessions` (`state`);--> statement-breakpoint
CREATE INDEX `wa_onboarding_tenant_idx` ON `whatsapp_onboarding_sessions` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `whatsapp_pricing_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`category` text NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`amount_micros` integer NOT NULL,
	`effective_from` integer NOT NULL,
	`effective_to` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wa_rates_lookup_idx` ON `whatsapp_pricing_rates` (`tenant_id`,`category`,`currency`,`effective_from`);--> statement-breakpoint
ALTER TABLE `whatsapp_accounts` ADD `onboarding_mode` text DEFAULT 'CLOUD_API' NOT NULL;--> statement-breakpoint
ALTER TABLE `whatsapp_accounts` ADD `coexistence_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `whatsapp_accounts` ADD `business_id` text;--> statement-breakpoint
ALTER TABLE `whatsapp_accounts` ADD `billing_mode` text DEFAULT 'UNVERIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE `whatsapp_accounts` ADD `billing_status` text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE `whatsapp_accounts` ADD `billing_verified_at` integer;--> statement-breakpoint
ALTER TABLE `whatsapp_accounts` ADD `connection_metadata` text;