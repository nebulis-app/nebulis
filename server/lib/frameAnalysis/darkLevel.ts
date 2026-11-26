/**
 * The level of a dark matching a light: what the camera reads with the shutter closed at the same settings (offset
 * plus dark current), to take off the light's background before converting it to electrons (skyBackground.ts).
 *
 * The dark is the one the stacking export would pick (stackingMatch.pickDark: same camera, exposure, gain and binning,
 * close in temperature), falling back to a bias of the same camera, gain and binning (the offset alone; the dark
 * current of a cooled camera is small next to the sky). It must also have the light's offset when both headers say:
 * the offset is the level itself. Its level is measured once, the way a light's background is, and kept.
 */
import db from '../db.js';
import { pickDark, sameCamera, type LightGroupInput } from '../stackingMatch.js';
import { measureOffThread } from './measureOffThread.js';

/** Bumped when how a level is measured changes. */
const DARK_LEVEL_VERSION = 1;
/** The calibration library is scanned at most this often for this purpose. */
const CANDIDATES_TTL_MS = 10 * 60_000;

db.exec(`CREATE TABLE IF NOT EXISTS frameDarkLevels (
  path     TEXT PRIMARY KEY,
  mtimeMs  REAL NOT NULL,
  version  INTEGER NOT NULL,
  level    REAL NOT NULL
)`);
const getLevel = db.prepare<[string], { mtimeMs: number; version: number; level: number }>('SELECT mtimeMs, version, level FROM frameDarkLevels WHERE path = ?');
const putLevel = db.prepare<[string, number, number, number]>(
  `INSERT INTO frameDarkLevels (path, mtimeMs, version, level) VALUES (?, ?, ?, ?)
   ON CONFLICT(path) DO UPDATE SET mtimeMs = excluded.mtimeMs, version = excluded.version, level = excluded.level`,
);

type Stacking = typeof import('../library/stackingExport.js');
let candidatesCache: { at: number; list: ReturnType<Stacking['listCalibrationCandidates']> } | null = null;

export interface DarkLevel { level: number; bundle: string }

export type LevelMeasurer = (abs: string) => Promise<number>;
const measureLevel: LevelMeasurer = async abs => (await measureOffThread(abs, null)).background;

/** The level of the dark matching this light, or null when the library has none that fits. */
export async function darkLevelFor(
  lightAbs: string,
  lightName: string,
  measure: LevelMeasurer = measureLevel,
  candidates?: ReturnType<Stacking['listCalibrationCandidates']>,
): Promise<DarkLevel | null> {
  // Imported here, not at the top: the stacking export imports this module's caller.
  const stacking: Stacking = await import('../library/stackingExport.js');
  const values = stacking.readHeaderValues(lightAbs);
  const settings = stacking.readLightSettings(lightAbs, lightName, values);
  const rig = stacking.rigFromHeader(values);
  const lightOffset = typeof values['OFFSET'] === 'number' ? values['OFFSET'] : null;
  if (!candidates && (!candidatesCache || Date.now() - candidatesCache.at > CANDIDATES_TTL_MS)) {
    candidatesCache = { at: Date.now(), list: stacking.listCalibrationCandidates() };
  }
  const all = candidates ?? candidatesCache!.list;
  const group: LightGroupInput = { night: '', scope: null, rig, ...settings };
  // pickDark hands back the candidate it was given, so its files come with it.
  const picked = pickDark(group, all).pick?.candidate;
  const dark = picked ? all.find(c => c === picked) : undefined;
  const bias = dark ? undefined : all.find(c => c.type === 'bias' && sameCamera(c.rig, rig)
    && (c.gain === null || settings.gain === null || c.gain === settings.gain)
    && (c.binning === null || settings.binning === null || c.binning === settings.binning));
  const chosen = dark ?? bias;
  if (!chosen) return null;
  const file = chosen.files.find(f => /\.(fits?|fts)$/i.test(f.name));
  if (!file) return null;
  const darkOffset = stacking.readHeaderValues(file.path)['OFFSET'];
  if (lightOffset !== null && typeof darkOffset === 'number' && darkOffset !== lightOffset) return null;

  const mtimeMs = Date.parse(file.modifiedAt) || 0;
  const hit = getLevel.get(file.path);
  if (hit && hit.version === DARK_LEVEL_VERSION && hit.mtimeMs === mtimeMs) return { level: hit.level, bundle: chosen.name };
  const level = await measure(file.path);
  putLevel.run(file.path, mtimeMs, DARK_LEVEL_VERSION, level);
  return { level, bundle: chosen.name };
}

export function _resetDarkLevelsForTests(): void {
  candidatesCache = null;
}
