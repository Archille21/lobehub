import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import HeaderActions from './index';

vi.mock('@lobehub/ui', () => ({
  ActionIcon: () => <button data-testid={'overflow-menu-button'} />,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  DropdownMenu: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));

vi.mock('./useMenu', () => ({
  useMenu: () => ({
    menuFooter: <div data-testid={'topic-info-footer'} />,
    menuItems: [],
  }),
}));

describe('Conversation header actions', () => {
  it('renders the overflow actions button', () => {
    render(<HeaderActions />);

    expect(screen.getByTestId('overflow-menu-button')).toBeInTheDocument();
  });

  it('passes the topic info footer to the dropdown', () => {
    render(<HeaderActions />);

    expect(screen.getByTestId('topic-info-footer')).toBeInTheDocument();
  });
});
