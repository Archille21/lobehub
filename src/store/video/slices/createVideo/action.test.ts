import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { videoService } from '@/services/video';
import { useVideoStore } from '@/store/video';

vi.mock('@/business/client/handleGenerationPromptModerationError', () => ({
  handleGenerationPromptModerationError: vi.fn(),
}));
vi.mock('@/business/client/handleLobeHubModelDeprecatedError', () => ({
  handleLobeHubModelDeprecatedError: vi.fn(),
}));
vi.mock('@/services/video', () => ({
  videoService: {
    createVideo: vi.fn(),
  },
}));

describe('CreateVideoAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(videoService.createVideo).mockResolvedValue({ success: true } as any);

    useVideoStore.setState({
      activeGenerationTopicId: 'topic-1',
      editingGenerationId: undefined,
      isCreating: false,
      isCreatingWithNewTopic: false,
      model: 'gemini-omni-flash-preview',
      parameters: {
        aspectRatio: '16:9',
        prompt: 'Make the camera move more slowly',
      },
      provider: 'google',
      refreshGenerationBatches: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('should pass the source generation and clear edit state after success', async () => {
    const { result } = renderHook(() => useVideoStore());

    act(() => {
      result.current.startEditingVideo('generation-source');
    });

    await act(async () => {
      await result.current.createVideo();
    });

    expect(videoService.createVideo).toHaveBeenCalledWith({
      generationTopicId: 'topic-1',
      model: 'gemini-omni-flash-preview',
      params: {
        aspectRatio: '16:9',
        prompt: 'Make the camera move more slowly',
      },
      previousGenerationId: 'generation-source',
      provider: 'google',
    });
    expect(result.current.editingGenerationId).toBeUndefined();
    expect(result.current.parameters?.prompt).toBe('');
  });

  it('should preserve the prompt and edit state when creation fails', async () => {
    vi.mocked(videoService.createVideo).mockRejectedValueOnce(new Error('API failed'));
    const { result } = renderHook(() => useVideoStore());

    act(() => {
      result.current.startEditingVideo('generation-source');
    });

    await expect(
      act(async () => {
        await result.current.createVideo();
      }),
    ).rejects.toThrow('API failed');

    expect(result.current.editingGenerationId).toBe('generation-source');
    expect(result.current.parameters?.prompt).toBe('Make the camera move more slowly');
  });

  it('should cancel editing without clearing the prompt', () => {
    const { result } = renderHook(() => useVideoStore());

    act(() => {
      result.current.startEditingVideo('generation-source');
      result.current.cancelEditingVideo();
    });

    expect(result.current.editingGenerationId).toBeUndefined();
    expect(result.current.parameters?.prompt).toBe('Make the camera move more slowly');
  });
});
