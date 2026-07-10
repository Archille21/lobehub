CREATE TABLE IF NOT EXISTS "chat_ttft_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"topic_id" text,
	"user_message_id" text,
	"assistant_message_id" text,
	"trigger" text,
	"is_topic_first" boolean,
	"model" text,
	"provider" text,
	"cold_start" boolean,
	"ttft_ms" integer,
	"spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_ttft_metrics_operation_id_unique" ON "chat_ttft_metrics" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_ttft_metrics_created_at_idx" ON "chat_ttft_metrics" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_ttft_metrics_user_id_created_at_idx" ON "chat_ttft_metrics" USING btree ("user_id","created_at");