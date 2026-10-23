// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../src/i18n';
import { IntegrationRemainingChips, LibraryIntegrationRemainingChips } from '../../src/components/planner/IntegrationRemainingChips';
import type { ObjectIntegrationProgress } from '../../src/lib/api/library';
import type { AstroObject } from '../../src/types';

/** Rendered with both queries seeded in the cache (no network). */
beforeAll(async () => {
  await i18n.changeLanguage('en');
});

function render(progress: ObjectIntegrationProgress[], objectId: string, libraryObjects: Partial<AstroObject>[] = []): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['integration-progress'], progress);
  client.setQueryData(['library-objects'], libraryObjects);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntegrationRemainingChips objectId={objectId} isDark />
    </QueryClientProvider>,
  );
}

const SH2: ObjectIntegrationProgress = {
  objectId: 'NGC6888',
  complete: false,
  filters: [
    { filter: 'D1', goalSec: 36000, exposureSec: 36000, remainingSec: 0 },
    { filter: 'D2', goalSec: 36000, exposureSec: 21600, remainingSec: 14400 },
    { filter: 'L', goalSec: 7200, exposureSec: 0, remainingSec: 7200 },
  ],
};

describe('IntegrationRemainingChips', () => {
  it('shows remaining time per unfinished filter, largest first', () => {
    const html = render([SH2], 'NGC6888');
    expect(html).toContain('4h left · D2');
    expect(html).toContain('2h left · L');
    expect(html).not.toContain('D1');
    expect(html.indexOf('D2')).toBeLessThan(html.indexOf('· L'));
  });

  it('resolves a catalog id to its library object', () => {
    const html = render([SH2], 'Sh2-105', [{ id: 'NGC6888', catalogId: 'Sh2-105' }]);
    expect(html).toContain('4h left · D2');
  });

  it('shows a single "goals reached" chip when complete, nothing without goals', () => {
    const done = { ...SH2, complete: true, filters: SH2.filters.map(f => ({ ...f, remainingSec: 0 })) };
    expect(render([done], 'NGC6888')).toContain('Goals reached');
    expect(render([SH2], 'M31')).toBe('');
  });
});

describe('LibraryIntegrationRemainingChips', () => {
  it('looks up the library object id directly', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['integration-progress'], [SH2]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <LibraryIntegrationRemainingChips libraryObjectId="NGC6888" isDark={false} />
        <LibraryIntegrationRemainingChips libraryObjectId="Sh2-105" isDark={false} />
      </QueryClientProvider>,
    );
    expect(html.match(/4h left · D2/g)).toHaveLength(1);
  });
});
