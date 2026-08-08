// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as clientDataStore from '@/client-data';
import * as cacheScope from '@/libs/swr/useCacheScope';
import { briefService } from '@/services/brief';

import { BriefListActionImpl } from './action';

describe('BriefListActionImpl', () => {
  const clientDataActions = {
    deleteBriefEntity: vi.fn(),
    resolveBriefEntitiesAsRead: vi.fn(),
    updateBriefReadState: vi.fn(),
    updateBriefResolution: vi.fn(),
  };

  const createAction = () => new BriefListActionImpl(vi.fn() as never, vi.fn() as never);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(100);
    vi.spyOn(cacheScope, 'getCacheScope').mockReturnValue('user-1:workspace-1');
    vi.spyOn(clientDataStore, 'getClientDataStoreState').mockReturnValue(
      clientDataActions as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves briefs as read through the canonical Home index', async () => {
    const action = createAction();
    vi.spyOn(briefService, 'resolveManyAsRead').mockResolvedValue({
      data: ['brief-resolved'],
    } as never);

    await action.resolveBriefsAsRead(['brief-resolved', 'brief-remaining']);

    expect(clientDataActions.resolveBriefEntitiesAsRead).toHaveBeenCalledWith(
      'user-1:workspace-1',
      ['brief-resolved'],
      expect.any(String),
      100,
    );
  });

  it('writes read state through the canonical entity mutation path', async () => {
    const action = createAction();
    vi.spyOn(briefService, 'markRead').mockResolvedValue({
      data: { readAt: '2026-07-31T01:00:00.000Z' },
    } as never);

    await action.markBriefRead('brief-1');

    expect(clientDataActions.updateBriefReadState).toHaveBeenCalledWith(
      'user-1:workspace-1',
      'brief-1',
      '2026-07-31T01:00:00.000Z',
      100,
    );
  });

  it('uses the request-start observation for an authoritative Brief resolution', async () => {
    const action = createAction();
    vi.spyOn(briefService, 'resolve').mockResolvedValue({
      data: {
        resolvedAction: 'approve',
        resolvedAt: '2026-07-31T02:00:00.000Z',
        resolvedComment: null,
      },
    } as never);

    await action.resolveBrief('brief-1', 'approve');

    expect(clientDataActions.updateBriefResolution).toHaveBeenCalledWith(
      'user-1:workspace-1',
      'brief-1',
      {
        resolvedAction: 'approve',
        resolvedAt: '2026-07-31T02:00:00.000Z',
        resolvedComment: null,
      },
      100,
    );
  });

  it('tombstones a deleted brief in the canonical entity graph', async () => {
    const action = createAction();
    vi.spyOn(briefService, 'delete').mockResolvedValue(undefined as never);

    await action.deleteBrief('brief-deleted');

    expect(clientDataActions.deleteBriefEntity).toHaveBeenCalledWith(
      'user-1:workspace-1',
      'brief-deleted',
      100,
    );
  });
});
