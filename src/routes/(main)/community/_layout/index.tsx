import { Flexbox } from '@lobehub/ui';
import { type FC } from 'react';
import { Navigate, Outlet } from 'react-router';

import { featureFlagsSelectors, useServerConfigStore } from '@/store/serverConfig';

import Sidebar from './Sidebar';
import { styles } from './style';

const Layout: FC = () => {
  const { showMarket } = useServerConfigStore(featureFlagsSelectors);

  // `market: false` already hides Community from both the desktop and mobile
  // nav, but the routes stayed mounted — so a section a deployment deliberately
  // turned off was still one typed URL (or one stale link) away. Every community
  // route nests under this layout, so refusing here closes all of them at once.
  if (!showMarket) return <Navigate replace to={'/'} />;

  return (
    <>
      <Sidebar />
      <Flexbox className={styles.mainContainer} flex={1} height={'100%'}>
        <Outlet />
      </Flexbox>
    </>
  );
};

export default Layout;
