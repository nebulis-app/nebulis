// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../src/i18n';
import { ThemeProvider } from '../../src/hooks/useTheme';
import {
  IntegrationSuggestionPanel,
  type SuggestionTarget,
} from '../../src/components/objectDetail/IntegrationSuggestionPanel';
import type { TelescopeProfile } from '../../src/lib/api/telescopes';
import enLibrary from '../../src/locales/en/library.json';

/**
 * Render-level checks for the bucket names in the suggest panel. The panel is
 * where a narrowband plan used to read "No filter" under a line that said
 * "narrowband filters", so these pin what it calls each kind of bucket.
 */
const COPY = enLibrary.objectDetail.integrationSection;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

function seeStar(usedFilters: string[] = []): TelescopeProfile {
  return {
    id: 'tel-1',
    name: 'SeeStar',
    kind: 'seestar-s50',
    archivedAt: null,
    usedFilters,
  } as TelescopeProfile;
}

function render(target: SuggestionTarget, telescopes: TelescopeProfile[] = []): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['telescopes'], telescopes);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ThemeProvider>
          <IntegrationSuggestionPanel
            target={target}
            defaultRig="color"
            onApply={() => {}}
            onClose={() => {}}
          />
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const NEBULA: SuggestionTarget = {
  objectType: 'Emission Nebula',
  magnitude: 12,
  majorAxisArcmin: 11,
  bortleClass: 8,
};

const GALAXY: SuggestionTarget = {
  objectType: 'Spiral Galaxy',
  magnitude: 9,
  majorAxisArcmin: 10,
  bortleClass: 8,
};

describe('IntegrationSuggestionPanel bucket names', () => {
  it('calls a narrowband plan with no named filter Dual-band, never No filter', () => {
    const html = render(NEBULA);
    expect(html).toContain(COPY.suggest.dualBand);
    expect(html).not.toContain(COPY.noFilter);
    expect(html).toContain(COPY.suggest.unnamedDualBand);
    expect(html).toContain(COPY.suggest.bands.narrowband);
  });

  it('uses the name the telescope has shot through, so the goal lands on that row', () => {
    const html = render(NEBULA, [seeStar(['IRCUT', 'LP'])]);
    expect(html).toContain('LP');
    expect(html).not.toContain(COPY.noFilter);
    expect(html).not.toContain(COPY.suggest.unnamedDualBand);
  });

  it('puts a single bucket on the total line instead of repeating it below', () => {
    const html = render(NEBULA);
    expect(html).toContain('8 h · Dual-band');
    expect(html).not.toContain('h in total');
  });

  it('still says No filter for a broadband plan, which really has none', () => {
    const html = render(GALAXY, [seeStar(['IRCUT'])]);
    expect(html).toContain(COPY.noFilter);
    expect(html).not.toContain(COPY.suggest.dualBand);
  });
});

describe('IntegrationSuggestionPanel choices and sums', () => {
  it('shows what each Moon plan and tier would cost on its chip', () => {
    // Bubble from Bortle 8: standard 8 h, deep 15.5 h, showpiece 31 h with most nights.
    const html = render({ objectType: 'Emission Nebula', magnitude: 11, majorAxisArcmin: 15, bortleClass: 8 });
    expect(html).toContain('15.5 h');
    expect(html).toContain('31 h');
    expect(html).toContain('7.5 h'); // dark nights
  });

  it('writes the sum behind the total and why the class was chosen', () => {
    const html = render({ objectType: 'Emission Nebula', magnitude: 11, majorAxisArcmin: 15, bortleClass: 8 });
    expect(html).toContain('× 1.94');
    expect(html).toContain('Bortle 8 sky and Moon, narrowband');
    expect(html).toContain('from the object type');
  });

  it('marks a total held at the ceiling, on the line and on the chip', () => {
    const html = render({ objectType: 'Spiral Galaxy', magnitude: 3.44, majorAxisArcmin: 177.83, bortleClass: 8 });
    expect(html).toContain('40+ h');
    expect(html).not.toContain(COPY.suggest.cappedBadge); // standard is 24 h, under the cap
  });

  it('offers Hide in the header and no second Close button', () => {
    const html = render(GALAXY);
    expect(html).toContain(COPY.suggest.hide);
    expect(html).not.toContain('>Close<');
  });
});
