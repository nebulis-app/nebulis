/**
 * Device-tree fixture builders for the golden import snapshots
 * (CORE-PIPELINE-REMEDIATION Phase 2). Each function writes a realistic
 * on-disk telescope layout to a fresh temp dir and returns
 * `{ root, kind }` — enough to build a `local`-transport profile and run
 * the real import path against it.
 *
 * Keep these layouts stable: a change here changes every golden snapshot.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TelescopeKind } from '../../../server/lib/types/telescopeKind';

export interface DeviceFixture {
  root: string;
  kind: TelescopeKind;
}

function mkTmp(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nebulis-golden-${tag}-`));
}

function write(root: string, relPath: string, contents: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

/** SeeStar: flat object folder under MyWorks, a stacked JPG + FITS, no subs. */
export function seestarFlat(): DeviceFixture {
  const root = mkTmp('seestar-flat');
  write(root, 'MyWorks/M42/Stacked_30_M42_10.0s_IRCUT_20260407-210000.jpg', 'seestar-m42-stacked-jpg');
  write(root, 'MyWorks/M42/Stacked_30_M42_10.0s_IRCUT_20260407-210000.fit', 'seestar-m42-stacked-fit-bytes');
  write(root, 'MyWorks/M42/Stacked_30_M42_10.0s_IRCUT_20260407-210000_thn.jpg', 'thumb');
  return { root, kind: 'seestar-s50' };
}

/** SeeStar: as above plus a `<Object>_sub` companion folder of raw frames. */
export function seestarWithSubFolder(): DeviceFixture {
  const { root } = seestarFlat();
  write(root, 'MyWorks/M42_sub/sub_00001_M42_10.0s_IRCUT_20260407-205500.fit', 'seestar-sub-1');
  write(root, 'MyWorks/M42_sub/sub_00002_M42_10.0s_IRCUT_20260407-205530.fit', 'seestar-sub-2');
  return { root, kind: 'seestar-s50' };
}

/** Generic SMB layout (telescope kind "other"): <Object>/<YYYY-MM-DD>_HHMM
 *  with lights/, subframes/, and a meta.json sidecar. */
export function genericSmbLayout(): DeviceFixture {
  const root = mkTmp('generic-smb');
  const session = 'M31/2026-04-26_2030';
  write(root, `${session}/lights/M31_stacked.fit`, 'generic-stacked-fits-bytes');
  write(root, `${session}/lights/M31_stacked.jpg`, 'generic-stacked-jpg-bytes');
  write(root, `${session}/subframes/M31_001.fit`, 'generic-sub-1');
  write(root, `${session}/subframes/M31_002.fit`, 'generic-sub-2');
  write(root, `${session}/meta.json`, JSON.stringify({ exposureSec: 30, gain: 80, filter: 'L', frameCount: 120 }));
  return { root, kind: 'other' };
}

/** ASIAIR: frame-type-first layout. One target reached through Autorun, Plan
 *  and Live at once, plus target-less calibration that must be archived
 *  rather than turned into objects. */
export function asiairLayout(): DeviceFixture {
  const root = mkTmp('asiair');
  write(root, 'Autorun/Light/M42/Light_M42_10.0s_Bin1_S_gain360_20240320-203324_-10.0C_0001.fit', 'asiair-light-1');
  write(root, 'Autorun/Light/M42/Light_M42_10.0s_Bin1_S_gain360_20240320-203424_-10.0C_0002.fit', 'asiair-light-2');
  write(root, 'Plan/Light/M42/Light_M42_300.0s_Bin1_Ha_gain100_20240321-013000_-10.0C_0001.fit', 'asiair-plan-light');
  // The Live/ output filename is NOT verified against a device — only that
  // Live output is written per target. Deliberately left without a parseable
  // date so the snapshot records what happens to an undated final image: it
  // lands at object level rather than in a session folder, which is the same
  // thing an unparseable SeeStar name does.
  write(root, 'Live/M42/Live_Stack_M42.fit', 'asiair-live-stack');
  write(root, 'Autorun/Dark/Dark_60s_Bin1_20240320-235959_0018.fit', 'asiair-dark');
  write(root, 'Autorun/Flat/Flat_1.0ms_Bin1_S_gain100_20240320-233122_-10.5C_0001.fit', 'asiair-flat');
  return { root, kind: 'asiair' };
}

/** Dwarf 3: one nested session folder under Astronomy/ with a stack + preview. */
export function dwarfNested(): DeviceFixture {
  const root = mkTmp('dwarf-nested');
  const session = 'Astronomy/DWARF3_RAW_M42_EXP_30_GAIN_80_2026-08-01_21-00-00-000';
  write(root, `${session}/DWARF3_M42_2026-08-01_21-00-00-000.fits`, 'dwarf-m42-stack-fits-bytes');
  write(root, `${session}/DWARF3_M42_2026-08-01_21-00-00-000.jpg`, 'dwarf-m42-preview-jpg');
  write(root, `${session}/stacked.jpg`, 'dwarf-m42-stacked-jpg');
  write(root, `${session}/001-DWARF3_M42_2026-08-01_21-00-15-000.fits`, 'dwarf-m42-raw-sub-1');
  return { root, kind: 'dwarf-3' };
}

/** Dwarf 3: a nested session plus a cloud-combined RESTACKED subfolder that
 *  matches the same target. */
export function dwarfWithRestacked(): DeviceFixture {
  const { root } = dwarfNested();
  write(root, 'Astronomy/RESTACKED/M42/megastack.jpg', 'dwarf-m42-megastack-bytes');
  write(root, 'Astronomy/RESTACKED/M42/stacked_thumbnail.jpg', 'dwarf-m42-megastack-thumb');
  return { root, kind: 'dwarf-3' };
}

/** Dwarf 3: a nested session plus calibration folders (never observations). */
export function dwarfWithCalibration(): DeviceFixture {
  const { root } = dwarfNested();
  write(root, 'Astronomy/CALI_FRAME/cali_001.fits', 'dwarf-cali-1');
  write(root, 'Astronomy/DWARF_DARK/dark_001.fits', 'dwarf-dark-1');
  return { root, kind: 'dwarf-3' };
}
