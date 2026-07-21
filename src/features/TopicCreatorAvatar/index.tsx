'use client';

import { Avatar, Tooltip } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { memo, type PropsWithChildren } from 'react';

import { useAuthorInfo } from '@/business/client/hooks/useAuthorInfo';

/**
 * Resolves a topic creator's profile from the *active workspace* members.
 * `useAuthorInfo` is a business slot: cloud resolves the member profile, the
 * open-source build is a no-op — and it returns `undefined` without an active
 * workspace, so all creator-avatar UI disappears in personal mode.
 */
export const useTopicCreator = (userId?: string) => useAuthorInfo(userId);

interface TopicCreatorAvatarProps {
  /** Size of the avatar in px. */
  size?: number;
  /** Creator (author) of the topic. */
  userId?: string;
}

/**
 * Round creator avatar for a workspace topic row's leading icon slot — it
 * replaces the default `#` placeholder so the shared list reads like a
 * conversation list. Renders nothing when the creator doesn't resolve
 * (personal mode / unknown member).
 */
const TopicCreatorAvatar = memo<TopicCreatorAvatarProps>(({ userId, size = 20 }) => {
  const author = useTopicCreator(userId);

  if (!author) return null;

  return (
    <Tooltip title={author.fullName}>
      <Avatar
        avatar={author.avatar ?? undefined}
        shape={'circle'}
        size={size}
        style={{ flex: 'none' }}
        title={author.fullName ?? undefined}
      />
    </Tooltip>
  );
});

TopicCreatorAvatar.displayName = 'TopicCreatorAvatar';

interface TopicCreatorCornerProps extends PropsWithChildren {
  /** Size of the corner avatar in px. */
  size?: number;
  /** Creator (author) of the topic. */
  userId?: string;
}

/**
 * Wraps a topic row's own identity icon (bot platform, PR marker, …) and
 * overlays a mini round creator avatar at its bottom-right corner, so rows
 * that keep their original icon still carry the creator at a glance.
 */
export const TopicCreatorCorner = memo<TopicCreatorCornerProps>(
  ({ userId, size = 11, children }) => {
    const author = useTopicCreator(userId);

    if (!author) return children;

    return (
      <span style={{ display: 'inline-flex', lineHeight: 0, position: 'relative' }}>
        {children}
        <Tooltip title={author.fullName}>
          <span
            style={{
              borderRadius: '50%',
              bottom: -3,
              // Ring the mini avatar with the panel background so it reads as
              // an overlay instead of colliding with the icon underneath.
              boxShadow: `0 0 0 1.5px ${cssVar.colorBgLayout}`,
              display: 'inline-flex',
              lineHeight: 0,
              position: 'absolute',
              right: -3,
            }}
          >
            <Avatar
              avatar={author.avatar ?? undefined}
              shape={'circle'}
              size={size}
              title={author.fullName ?? undefined}
            />
          </span>
        </Tooltip>
      </span>
    );
  },
);

TopicCreatorCorner.displayName = 'TopicCreatorCorner';

export default TopicCreatorAvatar;
