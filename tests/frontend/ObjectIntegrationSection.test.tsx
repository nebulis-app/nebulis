// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../src/i18n';
import { ThemeProvider } from '../../src/hooks/useTheme';
import { ObjectIntegrationSection } from '../../src/components/objectDetail/ObjectIntegrationSection';
import type { IntegrationBreakdown } from '../../src/lib/api/library';
import enLibrary from '../../src/locales/en/library.json';

/**
 * Render-level checks with data seeded into the query cache, so no network
 * is touched (renderToStaticMarkup runs no effects; useQuery returns the
 * cached value synchronously).
 */
const COPY = enLibrary.objectDetail.integrationSection;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

function render(data: IntegrationBreakdown | undefined, isAdmin = false): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (data) client.setQueryData(['integration-by-filter', data.objectId], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ObjectIntegrationSection objectId={data?.objectId ?? 'X'} isAdmin={isAdmin} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const CAMPAIGN: IntegrationBreakdown = {
  objectId: 'Sh2-105',
  totalFrames: 60,
  totalExposureSec: 18000,
  unreadableFrames: 2,
  filters: [
    { filter: 'Ha', frames: 36, exposureSec: 10800, goalSec: 36000, nights: [{ date: '2026-09-20', frames: 36, exposureSec: 10800 }] },
    { filter: 'OIII', frames: 24, exposureSec: 7200, goalSec: 7200, nights: [{ date: '2026-09-21', frames: 24, exposureSec: 7200 }] },
    { filter: 'SII', frames: 0, exposureSec: 0, goalSec: 21600, nights: [] },
    { filter: null, frames: 0, exposureSec: 0, goalSec: null, nights: [] },
  ],
};

describe('ObjectIntegrationSection', () => {
  it('opens by default with one row per filter, totals and goals', () => {
    const html = render(CAMPAIGN);
    expect(html).toContain(COPY.heading);
    expect(html).toContain('5h · 2 filters');
    expect(html).toContain('>Ha<');
    expect(html).toContain('>OIII<');
    expect(html).toContain('>SII<');
    expect(html).toContain(COPY.noFilter);
    expect(html).toContain('3h<span');
    expect(html).toContain(' / 10h');
  });

  it('shows remaining time and percentage, and marks reached goals', () => {
    const html = render(CAMPAIGN);
    expect(html).toContain('7h left · 30%');
    expect(html).toContain(COPY.goalReached);
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toContain('aria-valuenow="100"');
  });

  it('warns about unreadable sub-frames', () => {
    expect(render(CAMPAIGN)).toContain('2 sub-frames could not be read');
  });

  it('offers goal editing to admins only', () => {
    expect(render(CAMPAIGN, true)).toContain(`>${COPY.editGoals}<`);
    expect(render(CAMPAIGN, false)).not.toContain(`>${COPY.editGoals}<`);
  });

  it('stays collapsed when there is nothing to show', () => {
    const html = render({ objectId: 'Empty', totalFrames: 0, totalExposureSec: 0, unreadableFrames: 0, filters: [] });
    expect(html).toContain(COPY.noneYet);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(COPY.emptyHint);
  });
});
