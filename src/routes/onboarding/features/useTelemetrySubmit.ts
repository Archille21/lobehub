import { useCallback, useRef, useState } from 'react';

interface UseTelemetrySubmitOptions {
  onNext: () => Promise<void> | void;
  updateGeneralConfig: (general: { telemetry: boolean }) => Promise<void>;
}

export const useTelemetrySubmit = ({ onNext, updateGeneralConfig }: UseTelemetrySubmitOptions) => {
  const [hasSaveError, setHasSaveError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);

  const handleChoice = useCallback(
    async (enabled: boolean) => {
      if (isSavingRef.current) return;

      isSavingRef.current = true;
      setHasSaveError(false);
      setIsSaving(true);

      try {
        await updateGeneralConfig({ telemetry: enabled });
        await onNext();
      } catch (error) {
        console.error('[Onboarding] Failed to save telemetry preference:', error);
        setHasSaveError(true);
      } finally {
        isSavingRef.current = false;
        setIsSaving(false);
      }
    },
    [onNext, updateGeneralConfig],
  );

  return { handleChoice, hasSaveError, isSaving };
};
