interface ResolveSuppressRailTransitionParams {
  hasResolved: boolean;
  hasSettledBefore: boolean;
}

export const resolveSuppressRailTransition = ({
  hasResolved,
  hasSettledBefore,
}: ResolveSuppressRailTransitionParams): boolean => !hasSettledBefore && hasResolved;
