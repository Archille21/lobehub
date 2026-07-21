CREATE INDEX IF NOT EXISTS "agents_created_at_idx" ON "agents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_created_at_idx" ON "topics" USING btree ("created_at");
