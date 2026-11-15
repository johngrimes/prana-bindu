CREATE TABLE `alarms` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`fire_date` text,
	`offset_seconds` integer,
	`repeat_interval_seconds` integer DEFAULT 0 NOT NULL,
	`snoozed` integer DEFAULT false NOT NULL,
	`added` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alarms_task` ON `alarms` (`task_id`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`blob_sha256` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`rank` integer DEFAULT 0 NOT NULL,
	`added` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attachments_task` ON `attachments` (`task_id`);--> statement-breakpoint
CREATE INDEX `attachments_blob` ON `attachments` (`blob_sha256`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`sha256` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`content_type` text NOT NULL,
	`storage_key` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `change_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL,
	`state` text DEFAULT 'applied' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `change_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`table_name` text NOT NULL,
	`row_key_json` text NOT NULL,
	`before_json` text,
	`after_json` text
);
--> statement-breakpoint
CREATE INDEX `change_rows_group` ON `change_rows` (`group_id`);--> statement-breakpoint
CREATE TABLE `enrollment_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`rank` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`added` text NOT NULL,
	`modified` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `folders_parent` ON `folders` (`parent_id`);--> statement-breakpoint
CREATE TABLE `import_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`imported_at` text NOT NULL,
	`source` text NOT NULL,
	`app_id` text,
	`app_version` text,
	`capabilities_json` text DEFAULT '[]' NOT NULL,
	`counts_json` text DEFAULT '{}' NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `journal_state` (
	`group_id` integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports_json` text DEFAULT '[]' NOT NULL,
	`device_type` text,
	`backed_up` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE TABLE `perspectives` (
	`id` text PRIMARY KEY NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`icon` text DEFAULT 'list' NOT NULL,
	`color` text,
	`favorite` integer DEFAULT false NOT NULL,
	`rank` integer NOT NULL,
	`aggregation` text DEFAULT 'all' NOT NULL,
	`rules_json` text DEFAULT '[]' NOT NULL,
	`presentation_json` text DEFAULT '{}' NOT NULL,
	`view_options_json` text DEFAULT '{}' NOT NULL,
	`import_extras_json` text,
	`added` text NOT NULL,
	`modified` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`task_id` text PRIMARY KEY NOT NULL,
	`folder_id` text,
	`type` text DEFAULT 'parallel' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`review_interval_steps` integer DEFAULT 1 NOT NULL,
	`review_interval_unit` text DEFAULT 'week' NOT NULL,
	`review_interval_raw` text,
	`last_review` text NOT NULL,
	`next_review` text
);
--> statement-breakpoint
CREATE INDEX `projects_folder` ON `projects` (`folder_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`rank` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`children_mutually_exclusive` integer DEFAULT false NOT NULL,
	`added` text NOT NULL,
	`modified` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tags_parent` ON `tags` (`parent_id`);--> statement-breakpoint
CREATE TABLE `task_tags` (
	`task_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`rank_in_task` integer NOT NULL,
	`rank_in_tag` integer,
	`added` text NOT NULL,
	PRIMARY KEY(`task_id`, `tag_id`)
);
--> statement-breakpoint
CREATE INDEX `task_tags_tag` ON `task_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`in_inbox` integer DEFAULT false NOT NULL,
	`rank` integer NOT NULL,
	`name` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`flagged` integer DEFAULT false NOT NULL,
	`defer_date` text,
	`planned_date` text,
	`due_date` text,
	`estimated_minutes` integer,
	`completed` text,
	`dropped` text,
	`added` text NOT NULL,
	`modified` text NOT NULL,
	`sequential` integer DEFAULT false NOT NULL,
	`completed_by_children` integer DEFAULT false NOT NULL,
	`repeat_rule` text,
	`repeat_schedule_type` text,
	`repeat_anchor` text,
	`repeat_catch_up` integer DEFAULT false NOT NULL,
	`next_clone_id` integer DEFAULT 0 NOT NULL,
	`assigned_project_id` text
);
--> statement-breakpoint
CREATE INDEX `tasks_parent` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE INDEX `tasks_inbox` ON `tasks` (`in_inbox`);--> statement-breakpoint
CREATE INDEX `tasks_due` ON `tasks` (`due_date`);--> statement-breakpoint
CREATE INDEX `tasks_completed` ON `tasks` (`completed`);--> statement-breakpoint
CREATE INDEX `tasks_modified` ON `tasks` (`modified`);--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`challenge` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`expires_at` text NOT NULL
);
