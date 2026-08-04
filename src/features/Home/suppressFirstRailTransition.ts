interface ResolveSuppressRailTransitionParams {
  hasResolved: boolean;
  hasSettledBefore: boolean;
}

export const resolveSuppressRailTransition = ({
  hasResolved,
  hasSettledBefore,
}: ResolveSuppressRailTransitionParams): boolean => !hasSettledBefore && hasResolved;

interface ResolveRailHasSettledParams {
  hasResolved: boolean;
  showHomeRailChanged: boolean;
}

// If any of the three async sources hangs, `hasResolved` never fires and the
// suppression window would stay open indefinitely — a manual toggle in that
// state would get a silent, unanimated jump instead of the 220ms transition
// the user is deliberately triggering. A manual toggle is definitionally not
// "the first settle" regardless of whether the data ever resolves, so it
// closes the window on its own.
export const resolveRailHasSettled = ({
  hasResolved,
  showHomeRailChanged,
}: ResolveRailHasSettledParams): boolean => hasResolved || showHomeRailChanged;
