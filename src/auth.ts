import { businessAuthPlugins } from '@lobechat/business-auth';

import { defineConfig } from '@/libs/better-auth/define-config';

export const auth = defineConfig({
  plugins: [...businessAuthPlugins],
});
