interface ResolveHomeInboxHasContentParams {
  isMain: boolean;
  recommendationsVisible: boolean;
  sectionsCount: number;
  status: 'error' | 'loading' | 'ready';
}

export const resolveHomeInboxHasContent = ({
  isMain,
  recommendationsVisible,
  sectionsCount,
  status,
}: ResolveHomeInboxHasContentParams): boolean => {
  if (status === 'loading' || status === 'error') return true;
  if (sectionsCount > 0) return true;
  if (isMain) return false;
  return recommendationsVisible;
};
