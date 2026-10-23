import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import os from 'os';

// scanForDevices end to end, with every socket mocked: TCP probes, the anonymous
// FTP listing, reverse DNS, and the UDP scan_iscope broadcast. A /29 LAN gives
// six hosts, each wired to one classification branch.

const S = vi.hoisted(() => ({
  open: new Map<string, number[]>(),           // host -> open TCP ports
  ftpRoots: new Map<string, string[] | Error>(), // host -> FTP root listing
  rdns: new Map<string, string>(),
  udpAnswers: [] as string[],
  probeCalls: 0,
}));

vi.mock('../../server/lib/smbReachability.js', () => ({
  SMB_PORT: 445,
  tcpProbe: async (host: string, port: number) => {
    S.probeCalls++;
    return S.open.get(host)?.includes(port) ? 5 : null;
  },
}));
vi.mock('../../server/lib/smb.ftp.js', () => ({ FTP_PORT: 21 }));
vi.mock('../../server/lib/logger.js', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('basic-ftp', () => ({
  Client: class {
    private host = '';
    async access(opts: { host: string }) {
      this.host = opts.host;
      const r = S.ftpRoots.get(opts.host);
      if (!r || r instanceof Error) throw r ?? new Error('530 Login incorrect');
    }
    async list() {
      return (S.ftpRoots.get(this.host) as string[]).map(name => ({ name }));
    }
    close() {}
  },
}));
vi.mock('dns/promises', () => ({
  default: {
    reverse: async (ip: string) => {
      const n = S.rdns.get(ip);
      if (!n) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return [n];
    },
  },
}));
vi.mock('dgram', () => ({
  default: {
    createSocket: () => {
      const sock = Object.assign(new EventEmitter(), {
        bind: (_port: number, cb: () => void) => { cb(); },
        setBroadcast: () => {},
        send: () => {
          for (const address of S.udpAnswers) queueMicrotask(() => sock.emit('message', Buffer.from('{}'), { address }));
          // Close the listen window immediately once answers are delivered.
          setTimeout(() => sock.emit('error', new Error('done')), 0);
        },
        close: () => {},
      });
      return sock;
    },
  },
}));

import { scanForDevices } from '../../server/lib/deviceScan';

const LAN = '192.168.50';

beforeEach(() => {
  S.open.clear();
  S.ftpRoots.clear();
  S.rdns.clear();
  S.udpAnswers = [];
  S.probeCalls = 0;
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    en0: [{ address: `${LAN}.10`, netmask: '255.255.255.248', family: 'IPv4', internal: false, mac: '', cidr: null }],
    utun3: [{ address: '10.8.0.2', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null }],
  } as ReturnType<typeof os.networkInterfaces>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scanForDevices', () => {
  it('classifies Dwarf, ASIAIR and SeeStar hosts and ignores a plain NAS', async () => {
    S.open.set(`${LAN}.9`, [21]);            S.ftpRoots.set(`${LAN}.9`, ['Astronomy', 'DCIM']);
    S.open.set(`${LAN}.10`, [21]);           S.ftpRoots.set(`${LAN}.10`, ['DWARF_MINI']);
    S.open.set(`${LAN}.11`, [445]);          S.rdns.set(`${LAN}.11`, 'asiair-plus.lan');
    S.open.set(`${LAN}.12`, [445, 4700]);
    S.open.set(`${LAN}.13`, [445]);          S.udpAnswers = [`${LAN}.13`];
    S.open.set(`${LAN}.14`, [21, 445]);      S.ftpRoots.set(`${LAN}.14`, new Error('530')); S.rdns.set(`${LAN}.14`, 'synology.lan');

    const result = await scanForDevices();

    expect(result.subnets).toEqual([`${LAN}.8/29`]);
    expect(result.devices.map(d => [d.host, d.kind, d.protocol])).toEqual([
      [`${LAN}.9`, 'dwarf-3', 'ftp'],
      [`${LAN}.10`, 'dwarf-mini', 'ftp'],
      [`${LAN}.11`, 'asiair', 'smb'],
      [`${LAN}.12`, 'seestar-s50', 'smb'],
      [`${LAN}.13`, 'seestar-s50', 'smb'],
    ]);
  });

  it('recognises a SeeStar by reverse-DNS name alone and records the name', async () => {
    S.open.set(`${LAN}.12`, [445]);
    S.rdns.set(`${LAN}.12`, 'seestar-s30.local');

    const { devices } = await scanForDevices();

    expect(devices).toEqual([
      { host: `${LAN}.12`, kind: 'seestar-s50', label: 'ZWO SeeStar', protocol: 'smb', name: 'seestar-s30.local' },
    ]);
  });

  it('identifies a Dwarf II by its DWARF_II root folder (case-insensitive)', async () => {
    S.open.set(`${LAN}.9`, [21]);
    S.ftpRoots.set(`${LAN}.9`, ['Dwarf_II']);

    const { devices } = await scanForDevices();

    expect(devices.map(d => d.kind)).toEqual(['dwarf-2']);
  });

  it('does not report an FTP server with no Dwarf storage root', async () => {
    S.open.set(`${LAN}.9`, [21]);
    S.ftpRoots.set(`${LAN}.9`, ['pub', 'incoming']);

    expect((await scanForDevices()).devices).toEqual([]);
  });

  it('sweeps only the LAN interface (6 hosts x 3 ports), never the VPN', async () => {
    await scanForDevices();
    expect(S.probeCalls).toBe(18);
  });

  it('joins an in-flight scan instead of starting a second one', async () => {
    const a = scanForDevices();
    const b = scanForDevices();

    expect(b).toBe(a);
    await a;
    expect(S.probeCalls).toBe(18);
  });
});
