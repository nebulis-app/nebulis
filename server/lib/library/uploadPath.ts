/**
 * Path sanitization for the folder-import upload staging step.
 *
 * The upload route reconstructs an uploaded folder tree under a UUID temp dir
 * by joining each file's client-supplied relative path onto that dir. The
 * relative path is fully attacker-controlled (it comes from the browser's
 * `webkitRelativePath` or the file's `originalname`), so it must never be able
 * to escape the temp dir via `..`, an absolute path, backslash separators, or
 * control characters.
 *
 * `stageUploadDestPath` is the single guard for that. It returns the absolute
 * destination path when it is provably contained inside `tmpDir`, or `null`
 * when the input is unsafe so the caller can skip the file instead of writing
 * outside the staging area.
 */
import path from 'path';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Resolve the staging destination for an uploaded file's relative path.
 *
 * @param tmpDir absolute path of the per-upload staging dir (created by caller)
 * @param rawRel client-supplied relative path (may contain folder segments)
 * @returns absolute path inside `tmpDir`, or `null` if the input is unsafe
 */
export function stageUploadDestPath(tmpDir: string, rawRel: string): string | null {
  // Null bytes / control chars never belong in a path; Node would throw on them
  // anyway, but rejecting up front lets the caller skip cleanly.
  if (CONTROL_CHARS.test(rawRel)) return null;

  // Normalize separators, then drop traversal and empty segments. This strips
  // a leading "/" (becomes an empty first segment) and any ".."/"." component.
  const safeParts = rawRel
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '..' && p !== '.' && p !== '');
  if (safeParts.length === 0) return null;

  const destAbs = path.resolve(tmpDir, safeParts.join(path.sep));

  // Belt-and-suspenders: confirm the resolved path is still inside tmpDir.
  // Compare against the root with a trailing separator so a sibling dir like
  // `<tmp>-evil` cannot satisfy a bare prefix match.
  const root = tmpDir.endsWith(path.sep) ? tmpDir : tmpDir + path.sep;
  if (!destAbs.startsWith(root)) return null;

  return destAbs;
}
