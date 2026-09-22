CREATE TABLE `anonymous_reader_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`access_hash` text NOT NULL,
	`status` text NOT NULL,
	`claim_token` text,
	`result_json` text,
	`error_json` text,
	`created_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_anonymous_reader_status_created` ON `anonymous_reader_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_anonymous_reader_expires` ON `anonymous_reader_jobs` (`expires_at`);