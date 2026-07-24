-- Enforce the single active Owner per workspace at the DB level.
-- Deploy ONLY after the four-role rollout has converged legacy multi-owner
-- rows (LOBE-12316 step 7): creating it earlier fails on legacy workspaces
-- that still hold multiple role='owner' rows, and legacy promote-to-Admin
-- writes (which wrote role='owner') would hit unique violations.
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_unique_active_owner_idx" ON "workspace_members" USING btree ("workspace_id") WHERE "workspace_members"."role" = 'owner' AND "workspace_members"."deleted_at" IS NULL;
