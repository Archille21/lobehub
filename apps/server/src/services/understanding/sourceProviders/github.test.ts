import type { GitHubConnectorClient, GitHubUserProfile } from '@lobechat/connector-data/github';
import { describe, expect, it, vi } from 'vitest';

import { githubUnderstandingSourceProvider } from './github';

describe('githubUnderstandingSourceProvider', () => {
  it('delegates local connection checks and actively validates the profile endpoint', async () => {
    const getUserProfile = vi.fn(async () => ({
      externalAccountId: 'account-id',
      login: 'octocat',
    }));
    const connectorData = {
      getGitHubClient: vi.fn(async () => ({ getUserProfile })),
      hasGitHubConnection: vi.fn(async () => true),
    };

    await expect(
      githubUnderstandingSourceProvider.isConnected({ connectorData, userId: 'user-id' } as never),
    ).resolves.toBe(true);
    await expect(
      githubUnderstandingSourceProvider.validate({ connectorData, userId: 'user-id' } as never),
    ).resolves.toBe(true);
    expect(connectorData.hasGitHubConnection).toHaveBeenCalledOnce();
    expect(getUserProfile).toHaveBeenCalledOnce();
  });

  it('starts supplemental collection without waiting for the profile', async () => {
    let resolveProfile: (profile: GitHubUserProfile) => void;
    const profile = new Promise<GitHubUserProfile>((resolve) => {
      resolveProfile = resolve;
    });
    const started = new Set<string>();
    const supplemental = <T>(name: string, result: T) =>
      vi.fn(async () => {
        started.add(name);
        return result;
      });
    const client = {
      getUserProfile: vi.fn(() => profile),
      getUserProfileReadme: supplemental('readme', undefined),
      listPinnedRepositories: supplemental('pinned', []),
      listRecentContributions: supplemental('contributions', []),
      listRecentPullRequests: supplemental('pullRequests', []),
      listRecentRepositories: supplemental('repositories', []),
      listRepositoryContributors: vi.fn(),
      listUserOrganizations: supplemental('organizations', []),
    } satisfies GitHubConnectorClient;

    const collecting = githubUnderstandingSourceProvider.collect({
      connectorData: {
        getGitHubClient: vi.fn(async () => client),
      } as never,
      userId: 'user-id',
    });

    await vi.waitFor(() => expect(started.size).toBe(6));
    resolveProfile!({ externalAccountId: 'account-id', login: 'octocat' });

    await expect(collecting).resolves.toMatchObject({
      diagnostics: { failedCount: 0, succeededCount: 7 },
      sourceCount: 1,
    });
  });
});
