interface ResolveSuppressRailTransitionParams {
  hasSettledBefore: boolean;
  status: 'error' | 'loading' | 'ready';
}

export const resolveSuppressRailTransition = ({
  hasSettledBefore,
  status,
}: ResolveSuppressRailTransitionParams): boolean => !hasSettledBefore && status !== 'loading';
