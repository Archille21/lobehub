import type * as BusinessConst from '@lobechat/business-const';
import { describe, expect, it, vi } from 'vitest';

/**
 * A deployment that ships no third-party integrations must not describe any.
 *
 * The claim "I can manage your Gmail" was never a hallucination — it was read
 * off the prompts and tool schemas below, which advertise Composio services and
 * LobeHub Skill providers unconditionally. Five packages carry that vocabulary
 * and each gates it separately, so this is checked in one place: fixing four of
 * five looks exactly like fixing all five until a user asks the assistant what
 * it can do.
 *
 * Tool `description` fields count. They are sent to the model with the tool
 * list, so a manifest naming Composio advertises it just as effectively as a
 * system prompt does.
 */
const THIRD_PARTY_NAMES = [
  'Airtable',
  'Composio',
  'Confluence',
  'Dropbox',
  'Figma',
  'Gmail',
  'Google Calendar',
  'Google Drive',
  'HubSpot',
  'Jira',
  'Linear',
  'LobehubSkill',
  'Notion',
  'Outlook',
  'Salesforce',
  'Slack',
  'Twitter',
];

/** Every model-facing surface these five tools expose. */
const loadSurfaces = async (integrationsEnabled: boolean): Promise<Record<string, string>> => {
  vi.resetModules();
  // Partial mock: these manifests pull in `@lobechat/const`, which needs the
  // rest of the branding surface. Overriding only the flags also keeps the test
  // honest — everything else is the real module.
  vi.doMock('@lobechat/business-const', async (importOriginal) => ({
    ...(await importOriginal<typeof BusinessConst>()),
    // The two flags move together in practice: a build with integrations off is
    // a single-provider business build.
    ENABLE_BUSINESS_FEATURES: !integrationsEnabled,
    EXTERNAL_INTEGRATIONS_ENABLED: integrationsEnabled,
  }));

  const [activator, agentBuilder, agentManagement, groupAgentBuilder, creds] = await Promise.all([
    import('@lobechat/builtin-tool-activator'),
    import('@lobechat/builtin-tool-agent-builder'),
    import('@lobechat/builtin-tool-agent-management'),
    import('@lobechat/builtin-tool-group-agent-builder'),
    import('@lobechat/builtin-tool-creds'),
  ]);

  // Serialising the manifest covers the system prompt (it is the `systemRole`
  // field) *and* every tool description in one string.
  return {
    'activator manifest': JSON.stringify(activator.LobeActivatorManifest),
    'agent-builder manifest': JSON.stringify(agentBuilder.AgentBuilderManifest),
    'agent-management manifest': JSON.stringify(agentManagement.AgentManagementManifest),
    'creds manifest': JSON.stringify(creds.CredsManifest),
    'group-agent-builder manifest': JSON.stringify(groupAgentBuilder.GroupAgentBuilderManifest),
  };
};

describe('third-party integrations disabled', () => {
  it('leaks no service name into any prompt or tool description', async () => {
    const surfaces = await loadSurfaces(false);

    const leaks = Object.entries(surfaces).flatMap(([surface, text]) =>
      THIRD_PARTY_NAMES.filter((name) => text.includes(name)).map(
        (name) => `${surface} -> ${name}`,
      ),
    );

    expect(leaks).toEqual([]);
  });

  // Scoped to the placeholders the gating itself introduces. A blanket
  // `{{...}}` check would be wrong here: `{{CREDS_LIST}}`, `{{username}}` and
  // friends are runtime substitutions that are *supposed* to reach the prompt
  // unresolved and get filled in per session.
  it('substitutes its own gating placeholders', async () => {
    const surfaces = await loadSurfaces(false);

    for (const [surface, text] of Object.entries(surfaces)) {
      expect(text, surface).not.toContain('{{INTEGRATIONS_SECTIONS}}');
      expect(text, surface).not.toContain('{{COMPOSIO_SECTIONS}}');
    }
  });
});

describe('third-party integrations enabled (upstream default)', () => {
  // The other half of the contract. Without it, "no leaks" is also satisfied by
  // deleting the capability from upstream, which is not what these gates do.
  it('still advertises the integrations upstream ships', async () => {
    const all = Object.values(await loadSurfaces(true)).join('\n');

    for (const name of ['Composio', 'LobehubSkill', 'Gmail', 'Linear', 'Notion'])
      expect(all, name).toContain(name);
  });
});
