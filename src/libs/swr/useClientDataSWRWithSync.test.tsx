/**
 * @vitest-environment happy-dom
 */
import { render } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import type { SWRResponse } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useClientDataSWR } from './index';
import { useClientDataSWRWithSync } from './useClientDataSWRWithSync';

vi.mock('./index', () => ({
  useClientDataSWR: vi.fn(),
}));

const swrResponse = <T,>(data: T): SWRResponse<T> =>
  ({
    data,
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  }) as unknown as SWRResponse<T>;

interface ProbeProps {
  cacheKey: string | readonly unknown[];
  onData: (data: unknown) => void;
  onLayoutRead?: () => void;
}

const Probe = ({ cacheKey, onData, onLayoutRead }: ProbeProps) => {
  useClientDataSWRWithSync(cacheKey, null, { onData });

  useLayoutEffect(() => {
    onLayoutRead?.();
  });

  return null;
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('useClientDataSWRWithSync', () => {
  it('syncs cached data before consumer layout effects run', () => {
    const cached = { items: ['cached'] };
    let mirrored: unknown;
    let observedDuringLayout: unknown;

    vi.mocked(useClientDataSWR).mockReturnValue(swrResponse(cached));

    render(
      <Probe
        cacheKey={['agent:list', true]}
        onData={(data) => {
          mirrored = data;
        }}
        onLayoutRead={() => {
          observedDuringLayout = mirrored;
        }}
      />,
    );

    expect(observedDuringLayout).toBe(cached);
  });

  it('syncs the same cached data again when the SWR key changes', () => {
    const cached = { items: ['same-reference'] };
    const onData = vi.fn();

    vi.mocked(useClientDataSWR).mockReturnValue(swrResponse(cached));

    const { rerender } = render(<Probe cacheKey={['agent:list', true]} onData={onData} />);

    expect(onData).toHaveBeenCalledTimes(1);

    rerender(<Probe cacheKey={['agent:list', true, 'workspace-a']} onData={onData} />);

    expect(onData).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenLastCalledWith(cached);
  });

  it('syncs null as settled cached data', () => {
    const onData = vi.fn();

    vi.mocked(useClientDataSWR).mockReturnValue(swrResponse(null));

    render(<Probe cacheKey="nullable:key" onData={onData} />);

    expect(onData).toHaveBeenCalledWith(null);
  });
});
