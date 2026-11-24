DROP INDEX `webhook_event_key_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_event_key_idx` ON `webhook_events` (`event_key`);--> statement-breakpoint
DROP INDEX `wa_accounts_phone_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `wa_accounts_phone_idx` ON `whatsapp_accounts` (`phone_number_id`);