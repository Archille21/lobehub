// @vitest-environment node
import type { AgentPluginEntry } from '@lobechat/types';
import { getPluginMode } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import type { NewInstalledPlugin } from '../../schemas';
import { agents, userInstalledPlugins, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { AgentSkillModel } from '../agentSkill';
import { PluginModel } from '../plugin';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'plugin-db';
const pluginModel = new PluginModel(serverDB, userId);

beforeEach(async () => {
  await serverDB.transaction(async (trx) => {
    await trx.delete(users);
    await trx.insert(users).values([{ id: userId }, { id: '456' }]);
  });
});

afterEach(async () => {
  await serverDB.delete(users);
});

describe('PluginModel', () => {
  describe('create', () => {
    it('should create a new installed plugin', async () => {
      const params = {
        type: 'plugin',
        identifier: 'test-plugin',
        manifest: { identifier: 'Test Plugin' },
        customParams: { manifestUrl: 'abc123' },
      } as NewInstalledPlugin;

      const result = await pluginModel.create(params);

      expect(result.userId).toBe(userId);
      expect(result.type).toBe(params.type);
      expect(result.identifier).toBe(params.identifier);
      expect(result.manifest).toEqual(params.manifest);
      expect(result.customParams).toEqual(params.customParams);
    });
  });

  describe('delete', () => {
    it('should delete an installed plugin by identifier', async () => {
      await serverDB.insert(userInstalledPlugins).values({
        userId,
        type: 'plugin',
        identifier: 'test-plugin',
        manifest: { name: 'Test Plugin' },
      } as unknown as NewInstalledPlugin);

      await pluginModel.delete('test-plugin');

      const result = await serverDB.select().from(userInstalledPlugins);
      expect(result).toHaveLength(0);
    });

    it('removes stale agent policies before the identifier is reused by a custom skill', async () => {
      const identifier = 'reused-plugin-identifier';
      const originalUpdatedAt = new Date('2024-01-02T03:04:05.000Z');
      await serverDB.insert(userInstalledPlugins).values({
        identifier,
        manifest: { name: 'Plugin to remove' },
        type: 'plugin',
        userId,
      } as unknown as NewInstalledPlugin);
      await serverDB.insert(agents).values([
        {
          id: 'plugin-policy-object-agent',
          plugins: [{ identifier, mode: 'auto' }, 'kept-plugin'] as unknown as string[],
          updatedAt: originalUpdatedAt,
          userId,
        },
        {
          id: 'plugin-policy-string-agent',
          plugins: [
            identifier,
            { identifier: 'kept-disabled', mode: 'disabled' },
          ] as unknown as string[],
          userId,
        },
        {
          id: 'other-user-plugin-policy-agent',
          plugins: [{ identifier, mode: 'auto' }] as unknown as string[],
          userId: '456',
        },
      ]);

      await pluginModel.delete(identifier);

      const policiesAfterDelete = await serverDB.query.agents.findMany();
      const policiesByAgentId = new Map(policiesAfterDelete.map((agent) => [agent.id, agent]));
      expect(policiesByAgentId.get('plugin-policy-object-agent')?.plugins).toEqual(['kept-plugin']);
      expect(policiesByAgentId.get('plugin-policy-object-agent')?.updatedAt).toEqual(
        originalUpdatedAt,
      );
      expect(policiesByAgentId.get('plugin-policy-string-agent')?.plugins).toEqual([
        { identifier: 'kept-disabled', mode: 'disabled' },
      ]);
      expect(policiesByAgentId.get('other-user-plugin-policy-agent')?.plugins).toEqual([
        { identifier, mode: 'auto' },
      ]);

      const agentSkillModel = new AgentSkillModel(serverDB, userId);
      await agentSkillModel.create({
        description: 'Skill reusing a removed plugin identifier',
        identifier,
        manifest: { description: 'Reused identifier skill', name: 'Reused Identifier Skill' },
        name: 'Reused Identifier Skill',
        source: 'user',
      });

      const policiesAfterReuse = await serverDB.query.agents.findMany({
        where: (table, { eq }) => eq(table.userId, userId),
      });
      expect(
        policiesAfterReuse.every(
          ({ plugins }) =>
            getPluginMode(plugins as AgentPluginEntry[] | undefined, identifier) === 'disabled',
        ),
      ).toBe(true);
    });
  });

  describe('deleteAll', () => {
    it('should delete all installed plugins for the user', async () => {
      await serverDB.insert(userInstalledPlugins).values([
        {
          userId,
          type: 'plugin',
          identifier: 'test-plugin-1',
          manifest: { name: 'Test Plugin 1' },
        },
        {
          userId,
          type: 'plugin',
          identifier: 'test-plugin-2',
          manifest: { name: 'Test Plugin 2' },
        },
        {
          userId: '456',
          type: 'plugin',
          identifier: 'test-plugin-3',
          manifest: { name: 'Test Plugin 3' },
        },
      ] as unknown as NewInstalledPlugin[]);

      await pluginModel.deleteAll();

      const result = await serverDB.select().from(userInstalledPlugins);
      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('456');
    });
  });

  describe('query', () => {
    it('should query installed plugins for the user', async () => {
      await serverDB.insert(userInstalledPlugins).values([
        {
          userId,
          type: 'plugin',
          identifier: 'test-plugin-1',
          manifest: { name: 'Test Plugin 1' },
          createdAt: new Date('2023-01-01'),
        },
        {
          userId,
          type: 'plugin',
          identifier: 'test-plugin-2',
          manifest: { name: 'Test Plugin 2' },
          createdAt: new Date('2023-02-01'),
        },
        {
          userId: '456',
          type: 'plugin',
          identifier: 'test-plugin-3',
          manifest: { name: 'Test Plugin 3' },
          createdAt: new Date('2023-03-01'),
        },
      ] as unknown as NewInstalledPlugin[]);

      const result = await pluginModel.query();

      expect(result).toHaveLength(2);
      expect(result[0].identifier).toBe('test-plugin-2');
      expect(result[1].identifier).toBe('test-plugin-1');
    });
  });

  describe('findById', () => {
    it('should find an installed plugin by identifier', async () => {
      await serverDB.insert(userInstalledPlugins).values([
        {
          userId,
          type: 'plugin',
          identifier: 'test-plugin-1',
          manifest: { name: 'Test Plugin 1' },
        },
        {
          userId: '456',
          type: 'plugin',
          identifier: 'test-plugin-2',
          manifest: { name: 'Test Plugin 2' },
        },
      ] as unknown as NewInstalledPlugin[]);

      const result = await pluginModel.findById('test-plugin-1');

      expect(result?.userId).toBe(userId);
      expect(result?.identifier).toBe('test-plugin-1');
    });
  });

  describe('update', () => {
    it('should update an installed plugin', async () => {
      await serverDB.insert(userInstalledPlugins).values({
        userId,
        type: 'plugin',
        identifier: 'test-plugin',
        manifest: {},
        settings: { enabled: true },
      } as unknown as NewInstalledPlugin);

      await pluginModel.update('test-plugin', { settings: { enabled: false } });

      const result = await pluginModel.findById('test-plugin');
      expect(result?.settings).toEqual({ enabled: false });
    });
  });
});
