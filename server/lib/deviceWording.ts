/**
 * What to call the thing on the other end of a connection, and what to tell the
 * user when it doesn't answer.
 *
 * Every connection error used to be phrased for a telescope: "Telescope at
 * 10.0.1.5 is not reachable", "check that it is powered on and connected to the
 * same Wi-Fi". That reads as nonsense for the `other` kind, which is a plain
 * SMB share on a NAS or a PC. It is not a telescope, it has no Wi-Fi to be on,
 * and telling someone to power-cycle their NAS to fix a typo in an IP address
 * sends them looking in the wrong place entirely.
 *
 * One place decides the wording so the reachability preflight, the import error
 * rewriter, and anything added later all describe the same device the same way.
 */
import type { TelescopeKind } from './types/telescopeKind.js';

/** True when the profile is a generic SMB share rather than a real telescope. */
export function isGenericShare(kind: TelescopeKind | null | undefined): boolean {
  return kind === 'other';
}

/** Noun for this device, for use mid-sentence ("The server at ..."). */
export function deviceNoun(kind: TelescopeKind | null | undefined): string {
  return isGenericShare(kind) ? 'server' : 'telescope';
}

/**
 * What to check when the device doesn't answer. A telescope is a battery
 * powered thing on Wi-Fi; a NAS is a box with a fixed address and a sharing
 * setting, so they fail for different reasons and deserve different advice.
 */
export function offlineAdvice(kind: TelescopeKind | null | undefined): string {
  return isGenericShare(kind)
    ? 'Check the address is right and that the server is on and sharing over SMB.'
    : 'Check that it is powered on and connected to the same network.';
}
