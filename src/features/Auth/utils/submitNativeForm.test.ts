import type { MouseEvent as ReactMouseEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { submitNativeFormWithLoading } from './submitNativeForm';

afterEach(() => {
  document.body.replaceChildren();
});

describe('submitNativeFormWithLoading', () => {
  it('submits with the active submitter before loading disables it', () => {
    const form = document.createElement('form');
    const button = document.createElement('button');
    button.name = 'consent';
    button.type = 'submit';
    button.value = 'accept';
    form.append(button);
    document.body.append(form);

    const eventOrder: string[] = [];
    let disabledAtSubmit: boolean | undefined;
    let submittedConsent: FormDataEntryValue | null = null;

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      eventOrder.push('submit');

      const submitter = (event as SubmitEvent).submitter as HTMLButtonElement;
      disabledAtSubmit = submitter.disabled;
      submittedConsent = new FormData(form, submitter).get('consent');
    });

    const preventDefault = vi.fn();
    const setLoading = vi.fn(() => {
      eventOrder.push('loading');
      button.disabled = true;
    });

    submitNativeFormWithLoading(
      { currentTarget: button, preventDefault } as unknown as ReactMouseEvent<HTMLButtonElement>,
      setLoading,
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(eventOrder).toEqual(['submit', 'loading']);
    expect(disabledAtSubmit).toBe(false);
    expect(submittedConsent).toBe('accept');
    expect(setLoading).toHaveBeenCalledWith(true);
    expect(button.disabled).toBe(true);
  });
});
