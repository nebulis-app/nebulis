/**
 * LAN address detection shared by UDP discovery and QR enrollment.
 *
 * Prefers 192.168/10.x addresses; Docker bridge addresses (172.16-31.x) are a
 * last resort because they're rarely reachable from other devices on the LAN.
 */
import os from 'os';

export function getLanIP(): string | null {
  const allPrivate: Array<{ ip: string; priority: number }> = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const [a, b] = addr.address.split('.').map(Number);
      if (a === 192 && b === 168) allPrivate.push({ ip: addr.address, priority: 0 });
      else if (a === 10) allPrivate.push({ ip: addr.address, priority: 1 });
      else if (a === 172 && b >= 16 && b <= 31) allPrivate.push({ ip: addr.address, priority: 2 });
    }
  }
  allPrivate.sort((a, b) => a.priority - b.priority);
  return allPrivate[0]?.ip ?? null;
}

/** True for hostnames that only resolve on the server box itself. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}
