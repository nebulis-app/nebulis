/**
 * Resolve persistent data and log paths.
 *
 * macOS pkg → DATA_DIR env var   (set by LaunchAgent plist → ~/Library/Application Support/Nebulis)
 * Docker    → base = /app        (volume-mounted)
 * Windows   → base = %PROGRAMDATA%\Nebulis
 * Dev       → base = <cwd>
 */
import path from 'path';
import fs from 'fs';

function getBaseDir(): string {
  // Docker volume mount — checked first so Windows branch never fires in Docker
  if (fs.existsSync('/app/data')) return '/app';

  // Windows installed app — rooted in ProgramData (writable by all accounts)
  if (process.platform === 'win32') {
    return path.join(
      process.env.PROGRAMDATA || 'C:\\ProgramData',
      'Nebulis',
    );
  }

  // Local dev / Linux / macOS
  return process.cwd();
}

const BASE_DIR = getBaseDir();

export const DATA_DIR = (() => {
  const dir = process.env.DATA_DIR ?? path.join(BASE_DIR, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
})();

export const LOGS_DIR = (() => {
  // If neither env var is set, put logs alongside data so both are in one place.
  const dir = process.env.LOGS_DIR
    ?? (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'logs') : path.join(BASE_DIR, 'logs'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
})();

/**
 * Optional hard override for the library directory, from the `LIBRARY_DIR`
 * environment variable. When set to an absolute path this is where the library
 * lives, regardless of any relocation stored in the database. It is the
 * supported way to keep the library on a separate disk in headless/Docker
 * deployments (bind-mount the disk, point `LIBRARY_DIR` at the mount).
 *
 * A missing or non-absolute value is ignored (with a warning) so a typo can
 * never crash-loop the container. `server/lib/libraryPath.ts` is the consumer;
 * everything else reaches the library through `getLibraryDir()` there.
 */
export const LIBRARY_DIR_OVERRIDE: string | null = (() => {
  const raw = process.env.LIBRARY_DIR?.trim();
  if (!raw) return null;
  if (!path.isAbsolute(raw)) {
    console.warn(
      `[paths] LIBRARY_DIR="${raw}" is not an absolute path. Ignoring it and using the default library location.`,
    );
    return null;
  }
  return path.resolve(raw);
})();

export const LIBRARY_DIR = LIBRARY_DIR_OVERRIDE ?? path.join(DATA_DIR, 'library');

export const THUMBNAILS_DIR = (() => {
  const dir = path.join(DATA_DIR, 'thumbnails');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
})();
