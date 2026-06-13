/**
 * A dependency-free flag for "the library is locked for migration." While set,
 * the auto-import scheduler skips runs and a middleware rejects library-mutating
 * requests with 503 so nothing writes to (or holds a lock on) the library while
 * its files are being copied to a new location.
 *
 * Kept in its own module with no imports so both middleware and the migration
 * engine can use it without creating an import cycle.
 */
let migrating = false;

export function isLibraryMigrating(): boolean {
  return migrating;
}

export function setLibraryMigrating(value: boolean): void {
  migrating = value;
}
