DROP INDEX IF EXISTS "user_connectors_user_identifier_unique";--> statement-breakpoint
ALTER TABLE "user_connectors" ADD COLUMN IF NOT EXISTS "agent_id" text;--> statement-breakpoint
ALTER TABLE "user_connectors" ADD CONSTRAINT "user_connectors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_connectors_user_agent_identifier_unique" ON "user_connectors" USING btree ("user_id","agent_id","identifier") WHERE "user_connectors"."agent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connectors_agent_id_idx" ON "user_connectors" USING btree ("agent_id");