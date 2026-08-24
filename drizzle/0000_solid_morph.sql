CREATE TABLE `analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`platform` text,
	`canonical_url` text,
	`content_id` text,
	`title` text NOT NULL,
	`sha256` text,
	`perceptual_hash` text,
	`text_hash` text,
	`features_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_analyses_sha256` ON `analyses` (`sha256`);--> statement-breakpoint
CREATE INDEX `idx_analyses_canonical_url` ON `analyses` (`canonical_url`);--> statement-breakpoint
CREATE INDEX `idx_analyses_content_id` ON `analyses` (`content_id`);--> statement-breakpoint
CREATE INDEX `idx_analyses_created_at` ON `analyses` (`created_at`);