import { RotateCcw } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { messageStateSelectors, useConversationStore } from '../../../../store';
import { defineAction } from '../defineAction';

export const regenerateAction = defineAction({
  key: 'regenerate',
  useBuild: (ctx) => {
    const { t } = useTranslation('common');
    const isRegenerating = useConversationStore(
      messageStateSelectors.isMessageRegenerating(ctx.id),
    );
    const [regenerateUserMessage, regenerateAssistantMessage, deleteMessage] = useConversationStore(
      (s) => [s.regenerateUserMessage, s.regenerateAssistantMessage, s.deleteMessage],
    );

    return useMemo(
      () => ({
        disabled: isRegenerating,
        handleClick: () => {
          if (ctx.role === 'user') {
            // Never delete a user turn on retry. The regenerate we just fired is not
            // awaited, and it anchors the new assistant message on this very id via the
            // `messages.parent_id` FK. Deleting it races that insert: the assistant then
            // violates the FK, silently never lands, and the whole turn — prompt included
            // — is gone for good.
            regenerateUserMessage(ctx.id);
          } else {
            // Safe: the retry re-anchors on this message's PARENT user turn, not on the
            // assistant itself, so dropping the errored assistant cannot orphan the insert.
            regenerateAssistantMessage(ctx.id);
            if (ctx.data.error) deleteMessage(ctx.id);
          }
        },
        icon: RotateCcw,
        key: 'regenerate',
        label: t('regenerate'),
        spin: isRegenerating || undefined,
      }),
      [
        t,
        ctx.id,
        ctx.role,
        ctx.data.error,
        isRegenerating,
        regenerateUserMessage,
        regenerateAssistantMessage,
        deleteMessage,
      ],
    );
  },
});
