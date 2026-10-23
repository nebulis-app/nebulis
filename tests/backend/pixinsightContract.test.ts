import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _root = _path.join(process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-pixinsight-contract-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { LIBRARY_DIR } from '../../server/lib/paths';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';
import { metaRouter } from '../../server/routes/meta';
import { stmts } from '../../server/lib/library/objects';
import { getArchiveDir } from '../../server/lib/library/archiveFolders';

/**
 * The PixInsight connector (server/assets/pixinsight/NebulisConnector.js) is written in PJSR and
 * cannot run in CI, so this file is what keeps it honest. It does two things:
 *
 *   1. Pins the exact list of server endpoints the script calls. Add a call to the script and this
 *      fails until the endpoint is listed (and covered) here.
 *   2. Calls each of those endpoints on the real router and checks every response field the script
 *      reads. Rename or reshape one and this fails: update NebulisConnector.js in the same commit.
 */

const SCRIPT = fs.readFileSync(path.join(process.cwd(), 'server', 'assets', 'pixinsight', 'NebulisConnector.js'), 'utf8');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  // Uploading project files is admin-only (as in the web app); auth itself is covered by apiKeys.test.ts.
  app.use((req, _res, next) => { req.userRole = 'admin'; next(); });
  app.use('/api/v1/library', libraryRouter);
  app.use('/api/v1/meta', metaRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // One object, one night, two sub-frames, plus bias and flat bundles in the calibration archive.
  const id = 'M31';
  fs.mkdirSync(path.join(LIBRARY_DIR, id), { recursive: true });
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(LIBRARY_DIR, id, `sub_0000${n}_M31_10.0s_LP_20241008-22000${n}.fit`), 'fits');
  }
  stmts.upsertObject.run(id, id, 2, new Date().toISOString(), 0, null,
    id, 'Andromeda Galaxy', 'Galaxy', 'Andromeda', '', null, null, null, null);
  stmts.addSession.run(id, '2024-10-08');

  const biasDir = path.join(getArchiveDir(null), 'Bias', 'G100_TECm8');
  fs.mkdirSync(biasDir, { recursive: true });
  fs.writeFileSync(path.join(biasDir, 'Bias_5.0s_Bin1_Dark_gain100_20260815-193219_2deg_-8.0C_0001.fit'), 'frame-bytes');
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

type Env = { ok: boolean; data: any; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; body: Env }> {
  const res = await fetch(`${baseUrl}/api/v1${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Env };
}

describe('connector → server contract: endpoint list', () => {
  // Every `/api/v1/...` path string literal in the script, trailing id/query parts stripped.
  const found = [...new Set([...SCRIPT.matchAll(/"(\/api\/v1\/[^"]*)"/g)].map(m => m[1].replace(/\?.*$/, '')))].sort();

  it('calls exactly these endpoints, no more', () => {
    expect(found).toEqual([
      '/api/v1/library/calibrations',
      '/api/v1/library/calibrations/attachments',
      '/api/v1/library/calibrations/download/link',
      '/api/v1/library/calibrations/download/...', // comment text describing the link's url
      '/api/v1/library/download/objects/',
      '/api/v1/library/download/status/',
      '/api/v1/library/download/tmp/',
      '/api/v1/library/objects',
      '/api/v1/library/objects/',
      '/api/v1/meta/version',
    ].sort());
  });

  it('only builds object sub-paths the server has (sessions, files, thumbnail, project-archives, subframes)', () => {
    const subs = [...SCRIPT.matchAll(/"\/api\/v1\/library\/(?:objects|download\/objects)\/" \+ [^;]*?\+ "(\/[a-z-]+)"/g)].map(m => m[1]);
    expect(new Set(subs)).toEqual(new Set(['/sessions', '/files', '/thumbnail', '/project-archives', '/subframes']));
  });

  it('does not put the API key on the command line or send passwords', () => {
    expect(SCRIPT).not.toMatch(/"X-API-Key: " \+ [^;]*\bcurlArgs/);
    expect(SCRIPT).not.toContain('/auth/login');
    expect(SCRIPT).toContain('"@" + headerFile');
  });
});

describe('connector → server contract: response shapes', () => {
  it('GET /meta/version → { version }', async () => {
    const { status, body } = await api('GET', '/meta/version');
    expect(status).toBe(200);
    expect(typeof body.data.version).toBe('string');
  });

  it('GET /library/objects → array of objects with id, name, folderName', async () => {
    const { body } = await api('GET', '/library/objects');
    expect(Array.isArray(body.data)).toBe(true);
    const m31 = body.data.find((o: { id: string }) => o.id === 'M31');
    expect(m31).toBeTruthy();
    expect(typeof m31.name).toBe('string');
    expect(typeof m31.folderName).toBe('string');
    expect(m31.sessionCount === undefined || typeof m31.sessionCount === 'number').toBe(true);
  });

  it('GET /library/objects/:id/sessions → array with date', async () => {
    const { body } = await api('GET', '/library/objects/M31/sessions');
    expect(Array.isArray(body.data)).toBe(true);
    const night = body.data.find((s: { date: string }) => s.date === '2024-10-08');
    expect(night).toBeTruthy();
    // The calibration matcher builds one light spec per filter × exposure from these.
    expect(night.filters).toEqual(['LP']);
    expect(night.exposures).toEqual([10]);
    expect(night.subFrameCount).toBe(2);
  });

  it('GET /library/objects/:id/files answers (the script treats a failure as "no files")', async () => {
    const { status } = await api('GET', '/library/objects/M31/files');
    expect(status).toBe(200);
  });

  it('GET /library/calibrations → { groups[] } with the per-bundle fields the script flattens', async () => {
    const { body } = await api('GET', '/library/calibrations');
    expect(Array.isArray(body.data.groups)).toBe(true);
    const bias = body.data.groups.find((g: { type: string }) => g.type === 'bias');
    expect(bias).toBeTruthy();
    for (const k of ['type', 'typeLabel', 'scopeLabel', 'folderName']) expect(typeof bias[k]).toBe('string');
    expect(bias.scope === null || typeof bias.scope === 'string').toBe(true);
    expect(Array.isArray(bias.settingsGroups)).toBe(true);
    const set = bias.settingsGroups[0];
    expect(typeof set.key).toBe('string');
    expect(typeof set.exposureSec).toBe('number');
    expect(set.binning === undefined || set.binning === null || ['string', 'number'].includes(typeof set.binning)).toBe(true);
    expect(typeof set.fileCount).toBe('number');
    expect(typeof set.isExpired).toBe('boolean');
    expect(Array.isArray(set.files)).toBe(true);
    expect(typeof set.files[0].name).toBe('string');
    expect(typeof set.files[0].size).toBe('number');
    expect(Array.isArray(set.attachments) || set.attachments === undefined).toBe(true);
  });

  it('GET /library/calibrations/attachments?objectId= → { attachments[] }', async () => {
    const { body } = await api('GET', '/library/calibrations/attachments?objectId=M31');
    expect(Array.isArray(body.data.attachments)).toBe(true);
  });

  it('POST /library/calibrations/download/link → { url, filename } for a real bundle', async () => {
    const lib = (await api('GET', '/library/calibrations')).body.data.groups.find((g: { type: string }) => g.type === 'bias');
    const { status, body } = await api('POST', '/library/calibrations/download/link', {
      scope: lib.scope, folderName: lib.folderName, key: lib.settingsGroups[0].key,
    });
    expect(status).toBe(200);
    expect(body.data.url).toMatch(/^\/api\/v1\/library\/calibrations\/download\//);
    expect(body.data.filename).toMatch(/\.zip$/);
  });

  it('sub-frame zip: POST …/subframes → { jobId }, GET /download/status/:id → done + token, GET /download/tmp/:token → zip', async () => {
    const start = await api('POST', '/library/download/objects/M31/subframes', { dates: ['2024-10-08'], includeVariants: true });
    expect(start.status).toBe(200);
    expect(typeof start.body.data.jobId).toBe('string');

    let token: string | undefined;
    for (let i = 0; i < 50 && !token; i++) {
      const st = await api('GET', `/library/download/status/${start.body.data.jobId}`);
      expect(['running', 'done']).toContain(st.body.data.status);
      if (st.body.data.status === 'done') token = st.body.data.token;
      else await new Promise(r => setTimeout(r, 50));
    }
    expect(typeof token).toBe('string');

    const zip = await fetch(`${baseUrl}/api/v1/library/download/tmp/${token}`);
    expect(zip.status).toBe(200);
    const bytes = Buffer.from(await zip.arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
  });

  it('GET /library/objects/:id/project-archives → array (the Project Sync list)', async () => {
    const { body } = await api('GET', '/library/objects/M31/project-archives');
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('POST /library/objects/:id/project-archives (multipart "archive") → record with originalName/size/uploadedAt', async () => {
    const form = new FormData();
    form.append('archive', new Blob(['<xpsm/>']), 'icons.xpsm');
    form.append('software', 'PixInsight');
    form.append('title', 'icons.xpsm');
    const res = await fetch(`${baseUrl}/api/v1/library/objects/M31/project-archives`, { method: 'POST', body: form });
    const body = await res.json() as Env;
    expect(res.status).toBe(200);
    expect(body.data.originalName).toBe('icons.xpsm');
    expect(typeof body.data.size).toBe('number');
    expect(typeof body.data.uploadedAt).toBe('string');

    const list = (await api('GET', '/library/objects/M31/project-archives')).body.data;
    expect(list.map((r: { originalName: string }) => r.originalName)).toContain('icons.xpsm');
  });

  it('an upload of an unsupported type is refused, not stored', async () => {
    const form = new FormData();
    form.append('archive', new Blob(['x']), 'virus.exe');
    const res = await fetch(`${baseUrl}/api/v1/library/objects/M31/project-archives`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });
});

describe('connector script: loads outside PixInsight and parses real server responses', () => {
  // PJSR `#directives` are not JavaScript; stripping them lets Node evaluate the script's pure logic.
  function loadScript() {
    const code = SCRIPT.replace(/^#.*$/gm, '// pjsr directive');
    const mod: { exports: any } = { exports: {} }; // eslint-disable-line @typescript-eslint/no-explicit-any
    new Function('module', 'exports', code)(mod, mod.exports);
    return mod.exports;
  }

  it('exports its classes', () => {
    const m = loadScript();
    for (const name of ['NebulisSettings', 'NebulisClient', 'CalibrationMatcher']) expect(typeof m[name]).toBe('function');
  });

  it('parseApiText unwraps a success envelope the way the server sends it', async () => {
    const m = loadScript();
    const client = new m.NebulisClient(new m.NebulisSettings());
    const raw = await (await fetch(`${baseUrl}/api/v1/meta/version`)).text();
    const parsed = client.parseApiText(raw);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.data.version).toBe('string');
  });

  it('parseApiText surfaces the server\'s error message from a real error envelope', async () => {
    const m = loadScript();
    const client = new m.NebulisClient(new m.NebulisSettings());
    const raw = await (await fetch(`${baseUrl}/api/v1/library/calibrations/attachments`)).text();
    const parsed = client.parseApiText(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/objectId/);
  });

  it('parseApiText flags auth failures as 401 and survives a non-JSON body', () => {
    const m = loadScript();
    const client = new m.NebulisClient(new m.NebulisSettings());
    expect(client.parseApiText(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Sign in' } })).statusCode).toBe(401);
    expect(client.parseApiText('<html>502 Bad Gateway</html>').ok).toBe(false);
  });
});
