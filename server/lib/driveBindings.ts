/**
 * Tells USB drives apart by the device ID Nebulis wrote on them, not by where the OS mounted them.
 *
 * Two telescopes of one model look identical from the outside: the same `MyWorks/` folder, often the same volume name.
 * With both plugged in, the OS hands out `/Volumes/SEESTAR` and `/Volumes/SEESTAR 1` (or drive letters) in plug-in
 * order, so a telescope whose USB path was saved as a plain folder can end up importing the other one's files. The fix
 * is the `.nebulis.dat` file `deviceIdentity.ts` already writes on a telescope's storage:
 *
 *   - `refreshDriveBindings` reads the ID on every mounted telescope drive and records, per USB transport, where that
 *     telescope's own drive is now, or that a different telescope's drive is sitting at the saved path.
 *     `selectActiveTransport` follows or skips accordingly.
 *   - `prepareActiveTransport` is what an import calls: it refreshes, selects, and refuses with a plain-language
 *     message instead of importing from the wrong drive.
 *   - `bindProfileToDrive` runs when a person picks a drive for a telescope: it marks the drive (writing the
 *     telescope's ID on it) so every later plug-in is recognised.
 *
 * A drive Nebulis cannot read an ID from (never marked, or read-only) is trusted at its saved path, as it always was.
 * Opting out of identity tracking on a telescope (`trackDeviceIdentity`) opts out of all of this.
 */
import fs from 'fs';
import path from 'path';
import { detectDrives, readDeviceIdNear, type DetectedDrive } from './driveEnumeration.js';
import { identityRootOf, readIdentity, writeIdentityIfMissing } from './deviceIdentity.js';
import { setDriveBindings, driveBlocksForProfile, type DriveBlock } from './driveBindingState.js';
import {
  getTransportsForProfile, selectActiveTransport, invalidateActiveTransportCache, type TelescopeTransport,
} from './telescopeTransports.js';
import {
  getAllProfiles, getProfileByDeviceId, setProfileDeviceId, type TelescopeProfile,
} from './telescopes.js';

/** Re-scan no more often than this unless asked to: listing drives can mean a PowerShell call on Windows. */
const MIN_SCAN_GAP_MS = 5_000;

let lastScanAt = 0;
let inFlight: Promise<void> | null = null;

function drivePathOf(d: DetectedDrive): string {
  return d.asiairSubPath ? path.join(d.mountPath, d.asiairSubPath) : d.mountPath;
}

function sameDirectory(a: string, b: string): boolean {
  const norm = (p: string) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

async function scan(): Promise<void> {
  const tracked = getAllProfiles().filter(p => p.trackDeviceIdentity);
  const withLocal = tracked
    .map(p => ({ profile: p, transports: getTransportsForProfile(p.id).filter(t => t.kind === 'local' && !t.decryptFailed) }))
    .filter(x => x.transports.length > 0);

  const remapped = new Map<string, string>();
  const blocked = new Map<string, DriveBlock>();
  if (withLocal.length > 0) {
    const drives = await detectDrives();
    for (const { profile, transports } of withLocal) {
      for (const t of transports) {
        const here = t.localPath ? await readDeviceIdNear(t.localPath) : null;
        const mine = profile.deviceId;

        if (!mine) {
          // Not paired yet. Only a drive that plainly belongs to another telescope is a problem.
          const owner = here ? getProfileByDeviceId(here) : null;
          if (here && owner && owner.id !== profile.id) {
            blocked.set(t.id, { transportId: t.id, profileId: profile.id, path: t.localPath, foundDeviceId: here, ownerName: owner.name });
          }
          continue;
        }
        if (here === mine) continue; // The right drive is where it was saved.

        const own = drives.find(d => d.alreadyKnownDeviceId === mine);
        if (own) {
          const now = drivePathOf(own);
          if (!sameDirectory(now, t.localPath)) remapped.set(t.id, now);
          continue;
        }
        // The telescope's own drive is not plugged in. Whatever is at the saved path is somebody else's.
        if (here) {
          blocked.set(t.id, {
            transportId: t.id, profileId: profile.id, path: t.localPath, foundDeviceId: here,
            ownerName: getProfileByDeviceId(here)?.name ?? null,
          });
        }
      }
    }
  }

  // Which USB paths have a drive at them right now. Plugging one in or pulling one out changes neither map above, but it changes
  // which transport an import should use.
  const present = withLocal
    .flatMap(x => x.transports)
    .filter(t => { const p = remapped.get(t.id) ?? t.localPath; return !!p && fs.existsSync(p); })
    .map(t => t.id)
    .sort()
    .join(',');
  const drivesChanged = present !== currentPresent;
  currentPresent = present;

  const changed = JSON.stringify([...remapped]) !== JSON.stringify([...currentRemapped])
    || JSON.stringify([...blocked.keys()]) !== JSON.stringify([...currentBlocked]);
  currentRemapped = remapped;
  currentBlocked = new Set(blocked.keys());
  setDriveBindings({ remapped, blocked });
  // `selectActiveTransport` caches its answer for 30 s; a drive that moved, a wrong one that arrived, or one plugged in or out must not wait.
  if (changed || drivesChanged) invalidateActiveTransportCache();
}

let currentRemapped = new Map<string, string>();
let currentBlocked = new Set<string>();
let currentPresent = '';

/** Re-read which drive is where. Safe to call often; concurrent calls share one scan. */
export async function refreshDriveBindings(opts: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return inFlight;
  if (!opts.force && Date.now() - lastScanAt < MIN_SCAN_GAP_MS) return;
  inFlight = scan()
    .catch(err => {
      console.warn('[driveBindings] drive scan failed:', err instanceof Error ? err.message : err);
    })
    .finally(() => {
      lastScanAt = Date.now();
      inFlight = null;
    });
  return inFlight;
}

function blockMessage(profile: TelescopeProfile, b: DriveBlock): string {
  return b.ownerName
    ? `The USB drive at ${b.path} belongs to ${b.ownerName}, not ${profile.name}. Plug in ${profile.name}'s own drive, or unplug the other one.`
    : `The USB drive at ${b.path} is not the one Nebulis paired with ${profile.name}. Plug in ${profile.name}'s own drive, or unplug the other one.`;
}

/**
 * Settle which transport an import should use, or say why none can be used. Replaces a bare `selectActiveTransport`
 * in the import paths: it scans first (so a drive that moved is followed), and it refuses to import from a USB drive
 * that belongs to a different telescope.
 */
export async function prepareActiveTransport(
  profile: TelescopeProfile,
): Promise<{ transport: TelescopeTransport | null; error: string | null }> {
  if (profile.trackDeviceIdentity) {
    await refreshDriveBindings({ force: true });
  }
  const transport = selectActiveTransport(profile.id);

  if (transport?.kind === 'local' && profile.trackDeviceIdentity) {
    // The scan is a few seconds old at most, but this is the last look before files are copied.
    const check = await checkDriveMatchesProfile(profile, transport.localPath);
    if (!check.ok) return { transport: null, error: check.message };
  }
  if (!transport) {
    const block = driveBlocksForProfile(profile.id)[0];
    if (block) return { transport: null, error: blockMessage(profile, block) };
  }
  return { transport, error: null };
}

/** True when nothing at `localPath` says it is a different telescope's drive. A drive with no readable ID passes. */
export async function checkDriveMatchesProfile(
  profile: TelescopeProfile,
  localPath: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const here = localPath ? await readDeviceIdNear(localPath) : null;
  if (!here) return { ok: true };
  const owner = getProfileByDeviceId(here);
  if (profile.deviceId) {
    if (here === profile.deviceId) return { ok: true };
  } else if (!owner || owner.id === profile.id) {
    return { ok: true };
  }
  return { ok: false, message: blockMessage(profile, { transportId: '', profileId: profile.id, path: localPath, foundDeviceId: here, ownerName: owner?.name ?? null }) };
}

// ─── Storage reached over the network ───────────────────────────────────────

export type StorageIdentityVerdict =
  /** Nothing to learn or act on: no ID on the storage, or it is this telescope's. */
  | { action: 'keep' }
  /** The telescope has no ID yet and the storage carries one nobody else owns. */
  | { action: 'adopt'; deviceId: string }
  /** The storage is not obviously this telescope's. The import still runs (see below); this is what to tell the owner. */
  | { action: 'warn'; reason: 'other-telescope' | 'different-id'; found: string; ownerName: string | null };

/**
 * What the ID on a share or FTP server says about the telescope being imported from it. `storageId` is the ID actually on the
 * storage (null when there is none, or it could not be written and read back).
 *
 * This is the warn-only half of checking network storage the way `checkDriveMatchesProfile` checks a USB drive: a camera that picks
 * up another camera's address would otherwise be imported under the wrong telescope. It does not refuse yet, because a telescope first
 * paired over USB may already carry a different ID on its share (the import used to write a fresh one instead of handing over the
 * telescope's own), and those must not be locked out on the day this ships.
 */
export function judgeStorageIdentity(profile: TelescopeProfile, storageId: string | null): StorageIdentityVerdict {
  if (!storageId || storageId === profile.deviceId) return { action: 'keep' };
  const owner = getProfileByDeviceId(storageId);
  if (owner && owner.id !== profile.id) return { action: 'warn', reason: 'other-telescope', found: storageId, ownerName: owner.name };
  if (profile.deviceId) return { action: 'warn', reason: 'different-id', found: storageId, ownerName: null };
  return { action: 'adopt', deviceId: storageId };
}

// ─── Pairing a drive with a telescope ───────────────────────────────────────

export type BindResult =
  /** The drive carries this telescope's ID. `wrote` is true when this call put it there. */
  | { status: 'paired'; deviceId: string; wrote: boolean }
  /** The drive could not be marked, so it stays recognised by its path alone, as before. */
  | { status: 'unmarked'; reason: 'read-only' | 'tracking-off' | 'missing' }
  /** The drive belongs to someone else, or this telescope is already paired with another drive. */
  | { status: 'conflict'; reason: 'other-telescope' | 'different-drive' | 'telescope-paired-elsewhere'; ownerName: string | null; otherPath: string | null };

function localProbe(profileId: string, localPath: string): TelescopeTransport {
  return {
    id: 'bind-probe', profileId, kind: 'local', priority: 50, hostname: '', shareName: '', username: '', password: '',
    localPath, lastSeenAt: null, createdAt: new Date().toISOString(),
  };
}

/**
 * Pair the telescope with the drive at `localPath`. Called when someone picks a USB drive for a telescope: the drive
 * gets the telescope's ID (or the telescope takes the drive's, if it has none yet), and from then on the two are
 * recognised wherever the drive mounts.
 *
 * Never silently re-pairs: a drive that already belongs to another telescope, or a telescope already paired with a
 * different drive, comes back as a conflict. `replace` is the person saying they have swapped the drive.
 */
export async function bindProfileToDrive(
  profile: TelescopeProfile,
  localPath: string,
  opts: { replace?: boolean } = {},
): Promise<BindResult> {
  if (!profile.trackDeviceIdentity) return { status: 'unmarked', reason: 'tracking-off' };
  if (!localPath || !fs.existsSync(localPath)) return { status: 'unmarked', reason: 'missing' };

  const probe = localProbe(profile.id, localPath);
  const existing = await readIdentity(probe);

  if (existing) {
    const owner = getProfileByDeviceId(existing.deviceId);
    if (owner && owner.id !== profile.id) {
      return { status: 'conflict', reason: 'other-telescope', ownerName: owner.name, otherPath: null };
    }
    if (owner) return { status: 'paired', deviceId: existing.deviceId, wrote: false };
    if (profile.deviceId && profile.deviceId !== existing.deviceId && !opts.replace) {
      return { status: 'conflict', reason: 'different-drive', ownerName: null, otherPath: null };
    }
    setProfileDeviceId(profile.id, existing.deviceId);
    return { status: 'paired', deviceId: existing.deviceId, wrote: false };
  }

  // Nothing on the drive yet. If this telescope's ID is already on another plugged-in drive, writing it here too would
  // leave two drives claiming to be one telescope, which is the confusion this exists to remove.
  let deviceId = profile.deviceId ?? undefined;
  if (deviceId) {
    const drives = await detectDrives();
    // Compared by volume: a path inside `ASIAir/` and the volume around it are the same drive.
    const elsewhere = drives.find(d => d.alreadyKnownDeviceId === deviceId
      && !sameDirectory(identityRootOf(drivePathOf(d)), identityRootOf(localPath)));
    if (elsewhere) {
      if (!opts.replace) {
        return { status: 'conflict', reason: 'telescope-paired-elsewhere', ownerName: profile.name, otherPath: drivePathOf(elsewhere) };
      }
      deviceId = undefined; // Replacing: the new drive gets a fresh ID, and the telescope takes it below.
    }
  }

  const written = await writeIdentityIfMissing(probe, { model: profile.model, deviceId });
  if (written.readonly) return { status: 'unmarked', reason: 'read-only' };
  setProfileDeviceId(profile.id, written.identity.deviceId);
  invalidateActiveTransportCache(profile.id);
  return { status: 'paired', deviceId: written.identity.deviceId, wrote: written.wrote };
}

/**
 * Whether a drive can be given to a telescope that does not exist yet. Only a drive that already carries another
 * telescope's ID is refused; an unmarked or unreadable drive passes, as it always did. Read-only: nothing is written.
 */
export async function checkDriveForNewProfile(
  localPath: string,
): Promise<Extract<BindResult, { status: 'conflict' }> | null> {
  if (!localPath || !fs.existsSync(localPath)) return null;
  const existing = await readIdentity(localProbe('new-profile', localPath));
  if (!existing) return null;
  const owner = getProfileByDeviceId(existing.deviceId);
  return owner ? { status: 'conflict', reason: 'other-telescope', ownerName: owner.name, otherPath: null } : null;
}

/** For tests: forget the scan throttle and what it found. */
export function resetDriveBindingScan(): void {
  lastScanAt = 0;
  inFlight = null;
  currentRemapped = new Map();
  currentBlocked = new Set();
  currentPresent = '';
  setDriveBindings({ remapped: new Map(), blocked: new Map() });
}
