interface ResolveHomeRailVisibleParams {
  isLogin: boolean | undefined;
  railHasContent: boolean;
  showHomeRail: boolean;
}

export const resolveHomeRailVisible = ({
  isLogin,
  railHasContent,
  showHomeRail,
}: ResolveHomeRailVisibleParams): boolean => Boolean(isLogin && showHomeRail && railHasContent);

interface ResolveRailToggleVisibleParams {
  isLogin: boolean | undefined;
  isStatusInit: boolean;
  railHasContent: boolean;
}

export const resolveRailToggleVisible = ({
  isLogin,
  isStatusInit,
  railHasContent,
}: ResolveRailToggleVisibleParams): boolean => Boolean(isLogin && isStatusInit && railHasContent);
