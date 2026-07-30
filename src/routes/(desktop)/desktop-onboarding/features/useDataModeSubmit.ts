import { useCallback, useRef, useState } from 'react';

type DataMode = 'share' | 'privacy';

interface UseDataModeSubmitOptions {
  onNext: () => Promise<void> | void;
  selectedMode: DataMode;
  updateGeneralConfig: (general: { telemetry: boolean }) => Promise<void>;
}

export const useDataModeSubmit = ({
  onNext,
  selectedMode,
  updateGeneralConfig,
}: UseDataModeSubmitOptions) => {
  const [hasSaveError, setHasSaveError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);

  const handleNext = useCallback(async () => {
    if (isSavingRef.current) return;

    isSavingRef.current = true;
    setHasSaveError(false);
    setIsSaving(true);

    try {
      await updateGeneralConfig({ telemetry: selectedMode === 'share' });
      await onNext();
    } catch (error) {
      console.error('[DesktopOnboarding] Failed to save data sharing preference:', error);
      setHasSaveError(true);
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [onNext, selectedMode, updateGeneralConfig]);

  return { handleNext, hasSaveError, isSaving };
};
