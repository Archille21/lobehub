import { type HomeStore } from '@/store/home/store';

const homeInboxScope = (s: HomeStore) => s.homeInboxScope;

export const homeInboxScopeSelectors = {
  homeInboxScope,
};
