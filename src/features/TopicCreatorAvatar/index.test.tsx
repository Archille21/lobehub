/**
 * @vitest-environment happy-dom
 */
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import TopicCreatorAvatar, { TopicCreatorCorner } from './index';

const useAuthorInfoMock = vi.hoisted(() => vi.fn());

vi.mock('@/business/client/hooks/useAuthorInfo', () => ({
  useAuthorInfo: useAuthorInfoMock,
}));

vi.mock('@lobehub/ui', () => ({
  Avatar: ({ avatar, shape, title }: { avatar?: string; shape?: string; title?: string }) => (
    <span
      data-avatar={avatar ?? ''}
      data-shape={shape ?? ''}
      data-testid="avatar"
      data-title={title ?? ''}
    />
  ),
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

describe('TopicCreatorAvatar', () => {
  it("renders a workspace member's round avatar (any member, including self)", () => {
    useAuthorInfoMock.mockReturnValue({ avatar: 'https://x/y.png', fullName: 'Alice' });

    const { getByTestId } = render(<TopicCreatorAvatar userId="any-member" />);

    expect(useAuthorInfoMock).toHaveBeenCalledWith('any-member');
    const avatar = getByTestId('avatar');
    expect(avatar.getAttribute('data-avatar')).toBe('https://x/y.png');
    expect(avatar.getAttribute('data-shape')).toBe('circle');
    expect(avatar.getAttribute('data-title')).toBe('Alice');
  });

  it('renders nothing in personal mode / when the creator is not a resolvable member', () => {
    useAuthorInfoMock.mockReturnValue(undefined);

    const { queryByTestId } = render(<TopicCreatorAvatar userId="someone" />);

    expect(queryByTestId('avatar')).toBeNull();
  });

  it('renders nothing when no userId is provided (default / temp topic)', () => {
    useAuthorInfoMock.mockReturnValue(undefined);

    const { queryByTestId } = render(<TopicCreatorAvatar />);

    expect(useAuthorInfoMock).toHaveBeenCalledWith(undefined);
    expect(queryByTestId('avatar')).toBeNull();
  });
});

describe('TopicCreatorCorner', () => {
  it('overlays a mini round avatar on the wrapped identity icon', () => {
    useAuthorInfoMock.mockReturnValue({ avatar: 'https://x/y.png', fullName: 'Alice' });

    const { getByTestId } = render(
      <TopicCreatorCorner userId="any-member">
        <span data-testid="platform-icon" />
      </TopicCreatorCorner>,
    );

    expect(getByTestId('platform-icon')).toBeTruthy();
    const avatar = getByTestId('avatar');
    expect(avatar.getAttribute('data-shape')).toBe('circle');
  });

  it('renders only the wrapped icon when the creator does not resolve', () => {
    useAuthorInfoMock.mockReturnValue(undefined);

    const { getByTestId, queryByTestId } = render(
      <TopicCreatorCorner userId="ghost">
        <span data-testid="platform-icon" />
      </TopicCreatorCorner>,
    );

    expect(getByTestId('platform-icon')).toBeTruthy();
    expect(queryByTestId('avatar')).toBeNull();
  });
});
