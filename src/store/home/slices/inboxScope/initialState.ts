export type HomeInboxScope = 'mine' | 'team';

export interface InboxScopeState {
  homeInboxScope: HomeInboxScope;
}

export const initialInboxScopeState: InboxScopeState = {
  homeInboxScope: 'mine',
};
