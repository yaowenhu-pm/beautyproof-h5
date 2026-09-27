CREATE TABLE `anonymous_inbound_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`access_hash` text NOT NULL,
	`remote_id` text,
	`remote_token` text,
	`status` text NOT NULL,
	`result_json` text,
	`error_json` text,
	`created_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_anonymous_inbound_status_deadline` ON `anonymous_inbound_jobs` (`status`,`deadline_at`);--> statement-breakpoint
CREATE INDEX `idx_anonymous_inbound_expires` ON `anonymous_inbound_jobs` (`expires_at`);--> statement-breakpoint
CREATE TABLE `anonymous_inbound_media` (
	`url_hash` text NOT NULL,
	`sha256` text NOT NULL,
	`remote_id` text NOT NULL,
	`remote_token` text NOT NULL,
	`image_index` integer NOT NULL,
	`bytes` integer NOT NULL,
	`format` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`url_hash`, `sha256`)
);
--> statement-breakpoint
CREATE INDEX `idx_anonymous_inbound_media_expires` ON `anonymous_inbound_media` (`expires_at`);