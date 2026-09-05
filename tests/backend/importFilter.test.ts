import { describe, it, expect } from 'vitest';
import {
  shouldImportFile,
  classifyImportFile,
  isDwarfInternalArtifact,
  isDwarfMasterStack,
} from '../../server/lib/library/importFilter.js';

const SUBS_ON = { importSubFrames: true, importFits: true, importJpg: true, importThumbnails: true };

describe('shouldImportFile — sub-frames are FITS only', () => {
  it('imports raw .fit light frames when sub-frames are enabled', () => {
    expect(shouldImportFile('Light_M42_10.0s_IRCUT_20260407-043257.fit', SUBS_ON)).toBe(true);
    expect(shouldImportFile('sub_0001_M42_10.0s_IRCUT_20260407-043257.fits', SUBS_ON)).toBe(true);
  });

  it('rejects a frame-named JPG in the _sub folder even with JPG import on', () => {
    // Some firmware drops a Light_*.jpg preview alongside the raw subs. It must
    // never ride in under the sub-frame setting.
    expect(shouldImportFile('Light_M42_10.0s_IRCUT_20260407-043257.jpg', SUBS_ON)).toBe(false);
    expect(shouldImportFile('sub_0001_M42_10.0s_IRCUT_20260407-043257.jpg', SUBS_ON)).toBe(false);
  });

  it('rejects frame-named JPGs whose object name contains spaces', () => {
    // Real SeeStar names carry spaces ("M 16", "C 30"). These previously parsed
    // as 'other' and slipped past the sub-frame gate entirely.
    expect(shouldImportFile('Light_M 16_20.0s_LP_20260604-025129.jpg', SUBS_ON)).toBe(false);
    expect(shouldImportFile('Light_C 30_20.0s_IRCUT_20260604-034020.jpg', SUBS_ON)).toBe(false);
    // The matching raw .fit still imports.
    expect(shouldImportFile('Light_M 16_20.0s_LP_20260604-025129.fit', SUBS_ON)).toBe(true);
  });

  it('rejects the Dwarf per-frame preview that shares a stem with the raw frame', () => {
    // A RAW_TELE session folder holds the frame, and Thumbnail/<same stem>.jpg
    // beside it. Only the directory tells them apart, and the filter sees just
    // the name — so the extension has to carry the decision.
    const stem = 'IC 1396_60s60_Duo-Band_20260704-235645742_34C';
    expect(shouldImportFile(`${stem}.fits`, SUBS_ON)).toBe(true);
    expect(shouldImportFile(`${stem}.jpg`, SUBS_ON)).toBe(false);
    expect(classifyImportFile(`${stem}.jpg`, SUBS_ON)).toEqual({
      import: false,
      reason: 'sub-folder-preview',
    });
  });

  it('rejects all sub-frames when the sub-frame setting is off', () => {
    expect(shouldImportFile('Light_M42_10.0s_IRCUT_20260407-043257.fit', { importSubFrames: false })).toBe(false);
  });

  it('still imports a normal stacked JPG via the JPG setting', () => {
    expect(shouldImportFile('Stacked_30_M42_10.0s_IRCUT_20260407-043257.jpg', SUBS_ON)).toBe(true);
  });
});

describe('archive mode (archiveAllFiles)', () => {
  const base = { importJpg: true, importFits: true, importThumbnails: true, importVideos: true };
  const off = { ...base, archiveAllFiles: false };
  const on = { ...base, archiveAllFiles: true };

  it('keeps files with an extension Nebulis does not recognize', () => {
    expect(classifyImportFile('telemetry.dat', off)).toEqual({
      import: false, reason: 'not-a-real-file',
    });
    expect(classifyImportFile('telemetry.dat', on)).toEqual({ import: true });
  });

  it('keeps the telescope working images it normally refuses', () => {
    expect(classifyImportFile('img_reference.png', off).import).toBe(false);
    expect(classifyImportFile('img_reference.png', on)).toEqual({ import: true });
    expect(classifyImportFile('img_stacked_counter.png', on)).toEqual({ import: true });
  });

  it('keeps frames the telescope marked failed', () => {
    const name = 'failed_C 50_15s60_Astro_20260419-220854256_23C.fits';
    expect(classifyImportFile(name, { ...off, importSubFrames: true }))
      .toEqual({ import: false, reason: 'failed-frame' });
    expect(classifyImportFile(name, on)).toEqual({ import: true });
  });

  it('still refuses OS junk, which is not user data', () => {
    // The one category archive mode must never rescue: copying .DS_Store and
    // AppleDouble forks into an archive is noise, not completeness.
    for (const name of ['.DS_Store', '._Light_001.fit', 'Thumbs.db', '.hidden.fits']) {
      expect(classifyImportFile(name, on), name).toEqual({
        import: false, reason: 'not-a-real-file',
      });
    }
  });

  it('overrides every per-type toggle, because "everything" means everything', () => {
    // Archive mode is a hard override, not a relaxation of a few rules. A switch
    // labelled "keep it all" that still silently dropped whole categories would
    // be worse than not offering one.
    const allTypesOff = {
      archiveAllFiles: true,
      importJpg: false, importFits: false, importThumbnails: false,
      importSubFrames: false, importVideos: false,
    };
    const cases = [
      'Stacked_10_M42_30.0s_IRCUT_20260622-200000.jpg',
      'Stacked_10_M42_30.0s_IRCUT_20260622-200000.fit',
      'Stacked_10_M42_30.0s_IRCUT_20260622-200000_thn.jpg',
      'sub_00001_M42_10.0s_IRCUT_20241015-205200.fit',
      'moon_20260101.mp4',
    ];
    for (const name of cases) {
      expect(classifyImportFile(name, allTypesOff), name).toEqual({ import: true });
    }
    // Sanity: with archiving off, those same toggles do still refuse them.
    for (const name of cases) {
      expect(classifyImportFile(name, { ...allTypesOff, archiveAllFiles: false }).import, name).toBe(false);
    }
  });

  it('keeps a frame-named preview inside a _sub folder', () => {
    // Normally refused as sub-folder-preview: sub-frame import is FITS only.
    // Under archive mode it is part of what the device holds.
    const name = 'Light_M42_10.0s_IRCUT_20260407-043257.jpg';
    expect(classifyImportFile(name, { ...off, importSubFrames: true }, { fromSubFolder: true }))
      .toEqual({ import: false, reason: 'sub-folder-preview' });
    expect(classifyImportFile(name, on, { fromSubFolder: true })).toEqual({ import: true });
  });

  it('keeps the master stack either way, since that was always a bug', () => {
    expect(classifyImportFile('img_stacked_all.tif', off)).toEqual({ import: true });
    expect(classifyImportFile('img_stacked_all.tif', on)).toEqual({ import: true });
  });

  it('flags the plate-solve / stack-count working images as internal artifacts', () => {
    // These are archived (kept on disk) but no client should list them as photos.
    expect(isDwarfInternalArtifact('img_reference.png')).toBe(true);
    expect(isDwarfInternalArtifact('img_stacked_counter.png')).toBe(true);
    expect(isDwarfInternalArtifact('IMG_Reference.PNG')).toBe(true);
    // The master stack and a user's own file are not artifacts.
    expect(isDwarfInternalArtifact('img_stacked_all.tif')).toBe(false);
    expect(isDwarfMasterStack('img_stacked_all.tif')).toBe(true);
    expect(isDwarfInternalArtifact('M31_reference_shot.png')).toBe(false);
    expect(isDwarfInternalArtifact('stacked.jpg')).toBe(false);
  });

  it('keeps sidecars either way', () => {
    expect(classifyImportFile('shotsInfo.json', off)).toEqual({ import: true });
    expect(classifyImportFile('shotsInfo.json', on)).toEqual({ import: true });
  });
});
