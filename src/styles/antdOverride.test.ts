import { describe, expect, it } from 'vitest';

import antdOverride from './antdOverride';

describe('antdOverride', () => {
  it('fits preview images within the viewport instead of forcing fill width', () => {
    const style = antdOverride({
      prefixCls: 'ant',
      token: {
        colorBgLayout: '#fff',
        colorText: '#000',
        prefixCls: 'ant',
      } as any,
    });

    expect(style.styles).toContain('.ant-image-preview-img');
    expect(style.styles).toContain('width: auto !important');
    expect(style.styles).toContain('min-width: 0 !important');
    expect(style.styles).toContain('object-fit: contain');
  });
});
