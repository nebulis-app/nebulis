// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRefreshLibraryOnImport } from '../../src/hooks/useRefreshLibraryOnImport';
import type { ImportStatus } from '../../src/lib/api/library';

const status = (over: Partial<ImportStatus>): ImportStatus => ({ running: false, lastRun: null, ...over } as ImportStatus);

// The repo has no testing library, so mount the hook through a tiny component.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setup() {
  const client = new QueryClient();
  const spy = vi.spyOn(client, 'invalidateQueries');
  const container = document.createElement('div');
  const root = createRoot(container);
  function Probe({ s }: { s: ImportStatus | undefined }) {
    useRefreshLibraryOnImport(s);
    return null;
  }
  const hook = {
    rerender: ({ s }: { s: ImportStatus | undefined }) => {
      act(() => { root.render(<QueryClientProvider client={client}><Probe s={s} /></QueryClientProvider>); });
    },
  };
  const keys = () => spy.mock.calls.map(c => (c[0] as { queryKey: string[] }).queryKey[0]);
  return { hook, spy, keys };
}

describe('useRefreshLibraryOnImport', () => {
  it('does nothing on the first status it sees', () => {
    const { hook, spy } = setup();
    hook.rerender({ s: status({ running: false }) });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refreshes the library and gallery queries when a running import ends', () => {
    const { hook, keys } = setup();
    hook.rerender({ s: status({ running: false }) });
    hook.rerender({ s: status({ running: true }) });
    expect(keys()).toEqual([]);
    hook.rerender({ s: status({ running: false, lastRun: '2026-10-30T10:00:00Z' }) });
    expect(keys()).toContain('library-objects');
    expect(keys()).toContain('all-library-images');
  });

  it('notices a short import that began and ended between two polls', () => {
    const { hook, keys } = setup();
    hook.rerender({ s: status({ running: false, lastRun: null }) });
    hook.rerender({ s: status({ running: false, lastRun: '2026-10-30T10:00:00Z' }) });
    expect(keys()).toContain('library-objects');
  });

  it('does not refresh again for an unchanged idle status', () => {
    const { hook, spy } = setup();
    hook.rerender({ s: status({ lastRun: 'a' }) });
    hook.rerender({ s: status({ lastRun: 'a' }) });
    expect(spy).not.toHaveBeenCalled();
  });
});
