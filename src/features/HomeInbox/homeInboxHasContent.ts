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

interface ResolveHomeInboxHasResolvedParams {
  isRecommendationsSettled: boolean;
  isTopicsInit: boolean;
  status: 'error' | 'loading' | 'ready';
}

// `hasContent` can still be transient after `status` leaves `'loading'`: the
// `sectionsCount === 0` fallback reads `recommendationsVisible`, which is
// `true` while the recommendation flow is only showing its own skeleton
// (not yet a final `'hidden'` or `'cards'` answer), and `sectionsCount`
// itself depends on topics that can still be mid-fetch independently of the
// briefs-driven `status`. `hasResolved` is the point past which none of
// `hasContent`'s inputs can still be a loading placeholder — the signal a
// caller needs to tell "this collapse is the real one" from "the loading
// state is still settling."
export const resolveHomeInboxHasResolved = ({
  isRecommendationsSettled,
  isTopicsInit,
  status,
}: ResolveHomeInboxHasResolvedParams): boolean =>
  status !== 'loading' && isTopicsInit && isRecommendationsSettled;
