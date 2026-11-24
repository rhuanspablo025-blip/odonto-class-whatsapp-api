CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`type` text NOT NULL,
	`conversation_id` text,
	`message_id` text,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_tenant_seq_idx` ON `events` (`tenant_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`tenant_id`,`type`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `assigned_user_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `assigned_user_name` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `assigned_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `unread_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `last_read_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `closed_at` integer;--> statement-breakpoint
CREATE INDEX `conversations_assigned_idx` ON `conversations` (`tenant_id`,`assigned_user_id`);