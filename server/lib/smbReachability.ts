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

export const SMB_PORT = 445;

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
export function tcpProbe(host: string, port = SMB_PORT, timeoutMs = 2000): Promise<number | null> {
  return new Promise(resolve => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => { socket.destroy(); resolve(Date.now() - start); });
    socket.on('error',   () => { socket.destroy(); resolve(null); });
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
    socket.connect(port, host);
  });
}

/**
 * Throw a clean, client-safe error if `host` isn't reachable on the SMB port,
 * so callers fail fast instead of hanging in a native mount command. Caches the
 * probe result briefly to avoid re-probing on every file in a tight loop.
 */
export async function ensureSmbReachable(host: string, timeoutMs = 2000): Promise<void> {
  const now = Date.now();
  const cached = cache.get(host);
  if (cached) {
    const ttl = cached.reachable ? REACHABLE_TTL_MS : UNREACHABLE_TTL_MS;
    if (now - cached.checkedAt < ttl) {
      if (cached.reachable) return;
      throw new Error(`Telescope at ${host} is not reachable on the network`);
    }
  }
  const latency = await tcpProbe(host, SMB_PORT, timeoutMs);
  cache.set(host, { reachable: latency !== null, checkedAt: now });
  if (latency === null) {
    throw new Error(`Telescope at ${host} is not reachable on the network`);
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
