CREATE TABLE `oauth_access_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_access_tokens_grant` ON `oauth_access_tokens` (`grant_id`);--> statement-breakpoint
CREATE TABLE `oauth_authorization_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`state` text,
	`code_challenge` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris_json` text NOT NULL,
	`created_at` text NOT NULL,
	`last_granted_at` text
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE INDEX `oauth_codes_grant` ON `oauth_codes` (`grant_id`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE INDEX `oauth_grants_client` ON `oauth_grants` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE INDEX `oauth_refresh_tokens_grant` ON `oauth_refresh_tokens` (`grant_id`);