/**
 * Four-role rollout data convergence (LOBE-12329).
 *
 * `workspace_members.role` is the single source of truth for built-in
 * workspace roles; permissions expand from the in-code
 * `WORKSPACE_ROLE_PERMISSIONS` matrix at request time. The only data work the
 * rollout needs is converging legacy rows to the four-role model:
 *
 * 1. the primary owner's membership row is repaired if missing /
 *    soft-deleted / mislabelled;
 * 2. every other member still labelled `owner` becomes `admin` (the unique
 *    Owner is `workspaces.primary_owner_id`);
 * 3. pending Owner invitations become Admin (Owner is only produced via
 *    ownership transfer).
 *
 * Run via `scripts/workspace-rbac-backfill` in the cloud repo. Every
 * statement is idempotent; once they converge, the
 * `workspace_members_unique_active_owner_idx` index-only migration can ship.
 */

export interface WorkspaceRoleConvergeStatement {
  label: string;
  sql: string;
}

export const WORKSPACE_ROLE_CONVERGE_STATEMENTS: WorkspaceRoleConvergeStatement[] = [
  {
    label: 'repair-primary-owner-membership',
    sql: `
INSERT INTO "workspace_members" (
  "workspace_id",
  "user_id",
  "role",
  "joined_at",
  "updated_at",
  "deleted_at"
)
SELECT
  "workspaces"."id",
  "workspaces"."primary_owner_id",
  'owner',
  now(),
  now(),
  NULL
FROM "workspaces"
ON CONFLICT ("workspace_id", "user_id") DO UPDATE SET
  "role" = 'owner',
  "deleted_at" = NULL,
  "updated_at" = now();`,
  },
  {
    label: 'relabel-non-primary-owners-admin',
    sql: `
UPDATE "workspace_members"
SET "role" = 'admin', "updated_at" = now()
FROM "workspaces"
WHERE
  "workspace_members"."workspace_id" = "workspaces"."id"
  AND "workspace_members"."user_id" <> "workspaces"."primary_owner_id"
  AND "workspace_members"."role" = 'owner';`,
  },
  {
    label: 'convert-owner-invitations-admin',
    sql: `
UPDATE "workspace_invitations"
SET "role" = 'admin', "updated_at" = now()
WHERE "role" = 'owner';`,
  },
];
