CREATE TABLE `mail_drop_messages` (
	`account_id` text NOT NULL,
	`email_id` text NOT NULL,
	`task_id` text NOT NULL,
	`processed_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `email_id`)
);
