import type { MouseEvent } from 'react';

/**
 * Start the native submission before loading disables the submit button.
 * This also preserves the submitter's name/value in the form payload.
 */
export const submitNativeFormWithLoading = (
  event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
  setLoading: (loading: boolean) => void,
) => {
  const submitter = event.currentTarget;

  if (!(submitter instanceof HTMLButtonElement)) return;

  const form = submitter.form;

  if (!form) return;

  event.preventDefault();
  form.requestSubmit(submitter);
  setLoading(true);
};
