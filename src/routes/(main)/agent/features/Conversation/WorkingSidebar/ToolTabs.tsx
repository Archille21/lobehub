import { ActionIcon, Icon } from '@lobehub/ui';
import { DropdownMenu } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { Check, type LucideIcon, Plus, X } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { DESKTOP_HEADER_ICON_SMALL_SIZE } from '@/const/layoutTokens';
import { useLocalStorageState } from '@/hooks/useLocalStorageState';

const OPEN_TABS_STORAGE_KEY = 'lobechat-working-sidebar-open-tabs';

export interface WorkingSidebarToolTab {
  icon: LucideIcon;
  key: string;
  label: ReactNode;
}

interface ToolTabsProps {
  activeKey: string;
  availableTabs: WorkingSidebarToolTab[];
  onChange: (key: string) => void;
}

const styles = createStaticStyles(({ css, cssVar }) => ({
  addButton: css`
    flex-shrink: 0;
    color: ${cssVar.colorTextSecondary};
  `,
  closeButton: css`
    pointer-events: none;

    width: 18px;
    height: 18px;
    margin-inline-end: -4px;

    opacity: 0;

    transition: opacity 0.15s ${cssVar.motionEaseInOut};
  `,
  tab: css`
    cursor: default;
    user-select: none;

    display: inline-flex;
    flex-shrink: 0;
    gap: 6px;
    align-items: center;

    max-width: 160px;
    height: 32px;
    padding-inline: 10px;
    border: 0;
    border-radius: ${cssVar.borderRadius};

    font: inherit;
    font-size: ${cssVar.fontSize}px;
    color: ${cssVar.colorTextSecondary};

    background: transparent;

    transition:
      color 0.15s ${cssVar.motionEaseInOut},
      background-color 0.15s ${cssVar.motionEaseInOut};

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }

    &:hover .${'lobehub-working-sidebar-tab-close'} {
      pointer-events: auto;
      opacity: 1;
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }
  `,
  tabActive: css`
    font-weight: 500;
    color: ${cssVar.colorText};
    background: ${cssVar.colorBgElevated};
    box-shadow: inset 0 0 0 1px ${cssVar.colorBorderSecondary};

    &:hover {
      background: ${cssVar.colorBgElevated};
    }
  `,
  tabIcon: css`
    flex-shrink: 0;
  `,
  tabLabel: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  tabs: css`
    scrollbar-width: none;

    overflow-x: auto;
    display: flex;
    flex: 1;
    gap: 4px;
    align-items: center;

    min-width: 0;

    &::-webkit-scrollbar {
      display: none;
    }
  `,
}));

const ToolTabs = memo<ToolTabsProps>(({ activeKey, availableTabs, onChange }) => {
  const { t } = useTranslation('chat');
  const availableKeys = useMemo(
    () => new Set(availableTabs.map((tab) => tab.key)),
    [availableTabs],
  );
  const [storedOpenKeys, setOpenKeys] = useLocalStorageState<string[]>(OPEN_TABS_STORAGE_KEY, [
    activeKey,
  ]);

  const openKeys = useMemo(() => {
    const keys = storedOpenKeys.filter((key) => availableKeys.has(key));
    if (availableKeys.has(activeKey) && !keys.includes(activeKey)) keys.push(activeKey);
    return keys.length > 0 ? keys : availableTabs.slice(0, 1).map((tab) => tab.key);
  }, [activeKey, availableKeys, availableTabs, storedOpenKeys]);

  useEffect(() => {
    if (
      openKeys.length !== storedOpenKeys.length ||
      openKeys.some((key, index) => key !== storedOpenKeys[index])
    ) {
      setOpenKeys(openKeys);
    }
  }, [openKeys, setOpenKeys, storedOpenKeys]);

  const openTabs = openKeys
    .map((key) => availableTabs.find((tab) => tab.key === key))
    .filter((tab): tab is WorkingSidebarToolTab => !!tab);

  const handleSelect = useCallback(
    (key: string) => {
      setOpenKeys((keys) => (keys.includes(key) ? keys : [...keys, key]));
      onChange(key);
    },
    [onChange, setOpenKeys],
  );

  const handleClose = useCallback(
    (key: string) => {
      if (openKeys.length <= 1) return;

      const index = openKeys.indexOf(key);
      const nextKeys = openKeys.filter((item) => item !== key);
      setOpenKeys(nextKeys);

      if (key === activeKey) {
        onChange(nextKeys[Math.min(index, nextKeys.length - 1)]);
      }
    },
    [activeKey, onChange, openKeys, setOpenKeys],
  );

  const menuItems = availableTabs.map((tab) => ({
    icon: openKeys.includes(tab.key) ? Check : tab.icon,
    key: tab.key,
    label: tab.label,
    onClick: () => handleSelect(tab.key),
  }));

  return (
    <>
      <div aria-label={t('workingPanel.tabs.label')} className={styles.tabs} role="tablist">
        {openTabs.map((tab) => {
          const active = tab.key === activeKey;

          return (
            <div
              aria-selected={active}
              className={`${styles.tab} ${active ? styles.tabActive : ''}`}
              data-active={active ? 'true' : undefined}
              key={tab.key}
              role="tab"
              tabIndex={0}
              onClick={() => onChange(tab.key)}
              onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                if (event.target !== event.currentTarget) return;
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onChange(tab.key);
              }}
            >
              <Icon className={styles.tabIcon} icon={tab.icon} size={16} />
              <span className={styles.tabLabel}>{tab.label}</span>
              {openTabs.length > 1 && (
                <ActionIcon
                  className={`${styles.closeButton} lobehub-working-sidebar-tab-close`}
                  icon={X}
                  size="small"
                  title={t('workingPanel.tabs.close')}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleClose(tab.key);
                  }}
                />
              )}
            </div>
          );
        })}
        <DropdownMenu
          iconSpaceMode="group"
          items={menuItems}
          placement="bottomRight"
          popupProps={{ style: { minWidth: 200 } }}
        >
          <ActionIcon
            className={styles.addButton}
            icon={Plus}
            size={DESKTOP_HEADER_ICON_SMALL_SIZE}
            title={t('workingPanel.tabs.add')}
          />
        </DropdownMenu>
      </div>
    </>
  );
});

ToolTabs.displayName = 'WorkingSidebarToolTabs';

export default ToolTabs;
