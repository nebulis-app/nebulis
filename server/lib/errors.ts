/** Narrows an unknown catch-block error to Node's errno-carrying Error subtype
 *  (fs/net errors: ENOENT, EXDEV, EADDRINUSE, ...) without an unchecked cast. */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** The errno `code` (ENOENT, EEXIST, ...) of a caught error, or undefined when
 *  the value carries none. Replaces `(err as NodeJS.ErrnoException).code`. */
export function errnoCode(err: unknown): string | undefined {
  return isErrnoException(err) ? err.code : undefined;
}

/** The captured `stdout`/`stderr` that child_process attaches to a failed
 *  execFile/exec error, decoded the same way a template literal would (a Buffer
 *  is read as UTF-8). Undefined when the error carries no such output. */
export function childProcessOutput(err: unknown, stream: 'stdout' | 'stderr'): string | undefined {
  if (typeof err !== 'object' || err === null || !(stream in err)) return undefined;
  const value: unknown = Reflect.get(err, stream);
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString();
  return undefined;
}
