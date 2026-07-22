// @vitest-environment node
import type { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import type { AgentShareConfig } from '../../schemas';
import { agents, agentShares, users, workspaces } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { AgentShareModel } from '../agentShare';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'agent-share-test-user-id';
const userId2 = 'agent-share-test-user-id-2';
const agentId = 'agent-share-test-agent';
const agentId2 = 'agent-share-test-agent-2';
const user2AgentId = 'agent-share-test-user2-agent';

const agentShareModel = new AgentShareModel(serverDB, userId);
const agentShareModel2 = new AgentShareModel(serverDB, userId2);

describe('AgentShareModel', () => {
  beforeEach(async () => {
    await serverDB.delete(users);

    await serverDB.transaction(async (tx) => {
      await tx.insert(users).values([{ id: userId }, { id: userId2 }]);
      await tx.insert(agents).values([
        { id: agentId, title: 'Test Agent', userId },
        { id: agentId2, userId },
        { id: user2AgentId, title: 'User 2 Agent', userId: userId2 },
      ]);
    });
  });

  afterEach(async () => {
    await serverDB.delete(agentShares);
    await serverDB.delete(agents);
    await serverDB.delete(users);
  });

  describe('create', () => {
    it('should create a share for an agent with default visibility', async () => {
      const result = await agentShareModel.create(agentId);

      expect(result).toBeDefined();
      expect(result!.agentId).toBe(agentId);
      expect(result!.visibility).toBe('private');
      expect(result!.id).toBeDefined();
    });

    it('should create a share with link visibility', async () => {
      const result = await agentShareModel.create(agentId, 'link');

      expect(result!.visibility).toBe('link');
    });

    it('should throw error when agent does not exist', async () => {
      await expect(agentShareModel.create('non-existent-agent')).rejects.toThrow(
        'Agent not found or not owned by user',
      );
    });

    it('should throw error when trying to share another users agent', async () => {
      await expect(agentShareModel.create(user2AgentId)).rejects.toThrow(
        'Agent not found or not owned by user',
      );
    });

    it('should return existing share on conflict (duplicate agent)', async () => {
      const first = await agentShareModel.create(agentId);
      const second = await agentShareModel.create(agentId);

      expect(second).toBeDefined();
      expect(second!.agentId).toBe(agentId);
      expect(second!.id).toBe(first!.id);
    });

    it('should keep a single share record per agent (unique constraint)', async () => {
      await agentShareModel.create(agentId);
      await agentShareModel.create(agentId, 'link');

      const rows = await serverDB.query.agentShares.findMany({
        where: (t, { eq }) => eq(t.agentId, agentId),
      });
      expect(rows).toHaveLength(1);
      // Conflicting create must not overwrite the original visibility
      expect(rows[0].visibility).toBe('private');
    });
  });

  describe('getByAgentId', () => {
    it('should get share info by agent id', async () => {
      const created = await agentShareModel.create(agentId, 'link');

      const result = await agentShareModel.getByAgentId(agentId);

      expect(result).toBeDefined();
      expect(result!.id).toBe(created!.id);
      expect(result!.agentId).toBe(agentId);
      expect(result!.visibility).toBe('link');
    });

    it('should return null when share does not exist', async () => {
      const result = await agentShareModel.getByAgentId(agentId);

      expect(result).toBeNull();
    });

    it('should not return other users share', async () => {
      await agentShareModel2.create(user2AgentId);

      const result = await agentShareModel.getByAgentId(user2AgentId);

      expect(result).toBeNull();
    });
  });

  describe('updateConfig', () => {
    it('should write and read back the extended shareConfig fields', async () => {
      await agentShareModel.create(agentId);

      const config: AgentShareConfig = {
        allowReadMemory: true,
        enabledToolIds: ['web-browsing', 'dalle'],
        filePermissionConfig: { agentFiles: 'read', knowledgeBase: 'none', uploadAllowed: false },
        guestEnabled: true,
        maxTopicsPerVisitor: 5,
        maxTurnsPerTopic: 20,
      };

      const result = await agentShareModel.updateConfig(agentId, config);

      expect(result).toBeDefined();
      expect(result!.shareConfig).toEqual(config);

      const readBack = await agentShareModel.getByAgentId(agentId);
      expect(readBack!.shareConfig?.enabledToolIds).toEqual(['web-browsing', 'dalle']);
      expect(readBack!.shareConfig?.maxTurnsPerTopic).toBe(20);
      expect(readBack!.shareConfig?.maxTopicsPerVisitor).toBe(5);
    });

    it('should replace the whole config instead of merging', async () => {
      await agentShareModel.create(agentId);
      await agentShareModel.updateConfig(agentId, { guestEnabled: true, maxGuestTopics: 10 });

      const result = await agentShareModel.updateConfig(agentId, { maxTurnsPerTopic: 8 });

      expect(result!.shareConfig).toEqual({ maxTurnsPerTopic: 8 });
    });

    it('should return null when share does not exist', async () => {
      const result = await agentShareModel.updateConfig(agentId, { guestEnabled: true });

      expect(result).toBeNull();
    });

    it('should not update other users share config', async () => {
      await agentShareModel2.create(user2AgentId);

      const result = await agentShareModel.updateConfig(user2AgentId, { guestEnabled: true });

      expect(result).toBeNull();

      const share = await agentShareModel2.getByAgentId(user2AgentId);
      expect(share!.shareConfig).toBeNull();
    });
  });

  describe('updateVisibility', () => {
    it('should update share visibility', async () => {
      await agentShareModel.create(agentId, 'private');

      const result = await agentShareModel.updateVisibility(agentId, 'link');

      expect(result).toBeDefined();
      expect(result!.visibility).toBe('link');
    });

    it('should switch a link share back to private', async () => {
      await agentShareModel.create(agentId, 'link');

      const result = await agentShareModel.updateVisibility(agentId, 'private');

      expect(result!.visibility).toBe('private');
    });

    it('should return null when share does not exist', async () => {
      const result = await agentShareModel.updateVisibility(agentId, 'link');

      expect(result).toBeNull();
    });

    it('should not update other users share', async () => {
      await agentShareModel2.create(user2AgentId, 'private');

      const result = await agentShareModel.updateVisibility(user2AgentId, 'link');

      expect(result).toBeNull();

      const share = await agentShareModel2.getByAgentId(user2AgentId);
      expect(share!.visibility).toBe('private');
    });
  });

  describe('deleteByAgentId', () => {
    it('should delete share by agent id', async () => {
      await agentShareModel.create(agentId);

      await agentShareModel.deleteByAgentId(agentId);

      const share = await agentShareModel.getByAgentId(agentId);
      expect(share).toBeNull();
    });

    it('should not delete other users share', async () => {
      await agentShareModel2.create(user2AgentId);

      await agentShareModel.deleteByAgentId(user2AgentId);

      const share = await agentShareModel2.getByAgentId(user2AgentId);
      expect(share).not.toBeNull();
    });
  });

  describe('findByShareId (static)', () => {
    it('should find share by share id with agent meta', async () => {
      const created = await agentShareModel.create(agentId, 'link');

      const result = await AgentShareModel.findByShareId(serverDB, created!.id);

      expect(result).toBeDefined();
      expect(result!.shareId).toBe(created!.id);
      expect(result!.agentId).toBe(agentId);
      expect(result!.agentTitle).toBe('Test Agent');
      expect(result!.ownerId).toBe(userId);
      expect(result!.visibility).toBe('link');
      expect(result!.userViewCount).toBe(0);
    });

    it('should return null when share does not exist', async () => {
      const result = await AgentShareModel.findByShareId(
        serverDB,
        '00000000-0000-0000-0000-000000000000',
      );

      expect(result).toBeNull();
    });

    it('should include shareConfig in the result', async () => {
      const created = await agentShareModel.create(agentId, 'link');
      await agentShareModel.updateConfig(agentId, { enabledToolIds: ['t1'], guestEnabled: true });

      const result = await AgentShareModel.findByShareId(serverDB, created!.id);

      expect(result!.shareConfig).toEqual({ enabledToolIds: ['t1'], guestEnabled: true });
    });
  });

  describe('incrementUserViewCount (static)', () => {
    it('should increment user view count', async () => {
      const created = await agentShareModel.create(agentId);

      await AgentShareModel.incrementUserViewCount(serverDB, created!.id);

      const after = await serverDB.query.agentShares.findFirst({
        where: (t, { eq }) => eq(t.id, created!.id),
      });
      expect(after!.userViewCount).toBe(1);
    });

    it('should increment user view count multiple times', async () => {
      const created = await agentShareModel.create(agentId);

      await AgentShareModel.incrementUserViewCount(serverDB, created!.id);
      await AgentShareModel.incrementUserViewCount(serverDB, created!.id);
      await AgentShareModel.incrementUserViewCount(serverDB, created!.id);

      const result = await serverDB.query.agentShares.findFirst({
        where: (t, { eq }) => eq(t.id, created!.id),
      });
      expect(result!.userViewCount).toBe(3);
    });
  });

  describe('findByShareIdWithAccessCheck (static)', () => {
    it('should return share for owner regardless of visibility', async () => {
      const created = await agentShareModel.create(agentId, 'private');

      const result = await AgentShareModel.findByShareIdWithAccessCheck(
        serverDB,
        created!.id,
        userId,
      );

      expect(result).toBeDefined();
      expect(result.shareId).toBe(created!.id);
    });

    it('should return share for anonymous user when visibility is link', async () => {
      const created = await agentShareModel.create(agentId, 'link');

      const result = await AgentShareModel.findByShareIdWithAccessCheck(
        serverDB,
        created!.id,
        undefined,
      );

      expect(result).toBeDefined();
      expect(result.shareId).toBe(created!.id);
    });

    it('should return share for another logged-in user when visibility is link', async () => {
      const created = await agentShareModel.create(agentId, 'link');

      const result = await AgentShareModel.findByShareIdWithAccessCheck(
        serverDB,
        created!.id,
        userId2,
      );

      expect(result.shareId).toBe(created!.id);
    });

    it('should throw NOT_FOUND when share does not exist', async () => {
      try {
        await AgentShareModel.findByShareIdWithAccessCheck(
          serverDB,
          '00000000-0000-0000-0000-000000000000',
          userId,
        );
        throw new Error('should not reach');
      } catch (error) {
        expect((error as TRPCError).code).toBe('NOT_FOUND');
      }
    });

    it('should throw FORBIDDEN when visibility is private and user is not owner', async () => {
      const created = await agentShareModel.create(agentId, 'private');

      try {
        await AgentShareModel.findByShareIdWithAccessCheck(serverDB, created!.id, userId2);
        throw new Error('should not reach');
      } catch (error) {
        expect((error as TRPCError).code).toBe('FORBIDDEN');
      }
    });

    it('should throw FORBIDDEN when visibility is private and user is anonymous', async () => {
      const created = await agentShareModel.create(agentId, 'private');

      try {
        await AgentShareModel.findByShareIdWithAccessCheck(serverDB, created!.id, undefined);
        throw new Error('should not reach');
      } catch (error) {
        expect((error as TRPCError).code).toBe('FORBIDDEN');
      }
    });
  });

  describe('workspace mode ownership', () => {
    const workspaceId = 'agent-share-test-workspace';
    const wsPublicAgentId = 'agent-share-ws-public-agent';
    const wsPrivateAgentId = 'agent-share-ws-private-agent';

    beforeEach(async () => {
      await serverDB.insert(workspaces).values({
        id: workspaceId,
        name: 'Test Workspace',
        primaryOwnerId: userId,
        slug: 'agent-share-test-ws',
      });
      await serverDB.insert(agents).values([
        { id: wsPublicAgentId, userId, visibility: 'public', workspaceId },
        { id: wsPrivateAgentId, userId, visibility: 'private', workspaceId },
      ]);
    });

    it('allows a workspace member to manage the share of a public workspace agent', async () => {
      const memberModel = new AgentShareModel(serverDB, userId2, workspaceId);

      const created = await memberModel.create(wsPublicAgentId, 'link');

      expect(created).toBeDefined();
      expect(created!.agentId).toBe(wsPublicAgentId);
    });

    it('rejects a workspace member managing the share of a private workspace agent', async () => {
      const memberModel = new AgentShareModel(serverDB, userId2, workspaceId);

      await expect(memberModel.create(wsPrivateAgentId)).rejects.toThrow(
        'Agent not found or not owned by user',
      );
    });

    it('keeps the agent creator as ownerId for access check', async () => {
      const memberModel = new AgentShareModel(serverDB, userId2, workspaceId);
      const created = await memberModel.create(wsPublicAgentId, 'private');

      // Private share is scoped to the agent creator, not the member who created it
      try {
        await AgentShareModel.findByShareIdWithAccessCheck(serverDB, created!.id, userId2);
        throw new Error('should not reach');
      } catch (error) {
        expect((error as TRPCError).code).toBe('FORBIDDEN');
      }

      const ownerResult = await AgentShareModel.findByShareIdWithAccessCheck(
        serverDB,
        created!.id,
        userId,
      );
      expect(ownerResult.shareId).toBe(created!.id);
    });
  });
});
