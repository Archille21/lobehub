'use client';

import { ActionIcon } from '@lobehub/ui';
import { DropdownMenu } from '@lobehub/ui/base-ui';
import { MoreHorizontal } from 'lucide-react';
import { memo } from 'react';

import HeaderSlot from '@/routes/(main)/agent/(chat)/_layout/HeaderSlot';

import { useMenu } from './useMenu';

const HeaderActions = memo(() => {
  const { menuFooter, menuItems } = useMenu();

  return (
    <>
      <HeaderSlot.Outlet />
      <DropdownMenu footer={menuFooter} items={menuItems}>
        <ActionIcon icon={MoreHorizontal} size={'small'} />
      </DropdownMenu>
    </>
  );
});

HeaderActions.displayName = 'HeaderActions';

export default HeaderActions;
