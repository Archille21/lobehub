import type {
  LocalFileItem,
  LocalMoveFilesResultItem,
  LocalReadFileResult,
} from '@lobechat/electron-client-ipc';

// Re-export shared state types from @lobechat/tool-runtime
export type {
  EditFileState as EditLocalFileState,
  GlobFilesState,
  GrepContentState,
  RunCommandState,
} from '@lobechat/tool-runtime';

export const LocalSystemIdentifier = 'lobe-local-system';

export const LocalSystemApiName = {
  editFile: 'editFile',
  getCommandOutput: 'getCommandOutput',
  globFiles: 'globFiles',
  grepContent: 'grepContent',
  killCommand: 'killCommand',
  listFiles: 'listFiles',
  moveFiles: 'moveFiles',
  readFile: 'readFile',
  runCommand: 'runCommand',
  searchFiles: 'searchFiles',
  // Server-internal API (not in the LLM-facing manifest): uploads device-local
  // files to the LobeHub file store so server-side tools (e.g. visual analysis)
  // can access them by URL. Dispatched directly via the device gateway.
  uploadFiles: 'uploadFiles',
  writeFile: 'writeFile',
} as const;

// ==================== uploadFiles (server-internal) ====================

export interface UploadLocalFilesParams {
  paths: string[];
}

export interface UploadedLocalFileResult {
  /** Per-file failure reason; the other fields are unset when present. */
  error?: string;
  fileId?: string;
  mimeType?: string;
  name: string;
  path: string;
  size?: number;
  /** The stored file record's url (S3 pathname), resolvable via FileService. */
  url?: string;
}

export interface UploadLocalFilesState {
  files: UploadedLocalFileResult[];
}

export interface FileResult {
  contentType?: string;
  createdTime: Date;
  isDirectory: boolean;
  lastAccessTime: Date;
  metadata?: {
    [key: string]: any;
  };
  modifiedTime: Date;
  name: string;
  path: string;
  size: number;
  type: string;
}

// ==================== Local-System-Specific State Types ====================

export interface LocalFileSearchState {
  /** Search engine used (e.g., 'mdfind', 'fd', 'find', 'fast-glob') */
  engine?: string;
  /** Resolved search directory after scope resolution */
  resolvedPath?: string;
  searchResults: LocalFileItem[];
}

export interface LocalFileListState {
  listResults: LocalFileItem[];
  totalCount: number;
}

export interface LocalReadFileState {
  fileContent: LocalReadFileResult;
}

export interface LocalReadFilesState {
  filesContent: LocalReadFileResult[];
}

export interface LocalMoveFilesState {
  error?: string;
  results: LocalMoveFilesResultItem[];
  successCount: number;
  totalCount: number;
}

export interface LocalRenameFileState {
  error?: string;
  newPath: string;
  oldPath: string;
  success: boolean;
}
