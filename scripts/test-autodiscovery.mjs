#!/usr/bin/env node
/**
 * Tests the Nebulis UDP autodiscovery responder (port 47890).
 *
 * Sends a discovery ping to localhost and optionally to the LAN broadcast
 * address to simulate what the iOS/tvOS client does. Prints each response
 * in full so you can verify the payload is correct.
 *
 * Usage:
 *   npm run test:autodiscovery
 *   npm run test:autodiscovery -- --broadcast       # also ping LAN broadcast
 *   npm run test:autodiscovery -- --host 192.168.1.5  # ping a specific host
 */

import dgram from 'node:dgram';
import os from 'node:os';

const DISCOVERY_PORT = 47890;
const TIMEOUT_MS = 5000;
const PING = Buffer.from(JSON.stringify({ service: 'nebulis' }));

const args = process.argv.slice(2);
const broadcastMode = args.includes('--broadcast');
const hostFlag = args.indexOf('--host');
const specificHost = hostFlag !== -1 ? args[hostFlag + 1] : null;

// ── helpers ──────────────────────────────────────────────────────────────────

function getLanBroadcast() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const addr of ifaces ?? []) {
      if (addr.family !== 'IPv4' || addr.internal || !addr.netmask) continue;
      const ip = addr.address.split('.').map(Number);
      const mask = addr.netmask.split('.').map(Number);
      const broadcast = ip.map((b, i) => (b | (~mask[i] & 0xff)) >>> 0).join('.');
      if (!broadcast.startsWith('169.254')) return broadcast; // skip link-local
    }
  }
  return null;
}

function sendPing(host, label) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const replies = [];

    const done = () => {
      sock.close();
      if (replies.length === 0) {
        resolve({ label, host, ok: false, replies, error: `No response in ${TIMEOUT_MS}ms — is the server running?` });
      } else {
        resolve({ label, host, ok: true, replies, error: null });
      }
    };

    const timer = setTimeout(done, TIMEOUT_MS);

    sock.on('error', (err) => {
      clearTimeout(timer);
      sock.close();
      resolve({ label, host, ok: false, replies, error: err.message });
    });

    sock.on('message', (msg, rinfo) => {
      const from = `${rinfo.address}:${rinfo.port}`;
      try {
        const response = JSON.parse(msg.toString());
        if (response?.service === 'nebulis') {
          replies.push({ from, response, receivedAt: Date.now() });
          process.stdout.write(`  + response from ${from}\n`);
        }
      } catch {
        process.stdout.write(`  ! malformed packet from ${from}: ${msg.toString()}\n`);
      }
    });

    if (host === '255.255.255.255' || host?.endsWith('.255')) {
      sock.bind(() => {
        sock.setBroadcast(true);
        sock.send(PING, DISCOVERY_PORT, host);
      });
    } else {
      sock.send(PING, DISCOVERY_PORT, host);
    }
  });
}

function check(label, condition, detail) {
  const icon = condition ? '✓' : '✗';
  console.log(`  ${icon}  ${label}${detail ? ` (${detail})` : ''}`);
  return condition;
}

// ── main ─────────────────────────────────────────────────────────────────────

const targets = [{ host: '127.0.0.1', label: 'localhost' }];

if (specificHost) {
  targets.push({ host: specificHost, label: specificHost });
} else if (broadcastMode) {
  const bc = getLanBroadcast();
  if (bc) targets.push({ host: bc, label: `LAN broadcast (${bc})` });
  else console.warn('Could not determine LAN broadcast address; skipping broadcast test.\n');
}

console.log(`\nNebulis autodiscovery test  (UDP port ${DISCOVERY_PORT})\n`);

let allPassed = true;
const allReplies = [];

for (const { host, label } of targets) {
  console.log(`Pinging ${label}, waiting ${TIMEOUT_MS / 1000}s for responses ...`);
  const result = await sendPing(host, label);

  if (result.error) {
    console.log(`  ✗  ${result.error}\n`);
    allPassed = false;
    continue;
  }

  console.log(`  ${result.replies.length} response(s) received:\n`);

  for (const { from, response: r } of result.replies) {
    console.log(`  From ${from}:`);
    console.log('  ' + JSON.stringify(r, null, 2).replaceAll('\n', '\n  '));
    console.log('');
    console.log('  Validation:');

    const pass = [
      check('service === "nebulis"',   r.service === 'nebulis'),
      check('port is a number',        typeof r.port === 'number',       String(r.port)),
      check('url is present',          typeof r.url === 'string',         r.url),
      check('url starts with http://', r.url?.startsWith('http://'),      r.url),
      check('version is present',      typeof r.version === 'string',     r.version),
      check('hostname is present',     typeof r.hostname === 'string' || r.hostname === undefined,
            r.hostname ?? '(omitted — Docker or unnamed host)'),
    ].every(Boolean);

    if (!pass) allPassed = false;
    allReplies.push({ from, response: r });
    console.log('');
  }
}

if (allReplies.length > 0) {
  console.log('─'.repeat(60));
  console.log(`Servers found (${allReplies.length}):\n`);
  for (const { from, response: r } of allReplies) {
    const ip = from.split(':')[0];
    const hostname = r.hostname ?? '(unnamed)';
    const url = r.url ?? '(no url)';
    const version = r.version ?? '(unknown)';
    console.log(`  ${ip}  ${hostname}  ${url}  v${version}`);
  }
  console.log('');
}

if (allPassed) {
  console.log('All checks passed.\n');
  process.exit(0);
} else {
  console.log('One or more checks failed.\n');
  process.exit(1);
}
