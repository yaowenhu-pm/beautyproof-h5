CREATE TABLE `api_calls` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`reserved_micros` integer NOT NULL,
	`charged_micros` integer,
	`status` text NOT NULL,
	`purpose` text NOT NULL,
	`created_at` integer NOT NULL,
	`price_version` text NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`cached_tokens` integer,
	`result_json` text
);
