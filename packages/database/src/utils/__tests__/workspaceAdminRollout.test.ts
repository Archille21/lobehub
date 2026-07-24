// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { users, workspaceInvitations, workspaceMembers, workspaces } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { WORKSPACE_ROLE_CONVERGE_STATEMENTS } from '../workspaceAdminRollout';

const serverDB: LobeChatDatabase = await getTestDB();
const ownerId = 'role-converge-owner';
const legacyOwnerId = 'role-converge-legacy-owner';
const workspaceId = 'role-converge-workspace';
const invitationId = 'role-converge-invitation';

const runConverge = async () => {
  for (const statement of WORKSPACE_ROLE_CONVERGE_STATEMENTS) {
    await serverDB.execute(sql.raw(statement.sql));
  }
};

const cleanup = async () => {
  await serverDB.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await serverDB.delete(users);
};

beforeEach(async () => {
  await cleanup();
  await serverDB.insert(users).values([{ id: ownerId }, { id: legacyOwnerId }]);
  await serverDB.insert(workspaces).values({
    id: workspaceId,
    name: 'Role converge',
    primaryOwnerId: ownerId,
    slug: workspaceId,
  });
  await serverDB.insert(workspaceMembers).values([
    // Primary owner's row is soft-deleted and mislabelled — must be repaired.
    { deletedAt: new Date(), role: 'member', userId: ownerId, workspaceId },
    // Legacy co-owner must be demoted to admin.
    { role: 'owner', userId: legacyOwnerId, workspaceId },
  ]);
  await serverDB.insert(workspaceInvitations).values({
    email: 'pending-owner@example.com',
    expiresAt: new Date(Date.now() + 86_400_000),
    id: invitationId,
    inviterId: ownerId,
    role: 'owner',
    token: `${invitationId}-token`,
    workspaceId,
  });
});

afterEach(cleanup);

describe('workspace role convergence statements', () => {
  it('converges legacy rows to the four-role model and is idempotent', async () => {
    await runConverge();
    await runConverge();

    const memberships = await serverDB.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.workspaceId, workspaceId),
    });

    const primary = memberships.find(({ userId }) => userId === ownerId);
    expect(primary?.role).toBe('owner');
    expect(primary?.deletedAt).toBeNull();

    expect(memberships.find(({ userId }) => userId === legacyOwnerId)?.role).toBe('admin');

    const invitation = await serverDB.query.workspaceInvitations.findFirst({
      where: eq(workspaceInvitations.id, invitationId),
    });
    expect(invitation?.role).toBe('admin');
  });
});
