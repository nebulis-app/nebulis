/**
 * Path containment and destination refusal for the external-archive feature.
 *
 * This module deliberately contains no I/O beyond `realpath` lookups: it is the
 * guard that every later step calls before it writes or deletes anything, and it
 * exists before any of that code does. The ordering is the point. This codebase
 * has lost user data twice by adding the capability before the guard:
 *
 *  - Four audit criticals came from one unchecked fallback (`getFolderName`
 *    returning the raw object id on a DB miss) reaching filesystem sinks that
 *    joined it onto the library root. `DELETE /library/objects/%2e` resolved to
 *    the library root and removed it recursively.
 *  - The Dwarf RESTACKED migration inferred "already present" from a path
 *    relationship rather than verifying a copy, then deleted the source. See
 *    `server/lib/library/archiveFolders.ts` → `migrateRestackedToSharedRootOnce`.
 *
 * So the archive destination is validated by construction, not by convention:
 *
 *  1. It can never be, contain, or be contained by the library or DATA_DIR. The
 *     archive feature's retention pass deletes files under its configured root,
 *     so a destination that overlapped the library would eventually prune the
 *     library it exists to protect. That is the single highest-ranked risk of the
 *     external archive feature.
 *  2. Every path built inside it is a strict descendant, checked lexically AND
 *     after resolving symlinks, so a link placed inside the archive root cannot
 *     redirect a write or a prune outside it.
 *
 * `resolveContainedObjectDir` in `server/lib/library/objects.ts` is the sibling
 * guard on the library side and the model for the lexical checks here.
 */

import fs from 'fs';
import path from 'path';

import db from '../db.js';
import { DATA_DIR } from '../paths.js';
import { getLibraryDir } from '../libraryPath.js';

/** Why a configured destination was refused. Stable strings, surfaced as an
 *  error code by the route layer rather than re-derived from prose. */
export type DestinationRejection =
  | 'empty'
  | 'not-absolute'
  | 'overlaps-library'
  | 'overlaps-data-dir'
  | 'overlaps-linked-source';

export type ArchiveRootResult =
  | { ok: true; root: string }
  | { ok: false; reason: DestinationRejection };

/** `p` with exactly one trailing separator, so joining never yields `//`.
 *  Without this, `contains('/', x)` compared against `'//'` and the filesystem
 *  root slipped through every overlap check and was accepted as a destination. */
function withSep(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

/** `a` is `b`, or lives inside it. */
function isSameOrInside(a: string, b: string): boolean {
  return a === b || a.startsWith(withSep(b));
}

/** `a` strictly contains `b`. */
function contains(a: string, b: string): boolean {
  return b !== a && b.startsWith(withSep(a));
}

/**
 * The real path of `p`, or of its deepest existing ancestor.
 *
 * A destination is often configured before it exists (the user picks a folder on
 * a disk that has no archive on it yet), so `realpath` on the leaf would throw.
 * Walking up finds the nearest thing that can actually be resolved, which is
 * enough to catch a symlinked parent redirecting the whole tree elsewhere.
 */
function realpathDeepest(p: string): string | null {
  let current = path.resolve(p);
  while (true) {
    try {
      return fs.realpathSync.native(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Every form of `p` worth comparing: the lexical path, plus its resolved real
 * path when `p` itself exists.
 *
 * Deliberately NOT the deepest existing ancestor. The protected paths may not
 * exist yet, and walking up from a missing `{DATA_DIR}/library` resolves to
 * DATA_DIR itself, which made DATA_DIR look like it contained the library and
 * produced the wrong refusal reason for DATA_DIR as a candidate.
 */
function formsOf(p: string): string[] {
  const lexical = path.resolve(p);
  let real: string | null;
  try {
    real = fs.realpathSync.native(lexical);
  } catch {
    real = null;
  }
  return real && real !== lexical ? [lexical, real] : [lexical];
}

/**
 * Forms for a path that may not exist yet, which is the normal case for a
 * configured destination (a folder on a disk with no archive on it). Adds the
 * real path of the deepest existing ancestor, so a symlinked parent cannot
 * redirect the tree somewhere a purely lexical check would not notice.
 */
function candidateFormsOf(p: string): string[] {
  const forms = formsOf(p);
  const resolved = realpathWithMissingTail(p);
  if (resolved && !forms.includes(resolved)) forms.push(resolved);
  return forms;
}

/**
 * Where `p` really is, even when its last parts do not exist yet: the real path of
 * the deepest existing ancestor with the missing parts put back on.
 *
 * The ancestor alone is not the path. Comparing it stood in for the missing folder,
 * so two sibling folders that were both still to be created each resolved to their
 * shared parent and "overlapped", and an archive folder not yet made refused to sit
 * beside a linked folder on the same disk.
 */
function realpathWithMissingTail(p: string): string | null {
  let current = path.resolve(p);
  const tail: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when `candidate` must never be used as an archive destination.
 *
 * Covers both directions: a destination *inside* the library or DATA_DIR would
 * have the archive writing into the app's own storage, and a destination that
 * *contains* either would let a retention pass walk into them. An ancestor
 * usually contains both, which is why this is a single predicate rather than a
 * decision callers have to get right.
 */
export function isForbiddenDestination(candidate: string): boolean {
  const candidateForms = candidateFormsOf(candidate);
  const protectedForms = [...formsOf(getLibraryDir()), ...formsOf(DATA_DIR)];
  return candidateForms.some(c =>
    protectedForms.some(p => isSameOrInside(c, p) || contains(c, p)),
  );
}

/**
 * True when two paths are the same folder, or one lives inside the other, in any
 * combination of lexical and symlink-resolved forms. Either may not exist yet.
 *
 * The shared test for "would these two trees touch": the archive against a linked
 * folder (here) and a linked folder against the archive (`assertLinkableRoot`).
 * Both directions call this, so the rule cannot be stated two ways.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const aForms = candidateFormsOf(a);
  const bForms = candidateFormsOf(b);
  return aForms.some(x => bForms.some(y => isSameOrInside(x, y) || isSameOrInside(y, x)));
}

/**
 * The label of the first linked folder that overlaps `candidate`, or null.
 *
 * Read from the database on every call rather than cached: a folder can be linked
 * after the archive destination was saved, and the retention pass deletes under
 * the destination, so it must never delete inside a folder the user keeps their
 * originals in.
 */
export function findOverlappingLinkedSource(candidate: string): string | null {
  const rows = db.prepare<[], { rootPath: string; label: string }>(
    'SELECT rootPath, label FROM librarySources',
  ).all();
  for (const row of rows) {
    if (pathsOverlap(candidate, row.rootPath)) return row.label;
  }
  return null;
}

/**
 * Validate a user-configured archive destination.
 *
 * Returns the normalized absolute root, or a reason it was refused. The
 * reason distinguishes an unusable path (`empty`, `not-absolute`) from a
 * dangerous one (`overlaps-*`) so the API can explain the difference rather
 * than showing one generic message for both.
 */
export function resolveArchiveRoot(configuredPath: string): ArchiveRootResult {
  const raw = typeof configuredPath === 'string' ? configuredPath.trim() : '';
  if (raw === '') return { ok: false, reason: 'empty' };

  // Checked before any resolution: `path.resolve('')` is the cwd, and
  // `path.resolve('..')` escapes it, so a relative path must never reach the
  // overlap tests below.
  if (!path.isAbsolute(raw)) return { ok: false, reason: 'not-absolute' };

  const candidateForms = candidateFormsOf(raw);
  const libraryForms = formsOf(getLibraryDir());
  const dataForms = formsOf(DATA_DIR);

  // "Same or inside" is checked before "contains" so that the library and
  // DATA_DIR themselves are named precisely. The library normally lives inside
  // DATA_DIR, so the two overlap each other and the order is what keeps the
  // reported reason meaningful rather than arbitrary.
  if (candidateForms.some(c => libraryForms.some(l => isSameOrInside(c, l)))) {
    return { ok: false, reason: 'overlaps-library' };
  }
  if (candidateForms.some(c => dataForms.some(d => isSameOrInside(c, d)))) {
    return { ok: false, reason: 'overlaps-data-dir' };
  }
  if (candidateForms.some(c => libraryForms.some(l => contains(c, l)))) {
    return { ok: false, reason: 'overlaps-library' };
  }
  if (candidateForms.some(c => dataForms.some(d => contains(c, d)))) {
    return { ok: false, reason: 'overlaps-data-dir' };
  }

  // A linked folder holds the user's own originals. An archive that overlapped it
  // would copy the library into their capture folder, and its retention pass would
  // delete files there.
  if (findOverlappingLinkedSource(raw) !== null) {
    return { ok: false, reason: 'overlaps-linked-source' };
  }

  // Normalized, so a configured path with a trailing separator does not fail a
  // later `startsWith` containment check against its own children.
  return { ok: true, root: path.resolve(raw) };
}

/**
 * A single ordinary path segment.
 *
 * Rejects `''`, `.`, `..`, anything containing a separator, and anything whose
 * basename differs from itself (which catches Windows drive-absolute and
 * device-prefixed names on every platform). Mirrors the segment rule in
 * `resolveContainedObjectDir`.
 */
function isSafeSegment(segment: string): boolean {
  if (typeof segment !== 'string') return false;
  if (segment === '' || segment === '.' || segment === '..') return false;
  if (segment.includes('/') || segment.includes('\\')) return false;
  // A NUL would truncate the path inside a native call, hiding the real target
  // from every check above.
  if (segment.includes('\0')) return false;
  return path.basename(segment) === segment;
}

/**
 * Whether `candidate` is `root` itself or a descendant of it, after resolving
 * symlinks on the deepest part of each that exists.
 *
 * This is the sibling of `resolveContainedArchivePath` for the one target that
 * function cannot cover: the root itself. A network archive's root is built from a
 * share's subpath, and a share can contain a symlink pointing anywhere, so "the
 * string starts with the mount directory" is not the same statement as "the
 * directory is inside it". Lexical containment is checked first because it is free,
 * and the resolved form second because it is the one that matters.
 *
 * Returns false when either side cannot be resolved at all, which is the fail-closed
 * direction: an unresolvable root is not a root anything should be written under.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isSameOrInside(resolvedCandidate, resolvedRoot)) return false;

  const realRoot = realpathDeepest(resolvedRoot);
  if (realRoot === null) return false;
  const realCandidate = realpathDeepest(resolvedCandidate);
  if (realCandidate === null) return false;

  return isSameOrInside(realCandidate, realRoot);
}

/**
 * Resolve `<root>/<segments...>`, or null unless it is a strict descendant of
 * the root *after* symlinks are resolved.
 *
 * Returning null rather than throwing is deliberate: every caller is a write or
 * delete path, and "refuse and report" is the behaviour the refusal tests
 * assert. A caller that ignores this and uses the value anyway cannot, because
 * there is no value to use.
 */
export function resolveContainedArchivePath(root: string, ...segments: string[]): string | null {
  if (typeof root !== 'string' || root.trim() === '' || !path.isAbsolute(root)) return null;

  // No segments means "the root itself", which is never a valid file target.
  if (segments.length === 0) return null;
  if (!segments.every(isSafeSegment)) return null;

  const resolvedRoot = path.resolve(root);
  const realRoot = realpathDeepest(resolvedRoot);
  // Fail closed: without a resolvable root there is nothing to contain against.
  if (realRoot === null) return null;

  const target = path.resolve(resolvedRoot, ...segments);
  if (target === resolvedRoot || !target.startsWith(resolvedRoot + path.sep)) return null;

  // Lexical containment is not enough. `root/escape/file.jpg` looks contained
  // even when `root/escape` is a symlink to somewhere else entirely, so the
  // deepest existing part of the target is resolved and re-checked. When nothing
  // below the root exists yet, this resolves to the root itself and passes.
  const realTarget = realpathDeepest(target);
  if (realTarget === null) return null;
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;

  return target;
}

/**
 * Whether two existing paths live on the same filesystem device.
 *
 * Used to warn, never to refuse: an archive on the same disk as the library still
 * protects against deleting a file by mistake, it just does not survive that disk
 * failing. Anything that cannot be statted answers false, so an unreachable path
 * does not raise a warning about a disk we could not look at.
 */
export function isOnSameDevice(a: string, b: string): boolean {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false;
  }
}
