import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import zlib from 'zlib';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import express from 'express';
import { pixinsightRepoRouter } from '../../server/routes/pixinsightRepo';
import { updateSettingsData } from '../../server/lib/telescopes';
import {
  getPixInsightRepoArtifacts,
  readConnectorScript,
  extractScriptVersion,
  generateUpdatesXri,
  getAppVersion,
  resetRepoArtifactsCache,
  PACKAGE_SCRIPT_PATH,
} from '../../server/lib/pixinsightRepo';

// The repository is public and read-only, and an admin switch (Settings → Features) gates it.
// Mounts the real router the way index.ts does, under /plugins/pixinsight.
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use('/plugins/pixinsight', pixinsightRepoRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/plugins/pixinsight`;
});

afterAll(async () => {
  updateSettingsData({ pixinsightEnabled: false });
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  resetRepoArtifactsCache();
  updateSettingsData({ pixinsightEnabled: true });
});

describe('PixInsight repository: enable switch', () => {
  const paths = ['/', '/updates.xri', '/release.json', '/NebulisConnector.js', '/NebulisConnector.tar.gz', '/NebulisConnector.zip'];

  it.each(paths)('%s is 404 while the feature is off', async p => {
    updateSettingsData({ pixinsightEnabled: false });
    const res = await fetch(`${baseUrl}${p}`);
    expect(res.status).toBe(404);
  });

  it.each(paths)('%s is served while the feature is on', async p => {
    const res = await fetch(`${baseUrl}${p}`);
    expect(res.status).toBe(200);
  });

  it('is off by default for a fresh settings row', async () => {
    updateSettingsData({ pixinsightEnabled: undefined });
    const { getSettingsData } = await import('../../server/lib/telescopes');
    expect(getSettingsData().pixinsightEnabled).toBe(false);
  });
});

describe('PixInsight repository: artifacts', () => {
  it('pins the script version to the app version', () => {
    const script = readConnectorScript('9.9.9');
    expect(extractScriptVersion(script)).toBe('9.9.9');
    expect(extractScriptVersion(readConnectorScript())).toBe(getAppVersion());
  });

  it('manifest SHA-1 matches the tarball actually served', async () => {
    const xri = await (await fetch(`${baseUrl}/updates.xri`)).text();
    const tar = Buffer.from(await (await fetch(`${baseUrl}/NebulisConnector.tar.gz`)).arrayBuffer());
    const sha1 = crypto.createHash('sha1').update(tar).digest('hex');
    expect(xri).toContain(`sha1="${sha1}"`);
    expect(xri).toContain('fileName="NebulisConnector.tar.gz"');
    expect(xri).toContain(PACKAGE_SCRIPT_PATH);
  });

  it('tarball contains the version-pinned script at the PixInsight install path', async () => {
    const a = await getPixInsightRepoArtifacts();
    const raw = zlib.gunzipSync(a.tarGzBuffer).toString('latin1');
    expect(raw).toContain(PACKAGE_SCRIPT_PATH);
    expect(raw).toContain(`NEBULIS_VERSION = "${getAppVersion()}"`);
  });

  it('packages are byte-stable across rebuilds (so the SHA-1 only changes with the script)', async () => {
    const first = await getPixInsightRepoArtifacts();
    const second = await getPixInsightRepoArtifacts(true);
    expect(second.tarGzSha1).toBe(first.tarGzSha1);
    expect(second.zipSha1).toBe(first.zipSha1);
  });

  it('release.json lists matching checksums', async () => {
    const a = await getPixInsightRepoArtifacts();
    const body = await (await fetch(`${baseUrl}/release.json`)).json() as { version: string; packages: { tarGz: { sha1: string }; zip: { sha1: string } } };
    expect(body.version).toBe(a.version);
    expect(body.packages.tarGz.sha1).toBe(a.tarGzSha1);
    expect(body.packages.zip.sha1).toBe(a.zipSha1);
  });

  it('escapes the Host header in the setup page', async () => {
    const res = await new Promise<string>((resolve, reject) => {
      const port = new URL(baseUrl).port;
      const req = http.request(
        { host: '127.0.0.1', port, path: '/plugins/pixinsight/', headers: { Host: '"><script>alert(1)</script>' } },
        r => { let s = ''; r.on('data', d => { s += d; }); r.on('end', () => resolve(s)); },
      );
      req.on('error', reject);
      req.end();
    }).catch(() => '');
    // Node may refuse such a Host outright; either way the raw tag must never reach the page.
    expect(res).not.toContain('<script>alert(1)</script>');
  });

  it('escapes XML special characters in the manifest', () => {
    const xri = generateUpdatesXri({ tarGzSha1: 'a'.repeat(40), version: '1<2', releaseDate: '20261006', packageFileName: 'x"y.tar.gz' });
    expect(xri).toContain('v1&lt;2');
    expect(xri).toContain('fileName="x&quot;y.tar.gz"');
  });
});
