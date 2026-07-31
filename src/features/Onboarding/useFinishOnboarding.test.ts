import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFinishOnboarding } from './useFinishOnboarding';

const navigate = vi.fn();
const finishOnboarding = vi.fn().mockResolvedValue(undefined);
const consumeOnboardingCallbackUrl = vi.fn();

const metrics = vi.hoisted(() => ({
  trackOnboardingCompleted: vi.fn(),
  trackOnboardingStepCompleted: vi.fn(),
}));

vi.mock('react-router', () => ({ useNavigate: () => navigate }));

vi.mock('@/services/onboardingMetrics', () => ({
  trackOnboardingCompleted: metrics.trackOnboardingCompleted,
  trackOnboardingStepCompleted: metrics.trackOnboardingStepCompleted,
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (s: { finishOnboarding: () => Promise<void> }) => unknown) =>
    selector({ finishOnboarding }),
}));

vi.mock('@/utils/onboardingRedirect', () => ({
  consumeOnboardingCallbackUrl: () => consumeOnboardingCallbackUrl(),
}));

beforeEach(() => {
  navigate.mockClear();
  finishOnboarding.mockClear();
  consumeOnboardingCallbackUrl.mockReset();
  metrics.trackOnboardingCompleted.mockClear();
  metrics.trackOnboardingStepCompleted.mockClear();
});

describe('useFinishOnboarding', () => {
  it('writes the finished state before navigating away', async () => {
    // Ordering matters: navigating first would race the redirect guard, which
    // reads `finishedAt` and would bounce the user straight back into onboarding.
    const order: string[] = [];
    finishOnboarding.mockImplementationOnce(async () => void order.push('finish'));
    navigate.mockImplementationOnce(() => void order.push('navigate'));

    const { result } = renderHook(() => useFinishOnboarding('classic'));
    await act(() => result.current());

    expect(order).toEqual(['finish', 'navigate']);
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('emits the step event between the store write and the completion event', async () => {
    const order: string[] = [];
    finishOnboarding.mockImplementationOnce(async () => void order.push('finish'));
    metrics.trackOnboardingStepCompleted.mockImplementationOnce(() => void order.push('step'));
    metrics.trackOnboardingCompleted.mockImplementationOnce(() => void order.push('completed'));

    const { result } = renderHook(() => useFinishOnboarding('classic'));
    await act(() => result.current({ flow: 'classic', step: 'interests', stepIndex: 2 }));

    expect(order).toEqual(['finish', 'step', 'completed']);
  });

  it('omits the step event when no payload is given', async () => {
    const { result } = renderHook(() => useFinishOnboarding('agent'));
    await act(() => result.current());

    expect(metrics.trackOnboardingStepCompleted).not.toHaveBeenCalled();
    expect(metrics.trackOnboardingCompleted).toHaveBeenCalledWith({
      flow: 'agent',
      targetUrl: '/',
    });
  });

  it('restores the stashed signup target', async () => {
    consumeOnboardingCallbackUrl.mockReturnValue('/chat?topic=abc');

    const { result } = renderHook(() => useFinishOnboarding('classic'));
    await act(() => result.current());

    expect(navigate).toHaveBeenCalledWith('/chat?topic=abc');
    expect(metrics.trackOnboardingCompleted).toHaveBeenCalledWith({
      flow: 'classic',
      targetUrl: '/chat?topic=abc',
    });
  });
});
