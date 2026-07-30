import { BRANDING_EMAIL, SOCIAL_URL } from '@lobechat/business-const';
import { describe, expect, it } from 'vitest';

import { EMAIL_SUPPORT_ADDRESS, getEmailSupportHtml, getEmailSupportText } from './support';

// Both channels are deployment-configurable branding slots, and a white-label
// deployment may have neither. So these assertions are written against the
// configured values rather than upstream's, and each channel's expectations are
// guarded on it actually being configured.
const support: string | undefined = BRANDING_EMAIL.support || undefined;
const discord: string | undefined = SOCIAL_URL.discord || undefined;

describe('email support helpers', () => {
  it('renders actionable support links for the configured channels', () => {
    const html = getEmailSupportHtml();
    const text = getEmailSupportText();

    expect(EMAIL_SUPPORT_ADDRESS).toBe(support);

    if (support) {
      expect(html).toContain(`href="mailto:${support}"`);
      expect(text).toContain(support);
    }

    if (discord) {
      expect(html).toContain(discord);
      expect(text).toContain(discord);
    }
  });

  it('omits a channel the deployment did not configure', () => {
    const html = getEmailSupportHtml();
    const text = getEmailSupportText();

    // These ship in real outgoing mail, where a dead link cannot be taken back.
    expect(html).not.toContain('mailto:undefined');
    expect(html).not.toContain('href=""');
    expect(text).not.toContain('undefined');

    if (!support && !discord) expect(html).toBe('');
  });

  it('escapes localized labels before rendering HTML', () => {
    const html = getEmailSupportHtml({
      contactSupport: '<script>alert("support")</script>',
      joinDiscord: '<strong>Discord</strong>',
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<strong>');

    if (support) expect(html).toContain('&lt;script&gt;');
    if (discord) expect(html).toContain('&lt;strong&gt;');
  });
});
