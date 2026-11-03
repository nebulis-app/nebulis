/**
 * Whether a path is there, without mistaking "could not check" for "gone".
 *
 * `access(...).then(true, false)` folds every failure into "missing". On a flaky
 * network share or a drive with a permissions problem that turns a read error into
 * a verdict, and the callers of this act on the verdict by dropping records. Only
 * a definite "no such file" counts as missing here; anything else is `error`, and
 * a caller must leave that path alone.
 */
import fsp from 'fs/promises';
import { errnoCode } from './errors.js';

export type PathProbe = 'present' | 'missing' | 'error';

export async function probePath(absPath: string): Promise<PathProbe> {
  try {
    await fsp.access(absPath);
    return 'present';
  } catch (err) {
    const code = errnoCode(err);
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error';
  }
}

/**
 * True when the folder is missing or holds nothing but hidden entries (marker files, `.DS_Store`).
 *
 * A pinned `LIBRARY_DIR` has no marker to prove the right disk is mounted. When the share behind it is absent,
 * Docker leaves the empty mount-target folder in its place, so every file probes as a definite "no such file" and
 * the library looks entirely stale. A library the database knows has files does not look like this when it is
 * really there, so callers that act on "missing" treat it as "could not check".
 */
export async function directoryHoldsNothing(absDir: string): Promise<boolean> {
  try {
    const names = await fsp.readdir(absDir);
    return !names.some(n => !n.startsWith('.'));
  } catch {
    return true;
  }
}
