import { describe, expect, it, vi } from 'vitest';

import { gmailUnderstandingSourceProvider } from './gmail';

describe('gmailUnderstandingSourceProvider', () => {
  it('delegates the local connection check', async () => {
    const connectorData = { hasGmailConnection: vi.fn(async () => true) };

    await expect(
      gmailUnderstandingSourceProvider.isConnected({ connectorData, userId: 'user-id' } as never),
    ).resolves.toBe(true);
    expect(connectorData.hasGmailConnection).toHaveBeenCalledOnce();
  });

  it('validates Gmail only when the connected account grants a readable mail scope', async () => {
    const getAccount = vi
      .fn()
      .mockResolvedValueOnce({
        scopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'],
      })
      .mockResolvedValueOnce({ scopes: ['openid', 'profile'] });
    const connectorData = {
      getGmailClient: vi.fn(async () => ({ getAccount })),
    };

    await expect(
      gmailUnderstandingSourceProvider.validate({ connectorData, userId: 'user-id' } as never),
    ).resolves.toBe(true);
    await expect(
      gmailUnderstandingSourceProvider.validate({ connectorData, userId: 'user-id' } as never),
    ).resolves.toBe(false);
  });
});
