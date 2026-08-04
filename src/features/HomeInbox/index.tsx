import { Flexbox } from '@lobehub/ui';
import { createStaticStyles, cx } from 'antd-style';
import { Fragment, memo } from 'react';

import AsyncError from '@/components/AsyncError';
import { BriefCardSkeleton } from '@/features/DailyBrief/BriefCardSkeleton';
import GroupBlock from '@/features/Home/components/GroupBlock';
import { homeType } from '@/features/Home/components/homeType';
import RailCard from '@/features/Home/components/RailCard';
import Recommendations from '@/features/Recommendations';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/slices/auth/selectors';

import { useHomeInboxSections } from './useHomeInboxSections';

const styles = createStaticStyles(({ css }) => ({
  subtitle: css`
    margin-inline-start: 8px;
  `,
}));

interface HomeInboxProps {
  hideNeedsYou?: boolean;
  hideUnread?: boolean;
  /**
   * Main column only: the rail is collapsed, so the sections it owns (running,
   * news) fold into this column instead of disappearing with it.
   */
  inlineRail?: boolean;
  variant?: 'default' | 'main' | 'rail';
}

const HomeInbox = memo<HomeInboxProps>(
  ({ hideNeedsYou, hideUnread, inlineRail, variant = 'default' }) => {
    const isRail = variant === 'rail';
    const isMain = variant === 'main';
    const isLogin = useUserStore(authSelectors.isLogin);

    const { briefsError, recommendationsVisible, retryBriefs, sections, status } =
      useHomeInboxSections({ hideNeedsYou, hideUnread, inlineRail, variant });

    if (!isLogin) return null;

    // The brief feed is the primary content; a first-load failure blocks the whole
    // surface. No fabricated section heading — we don't know what's under it yet.
    if (status === 'error') {
      return <AsyncError error={briefsError} variant={'block'} onRetry={retryBriefs} />;
    }

    // First load: bare skeletons, no group heading (loading must not assert a
    // "Needs you" section that may turn out empty). Recommendations keep their own.
    if (status === 'loading') {
      return (
        <Flexbox gap={12}>
          <BriefCardSkeleton />
          <BriefCardSkeleton />
          <Recommendations variant={variant} />
        </Flexbox>
      );
    }

    if (sections.length === 0) {
      if (isMain) return null;

      if (isRail)
        return (
          <Flexbox gap={12}>
            <Recommendations variant={'rail'} />
          </Flexbox>
        );

      // With no titled block above it, the bare recommendations list doesn't need
      // the full section gap below the input area — offset the parent's gap so it
      // sits closer to the input.
      return (
        <>
          {recommendationsVisible && (
            <Flexbox style={{ marginBlockStart: -24 }}>
              <Recommendations />
            </Flexbox>
          )}
        </>
      );
    }

    return (
      <Flexbox gap={isRail ? 12 : 32}>
        {sections.map(
          ({
            action,
            actionAlwaysVisible,
            badge,
            count,
            key,
            label,
            node,
            selfShelled,
            subtitle,
          }) => {
            if (selfShelled) return <Fragment key={key}>{node}</Fragment>;

            if (isRail)
              return (
                <RailCard
                  action={action}
                  count={count}
                  key={key}
                  title={
                    label && (
                      <>
                        {label}
                        {badge}
                      </>
                    )
                  }
                >
                  {node}
                </RailCard>
              );

            if (!label) return <Flexbox key={key}>{node}</Flexbox>;

            return (
              <GroupBlock
                action={action}
                actionAlwaysVisible={actionAlwaysVisible}
                count={count}
                key={key}
                title={
                  <>
                    {label}
                    {subtitle && (
                      <span className={cx(homeType.meta, styles.subtitle)}>· {subtitle}</span>
                    )}
                    {badge}
                  </>
                }
              >
                {node}
              </GroupBlock>
            );
          },
        )}

        {!isMain && <Recommendations variant={variant} />}
      </Flexbox>
    );
  },
);

export default HomeInbox;
