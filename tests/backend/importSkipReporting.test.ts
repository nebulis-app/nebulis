import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-skipreport-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import {
  countSkip,
  summarizeSkips,
  classifyImportFile,
  type SkipTally,
} from '../../server/lib/library/importFilter';
import {
  dwarfLocalName,
  runImport,
  claimImportLock,
  getImportStatus,
  getImportHistory,
} from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Count for one reason in a summary, or 0 if it isn't reported at all. */
function countFor(skipped: Array<{ reason: string; count: number }>, reason: string): number {
  return skipped.find(s => s.reason === reason)?.count ?? 0;
}

describe('skip tally', () => {
  it('never reports hidden/system files, however many are found', () => {
    // .DS_Store and AppleDouble sidecars are not files the user thinks of as
    // theirs. Reporting them would bury the reasons that matter.
    const tally: SkipTally = new Map();
    countSkip(tally, 'not-a-real-file', 40);
    countSkip(tally, 'jpg-disabled', 2);
    expect(summarizeSkips(tally)).toEqual([
      { reason: 'jpg-disabled', label: expect.any(String), count: 2, bytes: expect.any(Number) },
    ]);
  });

  it('orders reasons largest group first', () => {
    const tally: SkipTally = new Map();
    countSkip(tally, 'jpg-disabled', 3);
    countSkip(tally, 'sub-frames-disabled', 1184);
    countSkip(tally, 'failed-frame', 12);
    expect(summarizeSkips(tally).map(s => s.reason)).toEqual([
      'sub-frames-disabled', 'failed-frame', 'jpg-disabled',
    ]);
  });

  it('accumulates repeated counts for the same reason', () => {
    const tally: SkipTally = new Map();
    countSkip(tally, 'failed-frame');
    countSkip(tally, 'failed-frame');
    countSkip(tally, 'failed-frame', 3);
    expect(countFor(summarizeSkips(tally), 'failed-frame')).toBe(5);
  });

  it('ignores zero and negative counts instead of reporting an empty group', () => {
    // An empty exclusion list must not produce "0 folders that hold no
    // observations" in the UI.
    const tally: SkipTally = new Map();
    countSkip(tally, 'non-observation-folder', 0);
    countSkip(tally, 'jpg-disabled', -1);
    expect(summarizeSkips(tally)).toEqual([]);
  });

  it('gives every reason classifyImportFile can return a label', () => {
    // A missing label renders as "1184 undefined". Cheap to guard.
    const settings = { importJpg: false, importFits: false, importVideos: false, importThumbnails: false };
    const names = ['a.jpg', 'a.fits', 'a.mp4', 'img_ref.fits', 'failed_light.fits', 'Stacked_1_M42_10.0s_LP_20260101-000000_thn.jpg'];
    for (const name of names) {
      const decision = classifyImportFile(name, settings);
      expect(decision.import).toBe(false);
      if (decision.import) continue;
      const tally: SkipTally = new Map();
      countSkip(tally, decision.reason);
      const [summary] = summarizeSkips(tally);
      expect(summary.label, `no label for ${decision.reason}`).toBeTruthy();
    }
  });
});

describe('dwarfLocalName reports why it refuses a file', () => {
  const SESSION = 'DWARF3_RAW_TELE_M31_EXP_15_GAIN_80_2026-07-05-23-27-43-123';

  it('keeps an already-dated Dwarf 3 subframe verbatim', () => {
    const name = 'M31_2026-07-05_23-27-43.fits';
    expect(dwarfLocalName(name, SESSION)).toEqual({ name });
  });

  it('stamps target and session timestamp into an undated stack', () => {
    const result = dwarfLocalName('stacked-16.fits', SESSION);
    expect(result.name).toMatch(/^DWARF3_M31_.+_stacked-16\.fits$/);
  });

  it('reports an undecodable session folder rather than colliding', () => {
    // Two nights of stacked-0001.fits would land on the same path. The old code
    // returned a bare null here, so the file vanished with only a debug log.
    expect(dwarfLocalName('stacked-0001.fits', 'NOT_A_SESSION_FOLDER')).toEqual({
      name: null,
      reason: 'undecodable-session-folder',
    });
  });

  it('names a sidecar rather than refusing it', () => {
    // shotsInfo.json used to be refused here as an unsupported type, which is
    // what the user noticed: it is the Dwarf's own per-observation record
    // (exposure, gain, filter, frame counts) and was discarded wholesale.
    // Sidecars are now importable, so even the legacy flat path can name one.
    const named = dwarfLocalName('shotsInfo.json', SESSION);
    expect(named.name).not.toBeNull();
    expect(named.name).toMatch(/shotsInfo\.json$/);
  });

  it('still reports a genuinely unknown extension as an unsupported type', () => {
    expect(dwarfLocalName('telemetry.dat', SESSION)).toEqual({
      name: null,
      reason: 'unsupported-type',
    });
  });

  it('reports an img_ file as a processing artifact', () => {
    expect(dwarfLocalName('img_reference.fits', SESSION)).toEqual({
      name: null,
      reason: 'processing-artifact',
    });
  });
});

describe('runImport reports what it left on the telescope', () => {
  beforeAll(() => {
    // Enrichment + weather backfill run after the import loop. Keep them
    // offline and instant instead of waiting out real network timeouts.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('tallies each reason, and records the summary in import history', async () => {
    // kind 'other' -> walker basePath '', so object folders sit directly under
    // localPath. connectionType 'local' exercises the USB transport, which
    // shares the whole filter/report path with SMB and FTP.
    const deviceRoot = tmpDir('skipreport-device-');
    const objDir = path.join(deviceRoot, 'M42');
    fs.mkdirSync(objDir);

    // Imported: a normal stacked JPG.
    fs.writeFileSync(path.join(objDir, 'Stacked_10_M42_30.0s_IRCUT_20260622-200000.jpg'), 'jpg');
    // Skipped: telescope rejected this frame while stacking.
    fs.writeFileSync(path.join(objDir, 'failed_Light_M42_30.0s_IRCUT_20260622-200100.fit'), 'fit');
    fs.writeFileSync(path.join(objDir, 'failed_Light_M42_30.0s_IRCUT_20260622-200200.fit'), 'fit');
    // Skipped: internal Dwarf processing artifact.
    fs.writeFileSync(path.join(objDir, 'img_reference.fits'), 'fits');
    // Skipped: thumbnails default to off.
    fs.writeFileSync(path.join(objDir, 'Stacked_10_M42_30.0s_IRCUT_20260622-200000_thn.jpg'), 'thn');
    // Never reported, however many there are.
    fs.writeFileSync(path.join(objDir, '.DS_Store'), 'junk');

    const profile = createProfile({
      name: 'Skip Report SeeStar',
      kind: 'other',
      connectionType: 'local',
      localPath: deviceRoot,
    });

    expect(claimImportLock()).toBe(true);
    await runImport(undefined, undefined, { telescopeId: profile.id });

    const { skipped } = getImportStatus();
    expect(countFor(skipped, 'failed-frame')).toBe(2);
    expect(countFor(skipped, 'processing-artifact')).toBe(1);
    expect(countFor(skipped, 'thumbnails-disabled')).toBe(1);
    expect(countFor(skipped, 'not-a-real-file')).toBe(0);
    // Largest group first, so the UI list needs no sorting of its own.
    expect(skipped[0].reason).toBe('failed-frame');
    // Every entry carries display wording, not just a code.
    for (const entry of skipped) expect(entry.label).toBeTruthy();

    // The run must still import the one good file. A skip report that came at
    // the cost of dropping real files would be worse than no report.
    // Recursive: a new object is created with the nested (per-session) layout,
    // so the file sits inside its session directory rather than at object level.
    const objRoot = path.join(process.env.DATA_DIR!, 'library', 'M42');
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [e.name]);
    expect(walk(objRoot)).toContain('Stacked_10_M42_30.0s_IRCUT_20260622-200000.jpg');

    // Persisted, so "why did that sync pull fewer files?" is answerable after
    // the next run has already overwritten the live status.
    const { entries } = getImportHistory(1, 0);
    expect(entries).toHaveLength(1);
    expect(countFor(entries[0].skipped ?? [], 'failed-frame')).toBe(2);
  });

  it('treats a _sub folder as authoritative over the filename', () => {
    // A file the firmware dropped into a `_sub` folder is a sub-frame whatever
    // it is called, so it must be gated by the sub-frame rules (FITS only) and
    // not slip in under the JPG setting. This is the rule the folder-import
    // wizard has always applied; the telescope path used to judge by filename
    // alone, which is exactly the kind of divergence that made the two importers
    // produce different libraries from the same files.
    const decision = classifyImportFile('stacked.jpg', { importJpg: true, importSubFrames: true }, { fromSubFolder: true });
    expect(decision).toEqual({ import: false, reason: 'sub-folder-preview' });
    // Same name outside a `_sub` folder still imports.
    expect(classifyImportFile('stacked.jpg', { importJpg: true }).import).toBe(true);
  });
});


describe('skip tally sizes', () => {
  it('sums the bytes of each group so the report can say how much was left', () => {
    const tally: SkipTally = new Map();
    countSkip(tally, 'processing-artifact', 1, 100_886_198);
    countSkip(tally, 'processing-artifact', 1, 38_500_704);
    const [group] = summarizeSkips(tally);
    expect(group.count).toBe(2);
    expect(group.bytes).toBe(139_386_902);
  });

  it('reports zero bytes when no size was known, rather than guessing', () => {
    // A remote listing does not always carry sizes. 0 means "not measured" and
    // the UI omits the size instead of rendering "0 B".
    const tally: SkipTally = new Map();
    countSkip(tally, 'failed-frame', 3);
    expect(summarizeSkips(tally)[0].bytes).toBe(0);
  });
});
