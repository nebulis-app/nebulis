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
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-librarybusy-test-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  return dir;
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { storageRouter } from '../../server/routes/storage';
import { libraryRouter } from '../../server/routes/library';
import db from '../../server/lib/db';
import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import {
  acquireLibraryLock, currentLibraryWork, isLibraryBusy, type LibraryWork,
} from '../../server/lib/libraryBusy';
import { claimImportLock, releaseImportLock } from '../../server/lib/library/import';
import { tickLinkedSourceRefresh } from '../../server/lib/library/linkedSourceScheduler';
import { commitSource, setRefreshInterval } from '../../server/lib/library/librarySources';
import { tickArchiveScheduler } from '../../server/lib/archive/archiveScheduler';
import { ARCHIVE_MARKER_FILENAME, writeArchiveMarker } from '../../server/lib/archive/archiveMarker';
import { DEFAULT_ARCHIVE_CONFIG, getArchiveConfig, setArchiveConfig } from '../../server/lib/archive/archiveConfig';

/**
 * The shared library-work lock.
 *
 * The archive used to check the import flag once, at the start of a run, and
 * nothing checked the archive at all, so an import could start halfway through a
 * pass that was deleting local sub-frames. These tests hold the lock the way a
 * running job would and prove that every entry point answers "busy" instead of
 * starting, and that the archive holds it for its whole run.
 */

const NOON_UTC = new Date('2026-03-10T12:00:00Z');
const ARCHIVE_ID = 'archive-under-test';

const realFetch = globalThis.fetch;
let server: http.Server;
let baseUrl: string;
const created: string[] = [];
const held: Array<() => void> = [];

interface ApiResult {
  status: number;
  body: { ok?: boolean; data: Record<string, unknown>; error?: { code: string; message: string } };
}

async function api(method: string, routePath: string, body?: unknown): Promise<ApiResult> {
  const res = await realFetch(`${baseUrl}${routePath}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as ApiResult['body'] };
}

/** Hold the lock as `kind`, the way that job would while it runs. */
function hold(kind: LibraryWork): void {
  const release = acquireLibraryLock(kind);
  expect(release).not.toBeNull();
  if (release) held.push(release);
}

function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), prefix));
  created.push(dir);
  return dir;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test';
    req.userId = 'u';
    req.username = 'tester';
    req.userRole = 'admin';
    next();
  });
  app.use('/library', libraryRouter);
  app.use('/storage', storageRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  db.prepare('DELETE FROM librarySources').run();
});

afterEach(() => {
  for (const release of held.splice(0)) release();
  releaseImportLock();
  setArchiveConfig(DEFAULT_ARCHIVE_CONFIG);
  fs.rmSync(getLibraryDir(), { recursive: true, force: true });
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the lock itself', () => {
  it('is exclusive and reports who holds it', () => {
    expect(isLibraryBusy()).toBe(false);
    const release = acquireLibraryLock('archive');
    expect(release).not.toBeNull();
    expect(currentLibraryWork()).toBe('archive');
    expect(acquireLibraryLock('linked-scan')).toBeNull();
    release?.();
    expect(isLibraryBusy()).toBe(false);
  });

  it('lets a stale release do nothing to a newer holder', () => {
    const first = acquireLibraryLock('purge');
    first?.();
    const second = acquireLibraryLock('repair');
    first?.();
    expect(currentLibraryWork()).toBe('repair');
    second?.();
  });

  it('is taken by an import claim and freed by its release', () => {
    expect(claimImportLock()).toBe(true);
    expect(currentLibraryWork()).toBe('import');
    expect(acquireLibraryLock('archive')).toBeNull();
    releaseImportLock();
    expect(isLibraryBusy()).toBe(false);
  });

  it('refuses an import claim while another job holds it', () => {
    hold('archive');
    expect(claimImportLock()).toBe(false);
  });
});

describe('while the archive holds the lock', () => {
  beforeEach(() => hold('archive'));

  it('refuses a copy import', async () => {
    const { status, body } = await api('POST', '/library/import', { all: true });
    expect(status).toBe(409);
    expect(body.error?.code).toBe('LIBRARY_BUSY');
    expect(body.error?.message).toMatch(/archive run/i);
  });

  it('refuses a sub-frame sync', async () => {
    const { status, body } = await api('POST', '/library/objects/M31/sync-subframes');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('LIBRARY_BUSY');
  });

  it('refuses a linked folder rescan', async () => {
    const { status, body } = await api('POST', '/library/sources/anything/rescan');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('LIBRARY_BUSY');
  });

  it('refuses linking a folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-busy-link-'));
    created.push(root);
    const { status, body } = await api('POST', '/library/sources', { rootPath: root, label: 'Busy test' });
    expect(status).toBe(409);
    expect(body.error?.code).toBe('LIBRARY_BUSY');
  });

  it('refuses a session sub-frame delete', async () => {
    const { status, body } = await api('DELETE', '/library/objects/M31/sessions/2024-10-08/subframes');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('LIBRARY_BUSY');
  });

  it('refuses a sub-frame purge', async () => {
    const { status, body } = await api('DELETE', '/storage/cleanup/subframes');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('LIBRARY_BUSY');
  });

  it('refuses a Library Health repair', async () => {
    const { status, body } = await api('POST', '/storage/analyze/fix', { category: 'staleRecords' });
    expect(status).toBe(409);
    expect(body.error?.code).toBe('LIBRARY_BUSY');
  });

  it('refuses a reorganize', async () => {
    const { status, body } = await api('POST', '/storage/renest');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('LIBRARY_BUSY');
  });

  it('refuses an archive restore', async () => {
    setArchiveConfig({ ...DEFAULT_ARCHIVE_CONFIG, enabled: true });
    const { status, body } = await api('POST', '/storage/archive/restore', {
      items: [{ folderName: 'M 31', relPath: 'a.jpg' }],
    });
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_LIBRARY_BUSY');
  });

  it('refuses applying retention', async () => {
    setArchiveConfig({ ...DEFAULT_ARCHIVE_CONFIG, enabled: true, retentionEnabled: true, retentionDays: 30 });
    const { status, body } = await api('POST', '/storage/archive/retention/apply');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_LIBRARY_BUSY');
  });

  it('refuses a second archive run', async () => {
    setArchiveConfig({ ...DEFAULT_ARCHIVE_CONFIG, enabled: true });
    const { status, body } = await api('POST', '/storage/archive/run');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('ARCHIVE_LIBRARY_BUSY');
  });
});

describe('while an import holds the lock', () => {
  it('keeps the IMPORT_RUNNING code the clients already handle', async () => {
    expect(claimImportLock()).toBe(true);
    const { status, body } = await api('POST', '/library/objects/M31/sync-subframes');
    expect(status).toBe(409);
    expect(body.error?.code).toBe('IMPORT_RUNNING');
  });

  it('refuses applying retention and restore', async () => {
    claimImportLock();
    setArchiveConfig({ ...DEFAULT_ARCHIVE_CONFIG, enabled: true, retentionEnabled: true, retentionDays: 30 });
    expect((await api('POST', '/storage/archive/retention/apply')).status).toBe(409);
    expect((await api('POST', '/storage/archive/restore', { items: [{ folderName: 'a', relPath: 'b' }] })).status).toBe(409);
  });
});

describe('the schedulers', () => {
  it('skips the linked refresh tick while the archive holds the lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-busy-source-'));
    created.push(root);
    const folder = path.join(root, 'M 31 - Andromeda');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg'), 'a'.repeat(100));
    const { sourceId } = commitSource(root, { importJpg: true, importFits: true, importSubFrames: true }, { label: 'x' });
    setRefreshInterval(sourceId, 60);
    db.prepare('UPDATE librarySources SET lastScanAt = ? WHERE id = ?').run(new Date(0).toISOString(), sourceId);

    hold('archive');
    const busy = await tickLinkedSourceRefresh();
    expect(busy).toEqual({ ran: [], skippedBecause: 'library-busy' });
  });

  it('skips the linked refresh tick while an import runs, under the name it already had', async () => {
    claimImportLock();
    expect((await tickLinkedSourceRefresh()).skippedBecause).toBe('import-running');
  });

  it('skips the archive tick while a linked scan holds the lock', async () => {
    const dest = scratchDir('nebulis-archive-test-busy-');
    writeArchiveMarker(dest, ARCHIVE_ID);
    setArchiveConfig({
      ...getArchiveConfig(), path: dest, archiveId: ARCHIVE_ID, enabled: true,
      scheduleEnabled: true, scheduleMode: 'daily', scheduleHour: 0, scheduleMinute: 0,
    });
    hold('linked-scan');
    const outcome = await tickArchiveScheduler(NOON_UTC, 'UTC');
    expect(outcome).toEqual({ ran: false, skippedBecause: 'library-busy' });
  });

  it('holds the lock for the whole archive tick and frees it afterwards', async () => {
    const dest = scratchDir('nebulis-archive-test-hold-');
    writeArchiveMarker(dest, ARCHIVE_ID);
    db.prepare(
      'INSERT OR REPLACE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted) VALUES (?, ?, 0, ?, 0)',
    ).run('M31', 'M 31', new Date().toISOString());
    const abs = path.join(getLibraryDir(), 'M 31', 'Stacked_10_M31_10.0s_LP_20241008-220000.jpg');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'stacked');
    setArchiveConfig({
      ...getArchiveConfig(), path: dest, archiveId: ARCHIVE_ID, enabled: true,
      scheduleEnabled: true, scheduleMode: 'daily', scheduleHour: 0, scheduleMinute: 0,
      includeSubframes: true,
    });

    try {
      const inFlight = tickArchiveScheduler(NOON_UTC, 'UTC');
      // The tick awaits the destination check before it takes the lock, so give it turns.
      let observed: LibraryWork | null = null;
      for (let i = 0; i < 200 && observed === null; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
        observed = currentLibraryWork();
      }
      expect(observed).toBe('archive');
      // Everything that would overlap the run is refused while it is going.
      expect(claimImportLock()).toBe(false);
      expect(acquireLibraryLock('linked-scan')).toBeNull();

      const outcome = await inFlight;
      expect(outcome.ran).toBe(true);
      expect(isLibraryBusy()).toBe(false);
    } finally {
      db.prepare('DELETE FROM libraryObjects WHERE objectId = ?').run('M31');
      expect(fs.existsSync(path.join(dest, ARCHIVE_MARKER_FILENAME))).toBe(true);
    }
  });
});
