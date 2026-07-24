import type { CollectionDiagnostics } from '@lobechat/types';

import type { ConnectorDataService } from '@/server/services/connectorData';

/** Collected evidence and diagnostics produced by one Understanding source provider. */
export interface CollectedUnderstandingSourceProviderContext {
  context: string;
  diagnostics: CollectionDiagnostics;
  sourceCount: number;
}

/** Runtime dependencies shared by source provider connection, validation, and collection hooks. */
export interface UnderstandingSourceProviderContext {
  connectorData: ConnectorDataService;
  userId: string;
}

/** Defines one independently connectable and collectable Understanding data source. */
export interface UnderstandingSourceProvider {
  /** Collects bounded evidence for the Understanding workflow. */
  collect: (
    input: UnderstandingSourceProviderContext,
  ) => Promise<CollectedUnderstandingSourceProviderContext>;
  readonly id: string;
  /** Checks local persistence only and must not call the external provider. */
  isConnected: (input: UnderstandingSourceProviderContext) => Promise<boolean>;
  /** Performs the provider-specific remote authorization and capability check. */
  validate: (input: UnderstandingSourceProviderContext) => Promise<boolean>;
}
