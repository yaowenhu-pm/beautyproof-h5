CREATE TABLE `reader_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`platform` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reader_jobs_status_created` ON `reader_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `reader_nonces` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reader_nonces_expires` ON `reader_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `reader_rate` (
	`id` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reader_worker` (
	`id` text PRIMARY KEY NOT NULL,
	`last_seen` integer NOT NULL,
	`last_cleanup` integer NOT NULL
);
