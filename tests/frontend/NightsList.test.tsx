// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../src/i18n';
import { ThemeProvider } from '../../src/hooks/useTheme';
import { NightsList } from '../../src/components/objectMedia/NightsList';
import type { MediaGroup } from '../../src/lib/api/library';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

function group(over: Partial<MediaGroup>): MediaGroup {
  return {
    key: '2026-10-03|30.0s', label: '2026-10-03|30.0s', date: '2026-10-03', telescope: null, count: 3, subCount: 3, frames: 3,
    exposure: '30.0s', integrationSec: 90, pinned: false, ...over,
  };
}

function render(observations: MediaGroup[], objectId = 'M31'): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ThemeProvider>
          <NightsList objectId={objectId} observations={observations} items={[]} />
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NightsList', () => {
  it('shows one row per night, with the totals of every exposure setting', () => {
    const html = render([
      group({}),
      group({ key: '2026-10-03|15.0s', exposure: '15.0s', count: 2, subCount: 2, frames: 2, integrationSec: 30 }),
      group({ key: '2026-10-04|30.0s', date: '2026-10-04', count: 1, subCount: 1, frames: 1, integrationSec: 30 }),
    ]);
    expect(html.match(/Open night/g)).toHaveLength(2);
    expect(html).toContain('5 frames');
    expect(html).toContain('2m');
  });

  it('offers the exposure settings only for a night shot at more than one', () => {
    const html = render([
      group({}),
      group({ key: '2026-10-03|15.0s', exposure: '15.0s', count: 2, subCount: 2, frames: 2, integrationSec: 30 }),
      group({ key: '2026-10-04|30.0s', date: '2026-10-04' }),
    ]);
    expect(html.match(/Show 2 exposure settings/g)).toHaveLength(1);
    expect(html).toContain('aria-expanded="false"');
    // Collapsed: the per-setting rows are not in the page yet.
    expect(html).not.toContain('15.0s');
  });

  it('does not count a picture with no exposure as a setting', () => {
    const html = render([
      group({}),
      group({ key: '2026-10-03|', exposure: null, count: 1, subCount: 0, frames: 0, integrationSec: null }),
    ]);
    expect(html).not.toContain('exposure settings');
    expect(html).toContain('1</span>');
  });

  it('names each setting once opened, even when it is made of pictures only', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const pictureOnly = (exposure: string) => group({
      key: `2026-10-18|${exposure}`, date: '2026-10-18', exposure: null, count: 1, subCount: 0, frames: 0, integrationSec: null,
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ThemeProvider>
              <NightsList objectId="M31" observations={[pictureOnly('10.0s'), pictureOnly('20.0s')]} items={[]} />
            </ThemeProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    expect(host.textContent).not.toContain('10.0s');
    const button = host.querySelector('button');
    expect(button?.textContent).toContain('Show 2 exposure settings');
    await act(async () => { button?.click(); });
    expect(host.textContent).toContain('10.0s');
    expect(host.textContent).toContain('20.0s');
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
