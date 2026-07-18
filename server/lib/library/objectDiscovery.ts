/**
 * The single source of truth for turning a directory of captures into library
 * objects: which folders are containers rather than objects, which target a
 * filename names, and how a folder's files divide into objects.
 *
 * This exists because the rules were previously reimplemented per import path.
 * `folderScan.ts` and `import.ts` each kept their own copy of the container
 * list and their own target-grouping loop, then drifted: the scanner grew a
 * "split a flat folder by target" rule the SMB path never got, and that rule
 * quietly dropped `_sub` companions and nested session folders. Rules that must
 * agree belong in one place, so keep new ones here rather than at a call site.
 *
 * Everything here is pure: callers do their own I/O (local fs, SMB) and hand in
 * plain names. That is what lets one set of rules serve both.
 */
import { parseFilename } from '../telescopeFiles.js';

/** Folders that are purely containers: SeeStar dumps all planetary images here
 *  regardless of which planet was imaged. They must never appear as library
 *  objects — always expand into individual per-planet objects. */
const CONTAINER_FOLDERS = new Set(['planetary_photo', 'planetary_photos']);

export function isContainerFolder(name: string): boolean {
  return CONTAINER_FOLDERS.has(name.toLowerCase());
}

/** The target a filename names, or null when it encodes none. parseFilename
 *  falls back to the whole filename when nothing matches, which is not a
 *  target; the `_thn` suffix is stripped so a thumbnail groups with the image
 *  it belongs to. */
export function targetFromFileName(name: string): string | null {
  const parsed = parseFilename(name);
  if (!parsed.target || parsed.target === name) return null;
  return parsed.target.replace(/_thn$/i, '');
}

export interface TargetGrouping {
  /** Target name to the files naming it, for files that name one. */
  byTarget: Map<string, string[]>;
  /** Files whose names encode no target. */
  unnamed: string[];
}

export function groupByTarget(fileNames: readonly string[]): TargetGrouping {
  const byTarget = new Map<string, string[]>();
  const unnamed: string[] = [];
  for (const name of fileNames) {
    const target = targetFromFileName(name);
    if (target === null) {
      unnamed.push(name);
      continue;
    }
    const group = byTarget.get(target) ?? [];
    group.push(name);
    byTarget.set(target, group);
  }
  return { byTarget, unnamed };
}

/** What a folder's top-level files say the folder actually contains. */
export type FolderPlan =
  /** One object holding everything in the folder. `folderName` may differ from
   *  the directory name when every file agrees on a different target. */
  | { kind: 'whole'; folderName: string }
  /** Several objects, each pinned to its own subset of the top-level files. */
  | {
      kind: 'split';
      groups: Array<{ folderName: string; fileNames: string[] }>;
      /** Files naming no target. Null when there are none, or when the folder is
       *  a container (where they are meaningless and get dropped). */
      leftover: { folderName: string; fileNames: string[] } | null;
    };

/**
 * Decide what objects a folder's top-level files represent.
 *
 * Only a folder holding genuinely different targets splits. A folder whose
 * files all name one target does not: it needs at most a *rename*, and stays
 * whole so its nested session folders and `_sub` companion come along. Splitting
 * such a folder is what dropped them before.
 *
 * Used by the folder-import wizard, where the user can point at any folder. The
 * SMB path deliberately does NOT apply this: a telescope already names each
 * folder for its target, so re-deriving names there would risk renaming objects
 * already in the library, and peeking inside every folder would cost a round
 * trip each. It uses `isContainerFolder` + `groupByTarget` directly instead.
 */
export function planObjectFolder(
  dirName: string,
  topLevelFileNames: readonly string[],
): FolderPlan {
  if (topLevelFileNames.length === 0) return { kind: 'whole', folderName: dirName };

  const isContainer = isContainerFolder(dirName);
  const { byTarget, unnamed } = groupByTarget(topLevelFileNames);

  if (isContainer || byTarget.size > 1) {
    return {
      kind: 'split',
      groups: Array.from(byTarget, ([folderName, fileNames]) => ({ folderName, fileNames })),
      // Unnamed files in a container are ignored (they name no planet, so there
      // is nothing to attribute them to); in a mixed folder they fall back to
      // the folder's own name so nothing is silently lost.
      leftover: !isContainer && unnamed.length > 0
        ? { folderName: dirName, fileNames: unnamed }
        : null,
    };
  }

  // Every file agrees on one target, so the whole folder is that object. This is
  // what lets a folder called "session1" full of M 27 frames land on M 27.
  if (byTarget.size === 1 && unnamed.length === 0) {
    return { kind: 'whole', folderName: [...byTarget.keys()][0] };
  }
  return { kind: 'whole', folderName: dirName };
}
