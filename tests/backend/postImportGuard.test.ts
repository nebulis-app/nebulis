/**
 * Every import path must end in the shared post-import pipeline (postImport.ts).
 * These checks fail when someone adds a new follow-up job as a one-off hook in an
 * import path, or adds a new import path that forgets the pipeline.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SERVER = path.resolve(__dirname, '../../server');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'dist' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
const files = walk(SERVER).map(f => ({ rel: path.relative(SERVER, f), text: fs.readFileSync(f, 'utf8') }));
const read = (rel: string) => files.find(f => f.rel === rel)?.text ?? '';
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('post-import pipeline guard', () => {
  // Stage functions may be called only by the pipeline itself (and defined in their own module).
  const stages: Array<{ call: string; allowed: string[] }> = [
    { call: 'warmObjectThumbnails(', allowed: ['lib/library/postImport.ts', 'lib/library/galleryThumbnailWarm.ts'] },
    { call: 'prewarmSessionThumbnails(', allowed: ['lib/library/postImport.ts', 'lib/library/sessionThumbnailPrewarm.ts'] },
    { call: 'warmSubFrameHeaders(', allowed: ['lib/library/postImport.ts', 'lib/library/integration.ts'] },
    { call: 'enqueueSessionWeatherBackfill(', allowed: ['lib/library/postImport.ts', 'lib/library/observations.ts'] },
  ];
  for (const { call, allowed } of stages) {
    it(`${call} is only called from the pipeline`, () => {
      const offenders = files.filter(f => !allowed.includes(f.rel) && f.text.includes(call)).map(f => f.rel);
      expect(offenders).toEqual([]);
    });
  }

  it('import paths do not call enrichObjectData themselves', () => {
    for (const rel of ['lib/library/import.ts', 'lib/library/librarySources.ts']) {
      expect(read(rel).includes('enrichObjectData(')).toBe(false);
    }
  });

  // Each entry point that adds files must hand off to the pipeline.
  it('import.ts runs it for telescope, folder, sub-frame (x2) and manual paths', () => {
    expect(count(read('lib/library/import.ts'), 'runPostImport({')).toBeGreaterThanOrEqual(5);
    for (const reason of ['telescope-import', 'folder-import', 'subframe-sync', 'manual-observation']) {
      expect(read('lib/library/import.ts')).toContain(`reason: '${reason}'`);
    }
  });

  it('archive restore and adopting a library run it', () => {
    expect(read('routes/storage.ts')).toContain("reason: 'archive-restore'");
    expect(read('lib/library/adoptReconcile.ts')).toContain("reason: 'adopt-library'");
  });

  it('linked folders run it on commit and on rescan', () => {
    const text = read('lib/library/librarySources.ts');
    expect(text).toContain("reason: 'linked-folder'");
    expect(text).toContain("reason: 'linked-rescan'");
  });

  it('boot and nightly sweeps run it', () => {
    expect(read('index.ts')).toContain("reason: 'boot'");
    expect(read('lib/plannerNightlyPrefetch.ts')).toContain("reason: 'nightly'");
  });
});
