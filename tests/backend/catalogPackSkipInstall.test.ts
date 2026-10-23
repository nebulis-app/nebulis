import { describe, it, expect, afterEach, vi } from 'vitest';
import { installCatalogPacks } from '../../server/lib/catalogPack/install';

// A developer who loads a locally built pack sets NEBULIS_SKIP_PACK_INSTALL=1 so the
// update check cannot put the published packs back over it.
describe('NEBULIS_SKIP_PACK_INSTALL', () => {
  afterEach(() => { delete process.env.NEBULIS_SKIP_PACK_INSTALL; vi.restoreAllMocks(); });

  it('installs nothing and never touches the network when set', async () => {
    process.env.NEBULIS_SKIP_PACK_INSTALL = '1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const results = await installCatalogPacks(['messier', 'sharpless'], new AbortController().signal, async () => {});
    expect(results.map(r => [r.tier, r.skipped, r.reason])).toEqual([
      ['messier', true, 'disabled_by_env'],
      ['sharpless', true, 'disabled_by_env'],
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
