/** Narrows an unknown catch-block error to Node's errno-carrying Error subtype
 *  (fs/net errors: ENOENT, EXDEV, EADDRINUSE, ...) without an unchecked cast. */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
