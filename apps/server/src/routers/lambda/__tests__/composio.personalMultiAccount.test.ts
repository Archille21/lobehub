// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentModel } from '@/database/models/agent';
import { ConnectorModel } from '@/database/models/connector';
import { ConnectorToolModel } from '@/database/models/connectorTool';
import { PluginModel } from '@/database/models/plugin';

import { composioRouter } from '../composio';

const linkMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ id: 'acc-new', redirectUrl: 'http://redirect' }),
);

// Hoisted above the imports at runtime; kept below them for `import-x/first`.
vi.mock('@/database/models/agent', () => ({ AgentModel: vi.fn() }));
vi.mock('@/database/models/connector', () => ({ ConnectorModel: vi.fn() }));
vi.mock('@/database/models/connectorTool', () => ({ ConnectorToolModel: vi.fn() }));
vi.mock('@/database/models/plugin', () => ({ PluginModel: vi.fn() }));
vi.mock('@/config/composio', () => ({ getServerComposioAuthConfigId: () => 'auth-cfg-1' }));
vi.mock('@/libs/composio', () => ({
  getComposioClient: () => ({
    connectedAccounts: { delete: vi.fn(), link: linkMock },
    tools: { getRawComposioTools: async () => ({ items: [] }) },
  }),
}));
vi.mock('@/business/server/trpc-middlewares/workspaceAuth', async () => {
  const mod = await vi.importActual<{ trpc: any }>('@/libs/trpc/lambda/init');
  return {
    requireWorkspaceRoleWhenScoped: () => mod.trpc.middleware(async (opts: any) => opts.next()),
    wsCompatProcedure: mod.trpc.procedure,
  };
});
vi.mock('@/libs/trpc/lambda/middleware', () => ({
  serverDatabase: async (opts: any) =>
    opts.next({ ctx: { ...opts.ctx, serverDB: opts.ctx.serverDB ?? {} } }),
}));

/**
 * Personal multi-account (LOBE-12140): a user connecting a SECOND Gmail in
 * personal scope. The first account keeps the legacy behavior (single-account
 * default + legacy plugin-table row); additional ones pass allowMultiple and
 * live only in user_connectors, so the legacy PK — (user_id, identifier), which
 * can't hold two — is never asked to.
 */
describe('composioRouter — personal multi-account', () => {
  let connectorModelMock: any;
  let connectorToolModelMock: any;
  let pluginModelMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    linkMock.mockResolvedValue({ id: 'acc-new', redirectUrl: 'http://redirect' });
    connectorModelMock = {
      create: vi.fn().mockResolvedValue({ id: 'conn-new' }),
      delete: vi.fn(),
      findScopedByComposioAccount: vi.fn().mockResolvedValue(null),
      findScopedByIdentifier: vi.fn().mockResolvedValue(null),
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    };
    connectorToolModelMock = {
      deleteToolsNotIn: vi.fn(),
      queryByConnectorIds: vi.fn().mockResolvedValue([]),
      upsertMany: vi.fn(),
    };
    pluginModelMock = {
      create: vi.fn(),
      delete: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      query: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    };
    vi.mocked(ConnectorModel).mockImplementation(() => connectorModelMock);
    vi.mocked(ConnectorToolModel).mockImplementation(() => connectorToolModelMock);
    vi.mocked(PluginModel).mockImplementation(() => pluginModelMock);
    vi.mocked(AgentModel).mockImplementation(() => ({ existsOwnedById: async () => true }) as any);
  });

  // Personal scope: no workspaceId, no agentId.
  const personalCaller = () =>
    composioRouter.createCaller({ serverDB: {}, userId: 'user_test', workspaceId: null } as any);

  const input = { appSlug: 'gmail', identifier: 'gmail', label: 'Gmail' };

  describe('createConnection', () => {
    it('the FIRST personal account keeps the single-account default and writes the legacy row', async () => {
      // No existing account anywhere → first account.
      await personalCaller().createConnection(input);

      expect(linkMock.mock.calls[0][2]).not.toHaveProperty('allowMultiple');
      expect(pluginModelMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: 'gmail', source: 'composio' }),
      );
    });

    it('a SECOND account (first already in user_connectors) passes allowMultiple and skips the legacy row', async () => {
      // The first account already lives in the connector table (base row).
      connectorModelMock.findScopedByIdentifier.mockResolvedValue({
        id: 'conn-first',
        userId: 'user_test',
      });

      await personalCaller().createConnection(input);

      expect(linkMock).toHaveBeenCalledWith(
        'user_test',
        'auth-cfg-1',
        expect.objectContaining({ allowMultiple: true }),
      );
      expect(pluginModelMock.create).not.toHaveBeenCalled();
      // It still lands in user_connectors as its OWN new row.
      expect(connectorModelMock.create).toHaveBeenCalled();
    });

    it('detects the second account even when the first exists only in the legacy table', async () => {
      // Legacy-only first account (pre-dual-write), no connector row yet.
      pluginModelMock.findById.mockResolvedValue({
        customParams: { composio: { connectedAccountId: 'acc-old' } },
        identifier: 'gmail',
      });

      await personalCaller().createConnection(input);

      expect(linkMock.mock.calls[0][2]).toHaveProperty('allowMultiple', true);
      // The legacy row (first account) must not be overwritten by the second.
      expect(pluginModelMock.create).not.toHaveBeenCalled();
    });

    it('a new account creates its OWN connector row rather than overwriting a sibling', async () => {
      // Second account: base row for a DIFFERENT account exists (isAdditional),
      // but no row for THIS connectedAccountId yet.
      connectorModelMock.findScopedByIdentifier.mockResolvedValue({ id: 'conn-first' });
      connectorModelMock.findScopedByComposioAccount.mockResolvedValue(null);

      await personalCaller().createConnection(input);

      expect(connectorModelMock.create).toHaveBeenCalled();
      expect(connectorModelMock.update).not.toHaveBeenCalled();
    });

    it('reconnecting the SAME account updates its row, not a create', async () => {
      connectorModelMock.findScopedByIdentifier.mockResolvedValue({ id: 'conn-first' });
      // A row for this exact connectedAccountId already exists → update it.
      connectorModelMock.findScopedByComposioAccount.mockResolvedValue({ id: 'conn-existing' });

      await personalCaller().createConnection(input);

      expect(connectorModelMock.update).toHaveBeenCalledWith('conn-existing', expect.anything());
      expect(connectorModelMock.create).not.toHaveBeenCalled();
    });
  });

  describe('deleteConnection', () => {
    it('deleting a SECOND account does not wipe the first account’s legacy row', async () => {
      // Legacy row belongs to the FIRST account (acc-old); we delete acc-2.
      pluginModelMock.findById.mockResolvedValue({
        customParams: { composio: { connectedAccountId: 'acc-old' } },
        identifier: 'gmail',
      });
      connectorModelMock.findScopedByComposioAccount.mockResolvedValue({ id: 'conn-2' });

      await personalCaller().deleteConnection({
        connectedAccountId: 'acc-2',
        identifier: 'gmail',
      });

      expect(pluginModelMock.delete).not.toHaveBeenCalled();
      // The connector-table row for acc-2 IS removed.
      expect(connectorModelMock.delete).toHaveBeenCalledWith('conn-2');
    });

    it('deleting the FIRST account (the legacy one) removes its legacy row', async () => {
      pluginModelMock.findById.mockResolvedValue({
        customParams: { composio: { connectedAccountId: 'acc-old' } },
        identifier: 'gmail',
      });
      connectorModelMock.findScopedByComposioAccount.mockResolvedValue({ id: 'conn-old' });

      await personalCaller().deleteConnection({
        connectedAccountId: 'acc-old',
        identifier: 'gmail',
      });

      expect(pluginModelMock.delete).toHaveBeenCalledWith('gmail');
    });
  });

  describe('getComposioPlugins — account-level dedup', () => {
    it('collapses the legacy row and its connector-row twin (same account) into one', async () => {
      pluginModelMock.query.mockResolvedValue([
        {
          customParams: { composio: { connectedAccountId: 'acc-1', status: 'ACTIVE' } },
          identifier: 'gmail',
          manifest: {},
        },
      ]);
      connectorModelMock.query.mockResolvedValue([
        {
          id: 'conn-1',
          identifier: 'gmail',
          metadata: { composio: { connectedAccountId: 'acc-1', status: 'ACTIVE' } },
          name: 'Gmail',
        },
      ]);

      const result = await personalCaller().getComposioPlugins();

      expect(result).toHaveLength(1);
    });

    it('keeps a second, genuinely different account of the same identifier', async () => {
      pluginModelMock.query.mockResolvedValue([
        {
          customParams: { composio: { connectedAccountId: 'acc-1', status: 'ACTIVE' } },
          identifier: 'gmail',
          manifest: {},
        },
      ]);
      connectorModelMock.query.mockResolvedValue([
        {
          id: 'conn-2',
          identifier: 'gmail',
          metadata: { composio: { connectedAccountId: 'acc-2', status: 'ACTIVE' } },
          name: 'Gmail',
        },
      ]);

      const result = await personalCaller().getComposioPlugins();

      expect(result).toHaveLength(2);
    });
  });
});
