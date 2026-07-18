CREATE TABLE IF NOT EXISTS "topic_comment_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" text NOT NULL,
	"mentioned_user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topic_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"message_id" text,
	"parent_comment_id" text,
	"author_user_id" text,
	"workspace_id" text NOT NULL,
	"content" text NOT NULL,
	"editor_data" jsonb,
	"client_id" text NOT NULL,
	"anchor_preview" jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_comments_anchored_requires_preview" CHECK ("topic_comments"."message_id" IS NULL OR "topic_comments"."anchor_preview" IS NOT NULL),
	CONSTRAINT "topic_comments_reply_has_no_anchor" CHECK ("topic_comments"."parent_comment_id" IS NULL OR ("topic_comments"."message_id" IS NULL AND "topic_comments"."anchor_preview" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "topic_comment_mentions" DROP CONSTRAINT IF EXISTS "topic_comment_mentions_comment_id_topic_comments_id_fk";--> statement-breakpoint
ALTER TABLE "topic_comment_mentions" ADD CONSTRAINT "topic_comment_mentions_comment_id_topic_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."topic_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_comment_mentions" DROP CONSTRAINT IF EXISTS "topic_comment_mentions_mentioned_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "topic_comment_mentions" ADD CONSTRAINT "topic_comment_mentions_mentioned_user_id_users_id_fk" FOREIGN KEY ("mentioned_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_comment_mentions" DROP CONSTRAINT IF EXISTS "topic_comment_mentions_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "topic_comment_mentions" ADD CONSTRAINT "topic_comment_mentions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_comments" DROP CONSTRAINT IF EXISTS "topic_comments_topic_id_topics_id_fk";--> statement-breakpoint
ALTER TABLE "topic_comments" ADD CONSTRAINT "topic_comments_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_comments" DROP CONSTRAINT IF EXISTS "topic_comments_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "topic_comments" ADD CONSTRAINT "topic_comments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_comments" DROP CONSTRAINT IF EXISTS "topic_comments_parent_comment_id_topic_comments_id_fk";--> statement-breakpoint
ALTER TABLE "topic_comments" ADD CONSTRAINT "topic_comments_parent_comment_id_topic_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."topic_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_comments" DROP CONSTRAINT IF EXISTS "topic_comments_author_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "topic_comments" ADD CONSTRAINT "topic_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_comments" DROP CONSTRAINT IF EXISTS "topic_comments_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "topic_comments" ADD CONSTRAINT "topic_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "topic_comment_mentions_comment_id_mentioned_user_id_unique" ON "topic_comment_mentions" USING btree ("comment_id","mentioned_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_comment_mentions_mentioned_user_id_created_at_idx" ON "topic_comment_mentions" USING btree ("mentioned_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_comment_mentions_workspace_id_idx" ON "topic_comment_mentions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "topic_comments_topic_id_author_user_id_client_id_unique" ON "topic_comments" USING btree ("topic_id","author_user_id","client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_comments_parent_comment_id_created_at_id_idx" ON "topic_comments" USING btree ("parent_comment_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_comments_topic_id_created_at_id_idx" ON "topic_comments" USING btree ("topic_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_comments_topic_id_message_id_idx" ON "topic_comments" USING btree ("topic_id","message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_comments_message_id_idx" ON "topic_comments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_comments_author_user_id_idx" ON "topic_comments" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_comments_workspace_id_idx" ON "topic_comments" USING btree ("workspace_id");
