import { RequestTrigger } from '@lobechat/types';
import debug from 'debug';

import { getProviderContentPolicyErrorMessage } from '@/business/server/getProviderContentPolicyErrorMessage';
import { trackProviderContentPolicyViolation } from '@/business/server/trackProviderContentPolicyViolation';
import { AsyncTaskModel } from '@/database/models/asyncTask';
import { GenerationModel } from '@/database/models/generation';
import type { LobeChatDatabase } from '@/database/type';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { VideoGenerationService } from '@/server/services/generation/video';
import { buildVideoGenerationFilePayload } from '@/server/services/generation/videoFile';
import { AsyncTaskError, AsyncTaskErrorType, AsyncTaskStatus } from '@/types/asyncTask';
import { FileSource } from '@/types/files';
import type { VideoGenerationAsset } from '@/types/generation';

const log = debug('lobe-video:background-polling');

interface BackgroundPollingParams {
  asyncTaskCreatedAt: Date;
  asyncTaskId: string;
  generationBatchId: string;
  generationId: string;
  generationTopicId: string;
  inferenceId: string;
  model: string;
  prechargeResult?: any;
  provider: string;
  userId: string;
  workspaceId?: string;
}

export async function processBackgroundVideoPolling(
  db: LobeChatDatabase,
  params: BackgroundPollingParams,
): Promise<void> {
  const {
    asyncTaskCreatedAt,
    asyncTaskId,
    generationBatchId,
    generationId,
    inferenceId,
    model,
    provider,
    userId,
    workspaceId,
  } = params;

  log(
    'Starting background video polling for task: %s (provider: %s, inferenceId: %s)',
    asyncTaskId,
    provider,
    inferenceId,
  );

  try {
    const asyncTaskModel = new AsyncTaskModel(db, userId, workspaceId);
    const videoService = new VideoGenerationService(db, userId, workspaceId);
    const generationModel = new GenerationModel(db, userId, workspaceId);

    const modelRuntime = await initModelRuntimeFromDB(db, userId, provider, workspaceId);
    const pollResult = await pollUntilCompletion(modelRuntime, inferenceId, model);

    if (!pollResult) {
      throw new Error('Polling completed but no video URL returned');
    }

    log('Video polling succeeded for task: %s, processing video...', asyncTaskId);

    const processResult = await videoService.processVideoForGeneration(pollResult.videoUrl, {
      headers: pollResult.headers,
    });

    const asset: VideoGenerationAsset = {
      coverUrl: processResult.coverKey,
      duration: processResult.duration,
      height: processResult.height,
      originalUrl: pollResult.videoUrl,
      thumbnailUrl: processResult.thumbnailKey,
      type: 'video',
      url: processResult.videoKey,
      width: processResult.width,
    };

    const batch = await db.query.generationBatches.findFirst({
      where: (batches, { eq }) => eq(batches.id, generationBatchId),
    });

    await generationModel.createAssetAndFile(
      generationId,
      asset,
      buildVideoGenerationFilePayload({
        generationId,
        processResult,
        prompt: batch?.prompt,
      }),
      FileSource.VideoGeneration,
    );

    const duration = Date.now() - asyncTaskCreatedAt.getTime();

    await asyncTaskModel.update(asyncTaskId, {
      duration,
      status: AsyncTaskStatus.Success,
    });

    log('Video processing completed successfully for task: %s', asyncTaskId);
  } catch (error) {
    // Always visible regardless of DEBUG: this is the terminal "why the video
    // never showed up" reason, not routine per-attempt tracing — matches the
    // console.error already used for the infra-level catch in the caller
    // (routers/lambda/video/index.ts).
    console.error(`[video] Background polling failed for task ${asyncTaskId}:`, error);

    const asyncTaskModel = new AsyncTaskModel(db, userId, workspaceId);
    const providerContentPolicyMessage = await getProviderContentPolicyErrorMessage({
      error,
      provider,
      trigger: RequestTrigger.Video,
      userId,
    });
    if (providerContentPolicyMessage) {
      try {
        await trackProviderContentPolicyViolation({
          error,
          model,
          provider,
          trigger: 'video-polling',
          userId,
        });
      } catch (trackError) {
        log('Failed to track provider content policy violation: %O', trackError);
      }
    }
    await asyncTaskModel.update(asyncTaskId, {
      error: new AsyncTaskError(
        providerContentPolicyMessage
          ? AsyncTaskErrorType.ProviderContentModeration
          : AsyncTaskErrorType.ServerError,
        providerContentPolicyMessage ??
          'Background polling failed: ' +
            (error instanceof Error ? error.message : 'Unknown error'),
      ),
      status: AsyncTaskStatus.Error,
    });
  }
}

async function pollUntilCompletion(
  modelRuntime: any,
  inferenceId: string,
  model: string,
): Promise<{ headers?: Record<string, string>; videoUrl: string } | null> {
  const maxRetries = 120;
  const pollingInterval = 5000;
  const startedAt = Date.now();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

    try {
      // Log the raw result (not just the status label) so a "failed" from the
      // upstream provider is diagnosable from this line alone, and the elapsed
      // time so a mid-flight platform kill (no further lines after this one)
      // can be told apart from a genuine multi-minute in-progress wait.
      log(
        'Polling attempt %d/%d for task: %s (elapsed %ds)',
        attempt + 1,
        maxRetries,
        inferenceId,
        elapsedSec,
      );

      const result = await modelRuntime.handlePollVideoStatus(inferenceId, model);

      log('Poll result for task %s at %ds: %O', inferenceId, elapsedSec, result);

      if (result.status === 'success') {
        log('Video generation succeeded for task: %s after %ds', inferenceId, elapsedSec);
        return { headers: result.headers, videoUrl: result.videoUrl };
      }

      if (result.status === 'failed') {
        throw new Error(`Video generation failed: ${result.error}`);
      }

      await sleep(pollingInterval);
    } catch (error) {
      if (error instanceof Error && error.message.includes('failed')) {
        throw error;
      }
      log(
        'Polling attempt %d failed for task: %s at %ds: %O',
        attempt + 1,
        inferenceId,
        elapsedSec,
        error,
      );
      await sleep(pollingInterval);
    }
  }

  throw new Error(
    `Video generation timeout after ${maxRetries} attempts (${(maxRetries * pollingInterval) / 1000}s)`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
