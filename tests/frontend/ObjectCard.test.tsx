// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../src/i18n';
import { ObjectCard } from '../../src/components/ObjectCard';
import { ThemeProvider } from '../../src/hooks/useTheme';
import type { AstroObject } from '../../src/types';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const BASE = {
  id: 'M31', catalogId: 'M31', folderName: 'M31', name: 'Andromeda Galaxy', type: 'Spiral Galaxy',
  constellation: 'And', description: '', hasSubFrames: false, thumbnailUrl: '', sessionsUrl: '',
  filesUrl: '', subFramesUrl: null,
} as unknown as AstroObject;

function render(object: AstroObject): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['integration-progress'], []);
  client.setQueryData(['library-objects'], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter>
          <ObjectCard object={object} isDark telescopes={[]} />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe('ObjectCard processed-project frame', () => {
  it('frames an object that has at least one archived project', () => {
    const html = render({ ...BASE, projectArchiveCount: 1 });
    expect(html).toContain('data-has-project="true"');
    expect(html).toContain('border-violet-500/70');
  });

  it('keeps the plain border when the object has no project', () => {
    for (const count of [0, undefined]) {
      const html = render({ ...BASE, projectArchiveCount: count });
      expect(html).not.toContain('data-has-project');
      expect(html).not.toContain('border-violet');
      expect(html).toContain('border-slate-800');
    }
  });
});
