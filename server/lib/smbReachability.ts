/**
 * Network reachability preflight for SMB I/O.
 *
 * Before shelling out to a slow native client (mount_smbfs / smbclient / net use),
 * we do a cheap TCP connect to the SMB port. Against an unreachable host the
 * mount command stalls (or burns its multi-second timeout) on every call; a TCP
 * connect to a dead host fails in milliseconds. We use TCP, not ICMP ping:
 *   - ICMP needs raw sockets (privileged) or shelling to `ping` with OS-specific
 *     output parsing.
 *   - A host can answer ping while SMB itself is down (false positive).
 *   - Port 445 is exactly the service we're about to use.
 *
 * Results are cached briefly so a burst of file operations (e.g. a 500-file
 * import) against an offline host doesn't pay one timeout per file.
 */
import net from 'net';
import dns from 'dns/promises';
import { deviceNoun, offlineAdvice } from './deviceWording.js';
import type { TelescopeKind } from './types/telescopeKind.js';

export const SMB_PORT = 445;

/**
 * Cloud instance metadata services (AWS/GCP/Azure/Oracle/DigitalOcean/Alibaba
 * all use the IPv4 link-local address; AWS IMDSv2 also answers on an IPv6
 * one) live at addresses no real telescope or NAS is ever reachable at. This
 * app is admin-gated, but "admin of this app" and "admin of the box it runs
 * on" are different people once it's deployed in a container on someone
 * else's cloud infrastructure — the scenario the "Test Connection" and
 * auto-import reachability checks would otherwise let an app-admin abuse to
 * read the host's cloud credentials. Blocking the metadata range costs
 * nothing for the real feature (telescopes and NAS boxes are always on a
 * private LAN or the device's own AP, never link-local).
 */
function isBlockedProbeTarget(ip: string): boolean {
  return ip.startsWith('169.254.') || ip.toLowerCase().startsWith('fd00:ec2:');
}

// Trust a probe result for this long before re-checking. Short enough that a
// host coming online (or going offline) is noticed within a few seconds, long
// enough that a tight loop of file operations probes the network ~once, not
// once per file.
const REACHABLE_TTL_MS = 5_000;
const UNREACHABLE_TTL_MS = 5_000;

interface ProbeResult {
  reachable: boolean;
  checkedAt: number;
}

const cache = new Map<string, ProbeResult>();

/**
 * TCP connect to `port` on `host`. Resolves with the round-trip latency in ms
 * on success, or null on connection error / timeout. No shell, no ICMP, no auth.
 */
export async function tcpProbe(host: string, port = SMB_PORT, timeoutMs = 2000): Promise<number | null> {
  // Resolve once and validate the concrete address before connecting, rather
  // than letting net.Socket resolve `host` itself: that would let a hostname
  // reach a blocked address just as easily as a literal IP, and validating
  // then connecting to the same resolved address (instead of the original
  // hostname) closes the DNS-rebind gap a check-then-let-it-resolve-again
  // design would leave open.
  let target: string;
  try {
    target = net.isIP(host) ? host : (await dns.lookup(host)).address;
  } catch {
    return null; // unresolvable host is unreachable, same as a dead one
  }
  if (isBlockedProbeTarget(target)) return null;

  return new Promise(resolve => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => { socket.destroy(); resolve(Date.now() - start); });
    socket.on('error',   () => { socket.destroy(); resolve(null); });
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
    socket.connect(port, target);
  });
}

/**
 * The message a failed preflight surfaces to the user.
 *
 * Named after what the profile actually connects to. A custom SMB share (the
 * `other` kind) is a NAS or a PC, so calling it a telescope, as this did for
 * every kind, left users of that option reading an error about hardware they
 * do not have while their real problem was a typo in the address.
 */
export function unreachableMessage(host: string, kind?: TelescopeKind | null): string {
  return `The ${deviceNoun(kind)} at ${host} is not reachable on the network (port ${SMB_PORT}). `
    + offlineAdvice(kind);
}

/**
 * Throw a clean, client-safe error if `host` isn't reachable on the SMB port,
 * so callers fail fast instead of hanging in a native mount command. Caches the
 * probe result briefly to avoid re-probing on every file in a tight loop.
 *
 * `kind` only shapes the wording of the thrown message; the probe and its cache
 * are per host, since reachability is a property of the address alone.
 */
export async function ensureSmbReachable(
  host: string,
  timeoutMs = 2000,
  kind?: TelescopeKind | null,
): Promise<void> {
  const now = Date.now();
  const cached = cache.get(host);
  if (cached) {
    const ttl = cached.reachable ? REACHABLE_TTL_MS : UNREACHABLE_TTL_MS;
    if (now - cached.checkedAt < ttl) {
      if (cached.reachable) return;
      throw new Error(unreachableMessage(host, kind));
    }
  }
  const latency = await tcpProbe(host, SMB_PORT, timeoutMs);
  cache.set(host, { reachable: latency !== null, checkedAt: now });
  if (latency === null) {
    throw new Error(unreachableMessage(host, kind));
  }
}

/** Drop any cached result for a host (e.g. after the user edits its address). */
export function invalidateSmbReachability(host?: string): void {
  if (host) {
    cache.delete(host);
    opHealth.delete(host);
  } else {
    cache.clear();
    opHealth.clear();
  }
}

// ─── Real-operation health ───────────────────────────────────────────────────
// tcpProbe only proves the host answers on port 445. It says nothing about
// whether SMB auth succeeds or the share is actually readable — a host can be
// TCP-reachable while `smbclient` fails to negotiate, authenticate, or open the
// share (exactly the "icon says connected but import fails" case). We passively
// record the outcome of every real SMB operation (populated by smb.ts, no extra
// network traffic) so the status pill can fold it in.

export interface SmbOpHealth {
  /** True if the last recorded real SMB op against this host succeeded. */
  ok: boolean;
  checkedAt: number;
  /** Failure reason, when ok is false. */
  error?: string;
}

const opHealth = new Map<string, SmbOpHealth>();

/** Record the outcome of a real SMB operation (auth + share access) for `host`.
 *  Called by the SMB dispatcher on every network op — success proves the share
 *  is usable; a failure means it isn't, regardless of what TCP-445 reports. */
export function recordSmbOpResult(host: string | undefined, ok: boolean, error?: string): void {
  if (!host) return;
  opHealth.set(host, { ok, checkedAt: Date.now(), error: ok ? undefined : error });
}

/** Last recorded real-op outcome for `host`, or undefined if none yet. */
export function getSmbOpHealth(host: string): SmbOpHealth | undefined {
  return opHealth.get(host);
}
