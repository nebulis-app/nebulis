import { describe, it, expect } from 'vitest';
import { getCuratedDescription } from '../../server/lib/curatedDescriptions';

// Regression guard for a bug where curated-descriptions.json was loaded via a
// runtime readFileSync. The native Windows/macOS builds bundle the server as a
// single tsup/esbuild file with no data/ folder on disk, so the read threw
// ENOENT and every catalog object silently showed "No description available".
// The fix is to load the JSON via a static `import` so esbuild inlines it into
// the bundle (like openngc.json / sharpless.json / catalog-curated.json).
//
// If someone reintroduces a runtime file read for a shipped server/data/*.json
// asset, these tests fail in the bundled build. They also fail here if the data
// file goes missing or its keys stop matching catalog object IDs.
describe('curatedDescriptions', () => {
  it('resolves a well-known Messier object to a real description', () => {
    const entry = getCuratedDescription('M16');
    expect(entry).not.toBeNull();
    expect(entry!.extract.trim().length).toBeGreaterThan(0);
    expect(entry!.wikiUrl).toMatch(/^https?:\/\//);
  });

  it('keys match bare catalog object IDs (no whitespace/prefix drift)', () => {
    // The /info route looks up by raw object id (e.g. "M1", "M16"), so the JSON
    // keys must be the same bare ids the catalog uses.
    for (const id of ['M1', 'M31', 'M42']) {
      expect(getCuratedDescription(id), `expected curated entry for ${id}`).not.toBeNull();
    }
  });

  it('returns null for an unknown id rather than throwing', () => {
    expect(getCuratedDescription('NOT_A_REAL_OBJECT')).toBeNull();
  });
});
