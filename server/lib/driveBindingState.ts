/**
 * Which mounted drive belongs to which USB transport right now.
 *
 * A telescope's USB connection is saved as a folder path, but a path is not an identity: with two telescopes plugged
 * in, the OS hands out `/Volumes/SEESTAR` and `/Volumes/SEESTAR 1` (or drive letters) in plug-in order. The scan in
 * `driveBindings.ts` reads each drive's `.nebulis.dat` and records the answer here, so the synchronous
 * `selectActiveTransport` can use it without doing any I/O. Kept apart from the scan so `telescopeTransports.ts` can
 * read it without an import cycle (the scan needs the profiles, which need the transports).
 */

/** A drive at a transport's saved path that belongs to a different telescope. */
export interface DriveBlock {
  transportId: string;
  profileId: string;
  /** The saved path the wrong drive is sitting at. */
  path: string;
  /** The ID found on that drive. */
  foundDeviceId: string;
  /** The telescope that owns it, when Nebulis knows one. */
  ownerName: string | null;
}

let remapped = new Map<string, string>();
let blocked = new Map<string, DriveBlock>();

export function setDriveBindings(next: { remapped: Map<string, string>; blocked: Map<string, DriveBlock> }): void {
  remapped = next.remapped;
  blocked = next.blocked;
}

/** Where this telescope's own drive currently is, when that differs from the saved path. */
export function remappedPathFor(transportId: string): string | null {
  return remapped.get(transportId) ?? null;
}

/** Set when the drive at the saved path belongs to another telescope. */
export function driveBlockFor(transportId: string): DriveBlock | null {
  return blocked.get(transportId) ?? null;
}

export function driveBlocksForProfile(profileId: string): DriveBlock[] {
  return [...blocked.values()].filter(b => b.profileId === profileId);
}

/** For tests. */
export function resetDriveBindings(): void {
  remapped = new Map();
  blocked = new Map();
}
