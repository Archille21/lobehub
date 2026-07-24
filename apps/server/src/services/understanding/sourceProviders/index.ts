import type { UnderstandingSourceProvider } from '../types';
import { githubUnderstandingSourceProvider } from './github';
import { gmailUnderstandingSourceProvider } from './gmail';

export const understandingSourceProviders = [
  githubUnderstandingSourceProvider,
  gmailUnderstandingSourceProvider,
] as const satisfies readonly UnderstandingSourceProvider[];

export const understandingSourceProviderMap = new Map<string, UnderstandingSourceProvider>(
  understandingSourceProviders.map((sourceProvider) => [sourceProvider.id, sourceProvider]),
);

export { githubUnderstandingSourceProvider, gmailUnderstandingSourceProvider };
