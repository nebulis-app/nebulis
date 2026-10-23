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
