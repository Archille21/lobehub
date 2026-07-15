import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileText, FolderOpen, Globe } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ToolTabs, { type WorkingSidebarToolTab } from './ToolTabs';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  ActionIcon: ({ onClick, title }: { onClick?: (event: MouseEvent) => void; title?: string }) => (
    <button title={title} type="button" onClick={onClick} />
  ),
  Icon: () => <span />,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  DropdownMenu: ({ children, items }: { children: ReactNode; items: any[] }) => (
    <div>
      {children}
      {items.map((item) => (
        <button key={item.key} type="button" onClick={item.onClick}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => () => ({}),
}));

const tabs: WorkingSidebarToolTab[] = [
  { icon: FileText, key: 'resources', label: 'Space' },
  { icon: FolderOpen, key: 'files', label: 'Files' },
  { icon: Globe, key: 'browser', label: 'Browser' },
];

beforeEach(() => {
  window.localStorage.clear();
});

describe('WorkingSidebar ToolTabs', () => {
  it('starts with the active panel and adds panels from the plus menu', () => {
    const onChange = vi.fn();
    render(<ToolTabs activeKey="resources" availableTabs={tabs} onChange={onChange} />);

    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Space' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Space' })).toHaveAttribute('data-active', 'true');
    expect(screen.getByTitle('workingPanel.tabs.add').parentElement?.parentElement).toHaveAttribute(
      'role',
      'tablist',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Files' }));

    expect(onChange).toHaveBeenCalledWith('files');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('automatically opens a panel selected by an external action', async () => {
    const { rerender } = render(
      <ToolTabs activeKey="resources" availableTabs={tabs} onChange={vi.fn()} />,
    );

    rerender(<ToolTabs activeKey="browser" availableTabs={tabs} onChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Browser' })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true');
  });

  it('moves to the neighboring panel when the active panel closes', () => {
    const onChange = vi.fn();
    window.localStorage.setItem(
      'lobechat-working-sidebar-open-tabs',
      JSON.stringify(['resources', 'files']),
    );

    render(<ToolTabs activeKey="files" availableTabs={tabs} onChange={onChange} />);

    fireEvent.click(screen.getAllByTitle('workingPanel.tabs.close')[1]);

    expect(onChange).toHaveBeenCalledWith('resources');
  });
});
