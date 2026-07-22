import { App } from 'antd';
import { Split } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatStore } from '@/store/chat';

import { defineAction } from '../defineAction';

export const branchingAction = defineAction({
  key: 'branching',
  useBuild: (ctx) => {
    const { t } = useTranslation('common');
    const { message } = App.useApp();
    const [topic, openThreadCreator] = useChatStore((s) => [s.activeTopicId, s.openThreadCreator]);

    const action = useMemo(
      () => ({
        handleClick: () => {
          if (!topic) {
            message.warning(t('branchingRequiresSavedTopic'));
            return;
          }
          openThreadCreator(ctx.id);
        },
        icon: Split,
        key: 'branching',
        label: t('branching'),
      }),
      [t, ctx.id, topic, openThreadCreator, message],
    );

    // User-created threads branch from main-topic messages only. The message
    // history model does not define recursive ancestry for nested threads.
    return ctx.data.threadId ? null : action;
  },
});
