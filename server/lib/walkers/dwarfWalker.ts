/**
 * Dwarf telescope folder walker. Handles both Dwarf II and Dwarf 3.
 *
 * BEST-EFFORT, UNVERIFIED. Based on the layouts documented in DwarfLab forum
 * posts and FAQ pages. Validate against a real device before shipping as
 * "supported"; treat divergent layouts as a bug report against this file.
 *
 * Dwarf 3 (model: 'dwarf-3'):
 *   <root>/Astronomy/
 *     DWARF3_RAW_<TARGET>_EXP_<exposure>_GAIN_<gain>_<TIMESTAMP>/
 *       shotsInfo.json
 *       stacked-XXXX.fits          ← rolling stack
 *       NNN-<filename>.fits        ← individual subframes
 *       DWARF3_<TARGET>_<TIMESTAMP>.jpg   ← preview thumbnail
 *
 * Dwarf II (model: 'dwarf-2'):
 *   <root>/Astronomy/
 *     DWARF_RAW_TELE_<TARGET>_EXP_<exp>_GAIN_<gain>_<TIMESTAMP>/   ← USB export
 *     DWARF_RAW_<TARGET>_<TIMESTAMP>/                               ← older format
 *       shotsInfo.json
 *       <TARGET>_<exp>s<gain>_<mode>_<YYYYMMDD>-<HHMMSSmmm>_<temp>C.fits  ← subframes
 *       stacked-<N>_<TARGET>_<exp>s<gain>_<mode>_<YYYYMMDD>-<HHMMSSmmm>.fits ← rolling stack
 *       stacked.jpg / stacked_thumbnail.jpg                         ← preview
 *     DWARF_<TARGET>_<TIMESTAMP>.fits    ← final stack (often at Astronomy/ level)
 *     DWARF_<TARGET>_<TIMESTAMP>.jpg     ← preview thumbnail
 *
 * Both variants:
 *   - The session-folder name encodes target + (settings) + timestamp.
 *   - Multiple sessions on the same target become multiple folders.
 *   - We map: target → DiscoveredObject, each session folder → one "imaging
 *     session" inside that object. The current Object/Session DB model already
 *     supports many sessions per object, so this fits cleanly.
 */

import path from 'path';
import { smbListDir, type SmbEntry } from '../smb.js';
import { debugLog } from '../debugLogger.js';
import type { TelescopeProfile } from '../telescopes.js';
import type { WalkerConfig, DiscoveredObject } from './telescopeWalker.js';

/** Dwarf places everything under an "Astronomy" subfolder of the storage root. */
export const DWARF_BASE_PATH = 'Astronomy';

/** Folder-name prefixes that identify a Dwarf session folder (subframes inside). */
const SESSION_PREFIXES = ['DWARF3_RAW_', 'DWARF_RAW_'];

/** Pulls the target name out of a session-folder name.
 *
 *  DWARF3_RAW_M42_EXP_30_GAIN_80_2024-10-15_21-05-30-345  → "M42"
 *  DWARF_RAW_NGC7000_2024-10-15_21-05-30-345              → "NGC7000"
 *  DWARF3_RAW_NGC 7000_EXP_30_GAIN_80_...                 → "NGC 7000" (spaces preserved)
 *
 *  Returns null when the folder name doesn't match either pattern.
 */
export function extractTargetFromSessionFolder(folderName: string): string | null {
  for (const prefix of SESSION_PREFIXES) {
    if (!folderName.startsWith(prefix)) continue;
    // Strip optical-mode segment inserted by Dwarf II USB exports between the
    // session prefix and the target name (TELE_ = telephoto, WIDE_ = wide-angle).
    const rest = folderName.slice(prefix.length).replace(/^(TELE|WIDE)_/i, '');

    // Dwarf 3: target is followed by "_EXP_<n>_GAIN_<n>_<timestamp>".
    // We anchor on "_EXP_" because targets themselves can contain underscores
    // (e.g. NGC_7000, IC_1318) and we don't want to split on every underscore.
    const expIdx = rest.search(/_EXP_\d/);
    if (expIdx > 0) return rest.slice(0, expIdx).replace(/_/g, ' ').trim();

    // Dwarf II: target is followed by "_<timestamp>" where timestamp looks
    // like _YYYY-MM-DD_ or _YYYYMMDD_. Match the first date-like token.
    const tsMatch = rest.match(/_(\d{4}-?\d{2}-?\d{2})/);
    if (tsMatch && tsMatch.index !== undefined) {
      return rest.slice(0, tsMatch.index).replace(/_/g, ' ').trim();
    }

    // No EXP marker and no timestamp pattern matched. Returning a guess from
    // the last underscore corrupts targets that legitimately end in a token
    // like "_part2" or "_v3", causing two real sessions on the same target to
    // group apart. Better to fail closed — the caller will skip the file
    // rather than write it into a misnamed library object.
    return null;
  }
  return null;
}

export function isDwarfSessionFolder(folderName: string): boolean {
  return SESSION_PREFIXES.some(p => folderName.startsWith(p));
}

/** Pull the YYYY-MM-DD_HH-MM-SS[-mmm] trailing timestamp out of a session folder.
 *  Dwarf 3 folders use an underscore between date and time; Dwarf II USB folders
 *  use an all-dash format (YYYY-MM-DD-HH-MM-SS-mmm). Both are normalised to
 *  YYYY-MM-DD_HH-MM-SS[-mmm] on return so callers don't need to branch.
 *  Returns null when no timestamp-like trailing token is found. */
export function extractTimestampFromSessionFolder(folderName: string): string | null {
  // Dwarf 3: trailing _YYYY-MM-DD_HH-MM-SS[-mmm]
  const m3 = folderName.match(/_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?)$/);
  if (m3) return m3[1];
  // Dwarf II USB: trailing _YYYY-MM-DD-HH-MM-SS[-mmm] (all dashes, no underscore)
  const m2 = folderName.match(/_(\d{4}-\d{2}-\d{2})-(\d{2}-\d{2}-\d{2}(?:-\d+)?)$/);
  if (m2) return `${m2[1]}_${m2[2]}`;
  return null;
}

/** Pull the YYYY-MM-DD session date out of a Dwarf session folder name.
 *
 *  Dwarf folders embed the capture date as part of the trailing timestamp:
 *    DWARF3_RAW_M42_EXP_30_GAIN_80_2024-10-15_21-05-30-345  → "2024-10-15"
 *    DWARF_RAW_NGC7000_20241015_21-05-30                    → "2024-10-15"
 *
 *  Returns null when no date-like token is found. Files inside the folder
 *  inherit this date because Dwarf filenames don't carry one of their own. */
export function extractDateFromSessionFolder(folderName: string): string | null {
  const m = folderName.match(/_(\d{4})-?(\d{2})-?(\d{2})(?:[_-]|$)/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function getDwarfWalkerConfig(): WalkerConfig {
  return { basePath: DWARF_BASE_PATH };
}

/** List every distinct target across all session folders under Astronomy/. */
export async function discoverDwarfObjects(profile: TelescopeProfile): Promise<DiscoveredObject[]> {
  debugLog('walker:dwarf', `Listing ${DWARF_BASE_PATH} for session folders`);
  const entries = await smbListDir(DWARF_BASE_PATH, profile);
  const allDirs = entries.filter(e => e.type === 'dir');
  debugLog('walker:dwarf', `Found ${allDirs.length} dir(s) under ${DWARF_BASE_PATH}`);
  const sessionFolders = allDirs.filter(e => isDwarfSessionFolder(e.name));
  debugLog('walker:dwarf', `${sessionFolders.length} session folder(s): ${sessionFolders.map(f => f.name).join(', ') || '(none)'}`);

  // Group session folders by target name. The DiscoveredObject model has one
  // "folder per object" expectation that doesn't fit Dwarf — instead we use
  // the target name as a synthetic folder identifier and keep the list of
  // real session folders alongside (see DwarfDiscoveredObject below).
  const byTarget = new Map<string, string[]>();
  const skipped: string[] = [];
  for (const folder of sessionFolders) {
    const target = extractTargetFromSessionFolder(folder.name);
    if (!target) { skipped.push(folder.name); continue; }
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target)!.push(folder.name);
  }
  if (skipped.length > 0) debugLog('walker:dwarf', `${skipped.length} folder(s) skipped (could not extract target): ${skipped.join(', ')}`);

  const result = Array.from(byTarget.entries()).map(([target, folders]) => ({
    folderName: target,
    subFolderName: null,
    // Stash the real folder list in a non-standard field; the import pipeline
    // can read it back via the cast in listDwarfObjectFiles below.
    _dwarfSessionFolders: folders,
  } as DwarfDiscoveredObject));
  debugLog('walker:dwarf', `${result.length} distinct target(s) discovered: ${result.map(o => o.folderName).join(', ') || '(none)'}`);
  return result;
}

/** DiscoveredObject augmented with the actual Dwarf session folder names. */
export interface DwarfDiscoveredObject extends DiscoveredObject {
  _dwarfSessionFolders?: string[];
}

/** List FITS / JPG files across every session folder for one target. */
export async function listDwarfObjectFiles(
  profile: TelescopeProfile,
  object: DwarfDiscoveredObject,
): Promise<{ files: SmbEntry[]; subFiles: SmbEntry[] }> {
  const sessionFolders = object._dwarfSessionFolders ?? [];
  debugLog('walker:dwarf', `Listing files for target "${object.folderName}" across ${sessionFolders.length} session folder(s): ${sessionFolders.join(', ')}`);

  const files: SmbEntry[] = [];
  const subFiles: SmbEntry[] = [];

  for (const folder of sessionFolders) {
    const folderPath = path.posix.join(DWARF_BASE_PATH, folder);
    let entries: SmbEntry[] = [];
    try {
      entries = await smbListDir(folderPath, profile);
    } catch {
      debugLog('walker:dwarf', `Failed to list ${folderPath} — skipping`);
      continue;
    }
    const fileEntries = entries.filter(e => e.type === 'file');
    let stackCount = 0; let subCount = 0; let otherCount = 0;
    for (const e of fileEntries) {
      const lower = e.name.toLowerCase();
      // Heuristic: numbered subframes ("0001_M42_...fits", "001-...fits") go
      // into subFiles; rolling stacks and previews go into files.
      // Dwarf II USB subframes have no numeric prefix — classify any .fits file
      // that isn't a rolling stack as a subframe.
      const isStack = lower.startsWith('stacked-') || lower.startsWith('stacked_');
      const isSub =
        /^\d{3,4}[_-]/.test(e.name) ||
        lower.startsWith('frame') ||
        ((lower.endsWith('.fit') || lower.endsWith('.fits')) && !isStack);
      // Annotate the entry name with its source folder so the import pipeline
      // can reconstruct the absolute path. We can't change SmbEntry's shape
      // without a much bigger refactor, so prefix the folder name into the
      // file's name field — buildDwarfFilePath below strips it back off.
      const tagged: SmbEntry = { ...e, name: `${folder}/${e.name}` };
      if (isStack) { files.push(tagged); stackCount++; }
      else if (isSub) { subFiles.push(tagged); subCount++; }
      else { files.push(tagged); otherCount++; } // previews, metadata, anything else
    }
    debugLog('walker:dwarf', `  ${folder}: ${stackCount} stack(s), ${subCount} sub-frame(s), ${otherCount} other(s)`);
  }

  debugLog('walker:dwarf', `Target "${object.folderName}": ${files.length} main file(s), ${subFiles.length} sub-file(s) total`);
  return { files, subFiles };
}

export function buildDwarfFilePath(fileName: string): string {
  // fileName comes back as "<sessionFolder>/<file>" from listDwarfObjectFiles.
  // Just prepend the Astronomy base path.
  return path.posix.join(DWARF_BASE_PATH, fileName);
}
