import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useDataModeSubmit } from './useDataModeSubmit';

describe('useDataModeSubmit hook', () => {
  it('waits for telemetry persistence before advancing', async () => {
    let resolveSave!: () => void;
    const save = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const updateGeneralConfig = vi.fn().mockReturnValue(save);
    const onNext = vi.fn();
    const { result } = renderHook(() =>
      useDataModeSubmit({ onNext, selectedMode: 'privacy', updateGeneralConfig }),
    );

    let submit!: Promise<void>;
    act(() => {
      submit = result.current.handleNext();
    });

    expect(updateGeneralConfig).toHaveBeenCalledWith({ telemetry: false });
    expect(onNext).not.toHaveBeenCalled();
    expect(result.current.isSaving).toBe(true);

    await act(async () => {
      resolveSave();
      await submit;
    });

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(result.current.isSaving).toBe(false);
  });

  it('keeps navigation blocked and allows retry when telemetry persistence fails', async () => {
    const error = new Error('save failed');
    const updateGeneralConfig = vi.fn().mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onNext = vi.fn();
    const { result } = renderHook(() =>
      useDataModeSubmit({ onNext, selectedMode: 'share', updateGeneralConfig }),
    );

    await act(async () => {
      await result.current.handleNext();
    });

    expect(onNext).not.toHaveBeenCalled();
    expect(result.current.hasSaveError).toBe(true);
    expect(result.current.isSaving).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      '[DesktopOnboarding] Failed to save data sharing preference:',
      error,
    );

    consoleError.mockRestore();
  });
});
