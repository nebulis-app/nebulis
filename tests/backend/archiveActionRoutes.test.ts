import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-archiveaction-test-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  return dir;
});

// The pipeline's stages reach the network (catalog enrichment, weather).
vi.mock('../../server/lib/library/postImport', () => ({ runPostImport: vi.fn() }));

import fs from 'fs';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { storageRouter } from '../../server/routes/storage';
import db from '../../server/lib/db';
import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import { recordLibraryFiles } from '../../server/lib/library/libraryFiles';
import { setLibraryMigrating } from '../../server/lib/libraryMaintenance';
import { ARCHIVE_MARKER_FILENAME, writeArchiveMarker } from '../../server/lib/archive/archiveMarker';
import { DEFAULT_ARCHIVE_CONFIG, getArchiveConfig, setArchiveConfig } from '../../server/lib/archive/archiveConfig';
import { runArchive } from '../../server/lib/archive/archiveCopy';

/**
 * The archive's action routes.
 *
 * Steps 4 to 8 built the engines — copy, schedule, retention, browse, restore — and
 * nothing connected them to HTTP. This is that surface, and it is where the guards
 * have to hold, because these are the endpoints an operator actually calls:
 * running a copy, applying a prune, and writing files back into the library.
 *
 * The split of authority follows the existing storage routes: reads are unguarded
 * (the global apiAuth still requires a token) and everything that mutates or writes
 * to a disk is `requireAdmin` with `strictRateLimiter`.
 */

let server: http.Server;
let baseUrl: string;
let currentRole = 'admin';

const created: string[] = [];
const seededObjectIds: string[] = [];
const STACKED_JPG = 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg';
const SUB_FIT_A = 'sub_00001_M31_10.0s_LP_20241008-220000.fit';
const M31_FOLDER = 'M 31';
const SESSION = '2024-10-08_22-00-00';
const ARCHIVE_ID = 'archive-under-test';
const CONTENT = { stacked: 'stacked-jpg', sub: 'sub-a' } as const;

function scratchDir(prefix = 'nebulis-archive-test-action-'): string {
  const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), prefix));
  created.push(dir);
  return dir;
}

interface ApiResult {
  status: number;
  body: { ok?: boolean; data: Record<string, unknown>; error?: { code: string; message: string } };
}

async function api(method: string, routePath: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as ApiResult['body'] };
}

interface LastRun {
  trigger: string;
  result: { ran: boolean; reason?: string; copied: number; skipped: number; cancelled: boolean; linkedSkipped: number; summary: string };
}

/** "Run now" answers 202 and finishes in the background: start it, then wait for the
 *  status route to report how it ended. */
async function runAndWait(): Promise<{ started: ApiResult; lastRun: LastRun | null }> {
  const started = await api('POST', '/archive/run');
  if (started.status !== 202) return { started, lastRun: null };
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = await api('GET', '/archive/run/status');
    const lastRun = (status.body.data.lastRun ?? null) as LastRun | null;
    if (lastRun !== null) return { started, lastRun };
    if (Date.now() > deadline) throw new Error('archive run did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function seedAndArchive(dest: string): void {
  writeArchiveMarker(dest, ARCHIVE_ID);
  db.prepare(
    'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, 0)',
  ).run('M31', M31_FOLDER, new Date().toISOString());
  seededObjectIds.push('M31');
  db.prepare("UPDATE libraryObjects SET layout = 'nested' WHERE objectId = ?").run('M31');

  for (const [name, content] of [[STACKED_JPG, CONTENT.stacked], [SUB_FIT_A, CONTENT.sub]] as const) {
    const abs = path.join(getLibraryDir(), M31_FOLDER, SESSION, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  recordLibraryFiles([
    { objectId: 'M31', folderName: M31_FOLDER, sessionFolder: SESSION, fileName: STACKED_JPG, role: 'stacked' },
    { objectId: 'M31', folderName: M31_FOLDER, sessionFolder: SESSION, fileName: SUB_FIT_A, role: 'sub' },
  ]);
}

function configure(dest: string, overrides: Record<string, unknown> = {}): void {
  // The master switch is on for these tests: they are about what a configured and
  // enabled archive does. The cases that must refuse while it is off say so.
  setArchiveConfig({ ...DEFAULT_ARCHIVE_CONFIG, enabled: true, path: dest, archiveId: ARCHIVE_ID, ...overrides });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test';
    req.userId = 'u';
    req.username = 'tester';
    req.userRole = currentRole;
    next();
  });
  app.use('/', storageRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  currentRole = 'admin';
  setLibraryMigrating(false);
});

afterEach(() => {
  setArchiveConfig(DEFAULT_ARCHIVE_CONFIG);
  setLibraryMigrating(false);
  for (const objectId of seededObjectIds.splice(0)) {
    db.prepare('DELETE FROM libraryFiles WHERE objectId = ?').run(objectId);
    db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run(objectId);
  }
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('run', () => {
  it('reports its progress without admin, like the other status reads', async () => {
    currentRole = 'viewer';
    const { status, body } = await api('GET', '/archive/run/status');
    expect(status).toBe(200);
    expect(body.data.progress).toBeDefined();
  });

  it('requires admin to start a run', async () => {
    currentRole = 'viewer';
    const { status } = await api('POST', '/archive/run');
    expect(status).toBe(403);
  });

  it('refuses a run with no destination configured', async () => {
    configure('', {});
    const { status, body } = await api('POST', '/archive/run');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_NO_DESTINATION');
  });

  it('refuses a disk that is not our archive', async () => {
    const foreign = scratchDir();
    writeArchiveMarker(foreign, 'someone-elses');
    configure(foreign, {});

    const { status, body } = await api('POST', '/archive/run');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_DESTINATION_UNUSABLE');
  });

  it('archives and reports what it did', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    configure(dest, { includeSubframes: true });

    const { started, lastRun } = await runAndWait();
    expect(started.status).toBe(202);
    expect(lastRun?.trigger).toBe('manual');
    expect(lastRun?.result.copied).toBe(2);
    expect(fs.readFileSync(path.join(dest, M31_FOLDER, SESSION, SUB_FIT_A), 'utf8')).toBe(CONTENT.sub);
  });

  it('returns before the run finishes, and stamps the same result a scheduled run would', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    configure(dest, { includeSubframes: true });

    const started = await api('POST', '/archive/run');
    expect(started.status).toBe(202);
    expect(started.body.data.started).toBe(true);
    await runAndWait().catch(() => undefined);
    const deadline = Date.now() + 10_000;
    while (getArchiveConfig().lastRunAt === '' && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));

    const config = getArchiveConfig();
    expect(config.lastRunAt).not.toBe('');
    expect(config.lastResult).toContain('2 archived');
  });

  it('applies the removal setting, not just the copy', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    configure(dest, { includeSubframes: true, removeLocalAfter: true });

    await runAndWait();
    expect(fs.existsSync(path.join(getLibraryDir(), M31_FOLDER, SESSION, SUB_FIT_A))).toBe(false);
    expect(fs.existsSync(path.join(getLibraryDir(), M31_FOLDER, SESSION, STACKED_JPG))).toBe(true);
    expect(getArchiveConfig().lastResult).toContain('local subframes removed');
  });

  it('says how many linked files it left out', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, bytes, sourceId, sourcePath, importedAt)
       VALUES ('M31', '@src/src_x/a.jpg', 'a.jpg', 'a.jpg', 'stacked', 10, 'src_x', 'a.jpg', ?)`,
    ).run(new Date().toISOString());
    configure(dest, { includeSubframes: true });

    const { lastRun } = await runAndWait();
    expect(lastRun?.result.linkedSkipped).toBe(1);
    expect(getArchiveConfig().lastResult).toContain('1 linked file is not included');
    db.prepare("DELETE FROM libraryFiles WHERE sourceId = 'src_x'").run();
  });

  it('refuses to start a second run while one is in flight', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    configure(dest, { includeSubframes: true });

    // Started without awaiting, so the guard is set before the request is handled.
    const inFlight = runArchive(getArchiveConfig());
    const { status, body } = await api('POST', '/archive/run');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_ALREADY_RUNNING');
    await inFlight;
  });

  it('cancels a run: it stops at a file boundary and skips the follow-ups', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    configure(dest, { includeSubframes: true, removeLocalAfter: true });

    const started = await api('POST', '/archive/run');
    expect(started.status).toBe(202);
    const cancel = await api('POST', '/archive/run/cancel');
    // The run may already be over on a tiny library; the contract is that a cancel
    // that lands leaves nothing half-written and deletes nothing locally.
    expect([202, 409]).toContain(cancel.status);
    let lastRun: LastRun | null = null;
    const deadline = Date.now() + 10_000;
    while (lastRun === null && Date.now() < deadline) {
      lastRun = ((await api('GET', '/archive/run/status')).body.data.lastRun ?? null) as LastRun | null;
      if (lastRun === null) await new Promise(r => setTimeout(r, 20));
    }
    expect(lastRun).not.toBeNull();
    const sessionDir = path.join(dest, M31_FOLDER, SESSION);
    const leftovers = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).filter(f => f.endsWith('.part')) : [];
    expect(leftovers).toEqual([]);
    if (lastRun!.result.cancelled) {
      expect(getArchiveConfig().lastRunAt).toBe('');
      expect(fs.existsSync(path.join(getLibraryDir(), M31_FOLDER, SESSION, SUB_FIT_A))).toBe(true);
    }
  });

  it('a run cancelled before its first file copies nothing and records nothing', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    configure(dest, { includeSubframes: true });

    const controller = new AbortController();
    controller.abort();
    const result = await runArchive(getArchiveConfig(), { signal: controller.signal });

    expect(result.ran).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(result.copied).toBe(0);
    expect(fs.existsSync(path.join(dest, M31_FOLDER))).toBe(false);
    const { readArchiveManifest } = await import('../../server/lib/archive/archiveManifest');
    expect(Object.keys(readArchiveManifest(dest).objects)).toEqual([]);
  });

  it('has nothing to cancel when no run is going', async () => {
    const { status, body } = await api('POST', '/archive/run/cancel');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_NOT_RUNNING');
  });

  it('requires admin to cancel', async () => {
    currentRole = 'viewer';
    const { status } = await api('POST', '/archive/run/cancel');
    expect(status).toBe(403);
  });

  it('refuses while the library is busy with another job', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    configure(dest, { includeSubframes: true });
    setLibraryMigrating(true);

    const { status, body } = await api('POST', '/archive/run');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_LIBRARY_BUSY');
  });
});

describe('retention', () => {
  it('plans without removing anything', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    configure(dest, { includeSubframes: true, retentionEnabled: true, retentionDays: 30 });
    await runAndWait();

    const { status, body } = await api('GET', '/archive/retention');
    expect(status).toBe(200);
    const plan = body.data.plan as { filesTotal: number; mode: string };
    // Freshly archived, so nothing is due yet.
    expect(plan.filesTotal).toBe(0);
    expect(plan.mode).toBe('whole-object');
    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION, STACKED_JPG))).toBe(true);
  });

  it('requires admin to apply a plan', async () => {
    currentRole = 'viewer';
    const { status } = await api('POST', '/archive/retention/apply');
    expect(status).toBe(403);
  });

  it('applies a plan and removes what it planned', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    configure(dest, { includeSubframes: true, retentionEnabled: true, retentionDays: 30 });
    await runAndWait();

    // Age the record rather than waiting 30 days.
    const { readArchiveManifest, writeArchiveManifest } = await import('../../server/lib/archive/archiveManifest');
    const manifest = readArchiveManifest(dest);
    const past = new Date(Date.now() - 400 * 86_400_000).toISOString();
    manifest.objects[M31_FOLDER] = { ...manifest.objects[M31_FOLDER], firstArchivedAt: past, lastArchivedAt: past };
    writeArchiveManifest(dest, manifest);

    const { status, body } = await api('POST', '/archive/retention/apply');
    expect(status).toBe(200);
    expect(body.data.removed).toBe(2);
    expect(fs.existsSync(path.join(dest, M31_FOLDER, SESSION, STACKED_JPG))).toBe(false);
    // The disk is still ours afterwards.
    expect(fs.existsSync(path.join(dest, ARCHIVE_MARKER_FILENAME))).toBe(true);
  });

  it('removes nothing on a disk that is not ours', async () => {
    const foreign = scratchDir();
    writeArchiveMarker(foreign, 'someone-elses');
    fs.writeFileSync(path.join(foreign, 'their-file.jpg'), 'theirs');
    configure(foreign, { retentionEnabled: true, retentionDays: 1 });

    const { status, body } = await api('POST', '/archive/retention/apply');
    expect(status).toBe(200);
    expect(body.data.removed).toBe(0);
    expect(fs.readFileSync(path.join(foreign, 'their-file.jpg'), 'utf8')).toBe('theirs');
  });
});

describe('contents', () => {
  it('lists the archived objects and their files', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    configure(dest, { includeSubframes: true });
    await runAndWait();

    const objects = await api('GET', '/archive/contents');
    expect(objects.status).toBe(200);
    expect((objects.body.data.objects as unknown[]).length).toBe(1);

    const files = await api('GET', `/archive/contents?folder=${encodeURIComponent(M31_FOLDER)}`);
    expect(files.status).toBe(200);
    expect((files.body.data.files as unknown[]).length).toBe(2);
  });
});

describe('restore', () => {
  it('requires admin', async () => {
    currentRole = 'viewer';
    const { status } = await api('POST', '/archive/restore', { items: [] });
    expect(status).toBe(403);
  });

  it('rejects a body that is not a list of items', async () => {
    const dest = scratchDir();
    configure(dest, {});
    const { status } = await api('POST', '/archive/restore', { items: 'nope' });
    expect(status).toBe(400);
  });

  it('restores a file that is missing locally', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    configure(dest, { includeSubframes: true });
    await runAndWait();

    fs.rmSync(path.join(getLibraryDir(), M31_FOLDER, SESSION, SUB_FIT_A));

    const { status, body } = await api('POST', '/archive/restore', {
      items: [{ folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` }],
    });
    expect(status).toBe(200);
    expect(body.data.restored).toBe(1);
    expect(fs.readFileSync(path.join(getLibraryDir(), M31_FOLDER, SESSION, SUB_FIT_A), 'utf8')).toBe(CONTENT.sub);
  });

  it('reports a conflict instead of overwriting an edit', async () => {
    const dest = scratchDir();
    seedAndArchive(dest);
    configure(dest, { includeSubframes: true });
    await runAndWait();

    const local = path.join(getLibraryDir(), M31_FOLDER, SESSION, SUB_FIT_A);
    fs.writeFileSync(local, 'the user edited this');

    const { status, body } = await api('POST', '/archive/restore', {
      items: [{ folderName: M31_FOLDER, relPath: `${SESSION}/${SUB_FIT_A}` }],
    });
    expect(status).toBe(200);
    expect(body.data.restored).toBe(0);
    expect((body.data.conflicts as string[]).length).toBe(1);
    expect(fs.readFileSync(local, 'utf8')).toBe('the user edited this');
  });
});
