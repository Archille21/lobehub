import { DESKTOP_APP_ENABLED } from '@lobechat/business-const';
import { Navigate } from 'react-router';

import DownloadsPage from '@/features/Downloads';

/**
 * The page lists the desktop/mobile builds to download. A distribution that
 * ships none has nothing to put here, and hiding the menu entries that point at
 * it still leaves the URL reachable — the same half-measure as hiding a nav
 * item while leaving its routes mounted.
 */
const Downloads = () => (DESKTOP_APP_ENABLED ? <DownloadsPage /> : <Navigate replace to={'/'} />);

export default Downloads;
