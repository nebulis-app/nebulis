/**
 * "Is this disk ready to be used as the archive?"
 *
 * Three modules need the same answer for read-and-write operations: browsing,
 * restoring, and (in their own words) the retention and local-removal steps. The
 * shape of the check is identical every time — a destination must be configured, it
 * must resolve to a usable root, and its marker must identify it as *this*
 * install's archive rather than someone else's — so it lives in one place rather
 * than being restated wherever it is needed.
 *
 * The marker check is the load-bearing part. A path can be configured and a disk
 * can be present while still not being our archive: the user may have plugged in a
 * different drive, or brought one back from another machine. Every operation that
 * could write to or delete from the destination asks this first.
 *
 * **A network destination adds a step, which is why this is asynchronous.** On macOS
 * the resolved root lives under `DATA_DIR` and that directory exists whether or not
 * a share is mounted on it, so the marker check alone would report an empty folder
 * as an unadopted archive: adopting it would put a marker in a local folder and the
 * next run would copy the library onto the app's own disk. `connectArchiveDestination`
 * is the step that establishes the share is really mounted, and
 * `ensureArchiveDestinationReady` is the strict form every write and delete path
 * uses.
 */

import path from 'path';

import { findOverlappingLinkedSource, resolveArchiveRoot } from './archivePath.js';
import { resolveNetworkArchiveRoot } from './archiveNetwork.js';
import { ensureArchiveShareReady } from './archiveNetwork.js';
import { readArchiveMarker } from './archiveMarker.js';
import {
  getArchiveNetworkCredentials,
  type ArchiveConfig,
  type ArchiveNetworkCredentials,
} from './archiveConfig.js';

/** Which kind of destination a config describes, for the route layer to report and
 *  for the UI to label. */
export type ArchiveDestinationKind = 'local' | 'network' | 'unconfigured';

/**
 * A refusal carries both a sentence and the code behind it. The sentence is what the
 * UI shows; the code lets the route layer answer with the specific reason rather than
 * one message for every way a destination can be wrong, without restating the wording
 * in two places.
 */
export type ArchiveDestinationResolution =
  | { ok: true; kind: 'local' | 'network'; root: string }
  | { ok: false; kind: ArchiveDestinationKind; warning: string; reason?: string };

export type ArchiveDestinationReadiness =
  | { ok: true; kind: 'local' | 'network'; root: string }
  | { ok: false; kind: ArchiveDestinationKind; warning: string; reason?: string };

/** Said once, because three paths report it and the wording is what the user acts
 *  on: plug the disk in, or check the share. */
export const DESTINATION_NOT_CONNECTED = 'The archive share is not connected.';
export const DESTINATION_NOT_OURS = 'That archive is not this install\u2019s archive.';

/**
 * What to say about each way a destination can be refused.
 *
 * One map for both kinds, keyed by the codes the two resolvers return, so the wording
 * lives with the code that decides it and the route layer never has to restate it.
 * Exported for exactly that reason.
 */
export const DESTINATION_REJECTION_MESSAGE: Record<string, string> = {
  // archivePath.ts, for a local destination
  empty: 'A destination path is required.',
  'not-absolute': 'The destination must be an absolute path.',
  'overlaps-library': 'The destination cannot be the library folder, contain it, or sit inside it.',
  'overlaps-data-dir': 'The destination cannot be the data folder, contain it, or sit inside it.',
  'overlaps-linked-source': 'The destination cannot be a linked folder, contain one, or sit inside one.',
  // archiveNetwork.ts, for a share
  incomplete: 'That network destination needs a server and a share.',
  'invalid-subpath': 'The folder inside the share is not a usable path.',
  'escapes-mount': 'The folder inside the share resolves outside the share.',
};

/**
 * The directory a configured destination resolves to, whichever kind it is.
 *
 * Deliberately a dispatcher rather than one function that inspects the string it is
 * given: the two kinds are contained by different rules, and which rule applies has
 * to come from the configuration rather than from the shape of a path. The local
 * branch is `resolveArchiveRoot` unchanged, including the rule that refuses a
 * destination overlapping the library or `DATA_DIR`; the network branch cannot use
 * that rule, because its root is inside `DATA_DIR` by construction.
 *
 * Synchronous and side-effect free apart from `realpath` lookups. Whether a network
 * destination is currently *connected* is a separate question, answered by
 * `connectArchiveDestination`.
 */
export function resolveArchiveDestination(config: ArchiveConfig): ArchiveDestinationResolution {
  if (config.locationType === 'network') {
    const resolved = resolveNetworkArchiveRoot(config.network);
    if (!resolved.ok) {
      return {
        ok: false,
        kind: 'network',
        reason: resolved.reason,
        warning: DESTINATION_REJECTION_MESSAGE[resolved.reason] ?? 'That network destination cannot be used.',
      };
    }
    // Re-checked on every resolution, because a folder can be linked after the share
    // was saved. Only a mounted share has a local path to compare; a UNC path is a
    // display string here and never overlaps a folder on this machine's disks.
    if (path.isAbsolute(resolved.root) && findOverlappingLinkedSource(resolved.root) !== null) {
      return {
        ok: false,
        kind: 'network',
        reason: 'overlaps-linked-source',
        warning: DESTINATION_REJECTION_MESSAGE['overlaps-linked-source'],
      };
    }
    return { ok: true, kind: 'network', root: resolved.root };
  }

  if (config.path === '') {
    return { ok: false, kind: 'unconfigured', warning: 'No archive destination is configured.' };
  }

  const resolved = resolveArchiveRoot(config.path);
  if (!resolved.ok) {
    return {
      ok: false,
      kind: 'local',
      reason: resolved.reason,
      warning: DESTINATION_REJECTION_MESSAGE[resolved.reason] ?? 'The configured archive destination cannot be used.',
    };
  }
  return { ok: true, kind: 'local', root: resolved.root };
}

/**
 * The resolution, with a network share connected first.
 *
 * The connecting form of `resolveArchiveDestination`, for the callers that need to see
 * a destination's *state* rather than demand it be ours: adopting a disk, reporting
 * what the settings page should show, and browsing the folders on a share the user has
 * typed but not yet saved.
 *
 * `credentials` is how the last of those connects the share it was asked about. Left
 * out, it connects what is stored, which is right for every caller that is working
 * with the saved configuration. It is a parameter rather than an internal read so that
 * the path that is resolved and the connection that is made cannot describe two
 * different shares without the caller having said so.
 */
export async function connectArchiveDestination(
  config: ArchiveConfig,
  credentials?: ArchiveNetworkCredentials,
): Promise<ArchiveDestinationResolution> {
  const resolved = resolveArchiveDestination(config);
  if (!resolved.ok || resolved.kind === 'local') return resolved;

  const ready = await ensureArchiveShareReady(credentials ?? getArchiveNetworkCredentials());
  if (!ready) return { ok: false, kind: 'network', warning: DESTINATION_NOT_CONNECTED };
  return resolved;
}

/**
 * The directory to use, having established that it is ours.
 *
 * The strict form: configured, resolvable, connected where that applies, and carrying
 * our marker. Every operation that writes to or deletes from the destination uses
 * this, so that "is it reachable" and "is it ours" cannot be answered by different
 * callers in different orders.
 */
export async function ensureArchiveDestinationReady(config: ArchiveConfig): Promise<ArchiveDestinationReadiness> {
  const connected = await connectArchiveDestination(config);
  if (!connected.ok) return connected;

  const marker = readArchiveMarker(connected.root, config.archiveId);
  if (marker.state !== 'match') {
    return { ok: false, kind: connected.kind, warning: DESTINATION_NOT_OURS };
  }

  return { ok: true, kind: connected.kind, root: connected.root };
}
