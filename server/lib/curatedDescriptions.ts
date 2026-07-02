// Imported (not readFileSync'd) so esbuild/tsup inlines the JSON into the
// server bundle. The native Windows/macOS builds package the server as a
// single bundle with no data/ folder on disk, so a runtime file read would
// throw ENOENT there and silently drop every curated description.
import curatedJson from '../data/curated-descriptions.json';

interface CuratedEntry {
  extract: string;
  wikiUrl: string;
}

const cache = curatedJson as Record<string, CuratedEntry>;

export function getCuratedDescription(objectId: string): CuratedEntry | null {
  return cache[objectId] ?? null;
}
