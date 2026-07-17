import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getTrpcClient } from '../api/client';
import { detectMimeType, uploadLocalFile } from '../utils/uploadLocalFile';

/**
 * Per-file result shape mirroring the desktop gateway's `uploadFiles` handler
 * and `UploadedLocalFileResult` in `@lobechat/builtin-tool-local-system`. A
 * `error` entry means the other fields are unset for that path.
 */
interface UploadedLocalFileResult {
  error?: string;
  fileId?: string;
  mimeType?: string;
  name: string;
  path: string;
  size?: number;
  url?: string;
}

/** Per-file cap for server-requested media uploads (matches the desktop path). */
const UPLOAD_LOCAL_FILE_MAX_BYTES = 100 * 1024 * 1024;

/** Only image/video media may be pulled off the device by a server tool. */
const isSupportedVisualMediaMime = (mimeType: string) =>
  mimeType.startsWith('image/') || mimeType.startsWith('video/');

/**
 * Server-internal `uploadFiles` tool for the `lh connect` daemon: uploads
 * device-local media into the LobeHub file store so a server-side tool (the
 * visual-analysis bridge) can reach it by URL. Mirrors the desktop
 * `GatewayConnectionCtr.uploadLocalFilesForServer` contract — per-file errors
 * so one bad path does not fail the batch — but uses the CLI's real tRPC file
 * client instead of the Electron lambda-fetch port.
 *
 * Not registered in the LLM-facing manifest; only dispatched server-side.
 */
export const uploadFiles = async (args: {
  paths?: unknown;
}): Promise<{
  content: string;
  error?: string;
  state: { files: UploadedLocalFileResult[] };
  success: boolean;
}> => {
  const paths = Array.isArray(args?.paths)
    ? args.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : [];

  if (paths.length === 0) {
    return {
      content: 'uploadFiles requires a non-empty "paths" array.',
      error: 'uploadFiles requires a non-empty "paths" array.',
      state: { files: [] },
      success: false,
    };
  }

  const client = await getTrpcClient();

  const files = await Promise.all(
    paths.map(async (rawPath): Promise<UploadedLocalFileResult> => {
      const resolvedPath = rawPath.startsWith('~/')
        ? path.join(os.homedir(), rawPath.slice(2))
        : rawPath;
      const name = path.basename(resolvedPath);

      try {
        const stat = await fs.promises.stat(resolvedPath);
        if (!stat.isFile()) return { error: 'Not a regular file.', name, path: rawPath };
        if (stat.size > UPLOAD_LOCAL_FILE_MAX_BYTES) {
          return {
            error: `File is ${stat.size} bytes, exceeding the ${UPLOAD_LOCAL_FILE_MAX_BYTES} byte upload limit.`,
            name,
            path: rawPath,
          };
        }

        const mimeType = detectMimeType(name);
        if (!isSupportedVisualMediaMime(mimeType)) {
          return {
            error: `Unsupported media type "${mimeType}". Only image/video files can be uploaded.`,
            name,
            path: rawPath,
          };
        }

        const record = (await uploadLocalFile(client, resolvedPath)) as { id: string; url: string };

        return {
          fileId: record.id,
          mimeType,
          name,
          path: rawPath,
          size: stat.size,
          url: record.url,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          name,
          path: rawPath,
        };
      }
    }),
  );

  const failed = files.filter((f) => f.error);

  return {
    content: JSON.stringify({ files }),
    ...(failed.length > 0 && {
      error: `${failed.length}/${files.length} file(s) failed to upload.`,
    }),
    state: { files },
    success: failed.length === 0,
  };
};
