/**
 * Generic SMB walker — the "Generic SMB Layout" documented in the Add
 * Telescope modal and the Help page, for telescope kind 'other' (a NAS, a
 * PC share, or any camera that isn't a SeeStar or a Dwarf).
 *
 *   <share root>/
 *     <Object>/                    one folder per object (catalog id or common name)
 *       <YYYY-MM-DD>_<HHMM>/       session folder, local time
 *         lights/                  required: at least one stacked or single-shot final
 *         subframes/               optional: individual sub-frames
 *         meta.json                optional: exposureSec, gain, filter, frameCount, integrationSec
 *
 * An object folder with no session folder that has a non-empty lights/ is
 * skipped entirely, so a partial upload never creates a library object with
 * nothing in it. Filenames inside lights/ and subframes/ are not pattern-
 * matched (unlike SeeStar/Dwarf) — the folder a file sits in is the only
 * thing that decides whether it is a final image or a sub-frame.
 */
import path from 'path';
import { smbListDir, type SmbEntry } from '../smb.js';
import { debugLog } from '../debugLogger.js';
import { log } from '../logger.js';
import { isObjectFolder } from '../telescopeFiles.js';
import type { TelescopeProfile } from '../telescopes.js';
import type { DiscoveredObject } from './telescopeWalker.js';

/** Object folders live at the share root for a generic source. */
export const GENERIC_BASE_PATH = '';

/** `YYYY-MM-DD_HHMM`, e.g. "2026-04-26_2030". */
const SESSION_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{4}$/;

export function isGenericSessionFolder(name: string): boolean {
  return SESSION_FOLDER_PATTERN.test(name);
}

/** DiscoveredObject augmented with the real session folder names found
 *  under it (each one already verified to hold a non-empty lights/). */
export interface GenericDiscoveredObject extends DiscoveredObject {
  _genericSessionFolders?: string[];
}

/** List object folders at the share root, keeping only the session folders
 *  under each that actually qualify (matches the date pattern and has at
 *  least one file in lights/). Two SMB round trips per candidate object
 *  (list the object, list each session's lights/) — the same shape of cost
 *  the SeeStar walker already pays per object for its `_sub` companion. */
export async function discoverGenericObjects(profile: TelescopeProfile): Promise<GenericDiscoveredObject[]> {
  debugLog('walker:generic', 'Listing share root for object folders');
  const rootEntries = await smbListDir('', profile);
  const objectDirs = rootEntries.filter(e => e.type === 'dir' && isObjectFolder(e.name));
  debugLog('walker:generic', `${objectDirs.length} candidate object folder(s) at share root`);

  const result: GenericDiscoveredObject[] = [];
  for (const objDir of objectDirs) {
    let sessionEntries: SmbEntry[];
    try {
      sessionEntries = await smbListDir(objDir.name, profile);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), object: objDir.name }, '[generic-walker] object folder listing failed; skipping');
      continue;
    }
    const candidateSessions = sessionEntries.filter(e => e.type === 'dir' && isGenericSessionFolder(e.name));

    const validSessions: string[] = [];
    for (const session of candidateSessions) {
      const lightsPath = path.posix.join(objDir.name, session.name, 'lights');
      try {
        const lightsEntries = await smbListDir(lightsPath, profile);
        if (lightsEntries.some(e => e.type === 'file')) validSessions.push(session.name);
        else debugLog('walker:generic', `"${objDir.name}/${session.name}": lights/ has no files — skipping session`);
      } catch {
        debugLog('walker:generic', `"${objDir.name}/${session.name}": no lights/ subfolder — skipping session`);
      }
    }

    if (validSessions.length > 0) {
      result.push({ folderName: objDir.name, subFolderName: null, _genericSessionFolders: validSessions });
    } else {
      debugLog('walker:generic', `"${objDir.name}": no valid session folders — skipping object`);
    }
  }
  debugLog('walker:generic', `${result.length} object(s) with at least one valid session`);
  return result;
}

/**
 * List every file across every session for one object: lights/ files and any
 * session-level meta.json go into `files`, subframes/ files go into
 * `subFiles`. Entries are tagged with their path relative to the object
 * folder (`<session>/lights/<name>`, `<session>/subframes/<name>`, or
 * `<session>/<name>` for meta.json) so buildGenericFilePath can reconstruct
 * the remote path and the import pipeline can recover the session folder.
 */
export async function listGenericObjectFiles(
  profile: TelescopeProfile,
  object: GenericDiscoveredObject,
): Promise<{ files: SmbEntry[]; subFiles: SmbEntry[] }> {
  const sessionFolders = object._genericSessionFolders ?? [];
  const files: SmbEntry[] = [];
  const subFiles: SmbEntry[] = [];

  for (const session of sessionFolders) {
    const sessionPath = path.posix.join(object.folderName, session);
    let sessionEntries: SmbEntry[] = [];
    try {
      sessionEntries = await smbListDir(sessionPath, profile);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), sessionPath }, '[generic-walker] session folder listing failed; skipping');
      continue;
    }

    // meta.json (or any other loose file someone drops beside lights/) lives
    // directly in the session folder.
    for (const e of sessionEntries.filter(x => x.type === 'file')) {
      files.push({ ...e, name: `${session}/${e.name}` });
    }

    const lightsDir = sessionEntries.find(e => e.type === 'dir' && e.name.toLowerCase() === 'lights');
    if (lightsDir) {
      try {
        const entries = await smbListDir(path.posix.join(sessionPath, lightsDir.name), profile);
        for (const e of entries.filter(x => x.type === 'file')) {
          files.push({ ...e, name: `${session}/lights/${e.name}` });
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), sessionPath }, '[generic-walker] lights/ listing failed; skipping');
      }
    }

    const subframesDir = sessionEntries.find(e => e.type === 'dir' && e.name.toLowerCase() === 'subframes');
    if (subframesDir) {
      try {
        const entries = await smbListDir(path.posix.join(sessionPath, subframesDir.name), profile);
        for (const e of entries.filter(x => x.type === 'file')) {
          subFiles.push({ ...e, name: `${session}/subframes/${e.name}` });
        }
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), sessionPath }, '[generic-walker] subframes/ listing failed; skipping');
      }
    }
  }

  debugLog('walker:generic', `"${object.folderName}": ${files.length} file(s), ${subFiles.length} sub-file(s) across ${sessionFolders.length} session(s)`);
  return { files, subFiles };
}

/** `fileName` comes back as "<session>/<name>" or "<session>/lights|subframes/<name>"
 *  from listGenericObjectFiles — just prepend the object folder. */
export function buildGenericFilePath(object: Pick<GenericDiscoveredObject, 'folderName'>, fileName: string): string {
  return path.posix.join(object.folderName, fileName);
}
