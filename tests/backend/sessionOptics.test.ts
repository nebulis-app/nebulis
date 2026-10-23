import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-sessionoptics-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { stmts } from '../../server/lib/library/objects';
import { recordLibraryFile, recordLinkedLibraryFiles } from '../../server/lib/library/libraryFiles';
import db from '../../server/lib/db';
import { createProfile } from '../../server/lib/telescopes';
import { addOpticalConfig, type TelescopeOpticalConfig } from '../../server/lib/telescopeOpticalConfigs';
import {
  backfillSessionFocals,
  fitsFocalForSession,
  invalidateSessionFocal,
  matchConfigByFocal,
  opticalConfigsByProfile,
  resolveSessionOptics,
  rigKey,
} from '../../server/lib/library/sessionOptics';
import {
  exposureSeconds,
  getLocalObservationDetail,
  getLocalObservations,
  getLocalSessions,
  reassignSessionTelescope,
  setSessionOptics,
} from '../../server/lib/library/observations';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { libraryRouter } from '../../server/routes/library';

/** A minimal FITS header (no data) carrying FOCALLEN when given. */
function fitsWith(focal: number | null): Buffer {
  const card = (k: string, v: string) => `${k.padEnd(8)}= ${v.padStart(20)}`.padEnd(80);
  const cards = [card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '0')];
  if (focal !== null) cards.push(card('FOCALLEN', String(focal)));
  cards.push('END'.padEnd(80));
  const header = cards.join('');
  return Buffer.from(header.padEnd(Math.ceil(header.length / 2880) * 2880), 'ascii');
}

let elendil: string;
let seestar: string;
let native: TelescopeOpticalConfig;
let reducer: TelescopeOpticalConfig;

/** One night of M27 shot by `telescopeId`, its sub carrying `focal`. */
function night(date: string, telescopeId: string, focal: number | null) {
  stmts.addSessionStamped.run('M27', date, telescopeId);
  const fileName = `Light_M27_180.0s_Bin1_H_${date.replace(/-/g, '')}-230000_0001.fit`;
  fs.writeFileSync(path.join(LIBRARY_DIR, 'M27', fileName), fitsWith(focal));
  recordLibraryFile({ objectId: 'M27', folderName: 'M27', fileName, role: 'sub', captureDate: date, captureTime: '230000', telescopeId });
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  fs.mkdirSync(path.join(LIBRARY_DIR, 'M27'), { recursive: true });
  stmts.upsertObject.run('M27', 'M27', 0, new Date().toISOString(), 0, null, 'M27', 'Dumbbell', null, null, null, null, null, null, null);
  elendil = createProfile({ name: 'Elendil', kind: 'asiair' } as never).id;
  seestar = createProfile({ name: 'Seestar', kind: 'seestar' } as never).id;
  native = addOpticalConfig(elendil, { name: 'Native', focalLengthMm: 609, sensorWidthMm: 11.1, sensorHeightMm: 6.3, pixelSizeUm: 2.9 });
  reducer = addOpticalConfig(elendil, { name: 'Reducer 0.75x', focalLengthMm: 456, sensorWidthMm: 11.1, sensorHeightMm: 6.3, pixelSizeUm: 2.9 });

  night('2026-09-01', elendil, 609);
  night('2026-09-02', elendil, 457.5);
  night('2026-09-03', elendil, null);
  night('2026-09-04', seestar, 250);

  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => { (req as unknown as { userRole: string }).userRole = 'admin'; next(); });
  app.use('/library', libraryRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('matchConfigByFocal', () => {
  it('picks the configuration within 5 %, and none when far or tied', () => {
    expect(matchConfigByFocal([native, reducer], 600)?.name).toBe('Native');
    expect(matchConfigByFocal([native, reducer], 460)?.name).toBe('Reducer 0.75x');
    expect(matchConfigByFocal([native, reducer], 530)).toBeNull();
    expect(matchConfigByFocal([native, { ...native, id: 'twin' }], 609)).toBeNull();
    expect(matchConfigByFocal([native], null)).toBeNull();
  });
});

describe('resolveSessionOptics', () => {
  it('prefers the choice, then the FITS focal length, then the only configuration', () => {
    const configs = opticalConfigsByProfile();
    expect(resolveSessionOptics(elendil, { opticalConfigId: reducer.id, fileFocalMm: 609 }, configs))
      .toMatchObject({ configId: reducer.id, source: 'manual', focalLengthMm: 456, fileFocalMm: 609 });
    expect(resolveSessionOptics(elendil, { opticalConfigId: null, fileFocalMm: 609 }, configs))
      .toMatchObject({ configId: native.id, source: 'fits' });
    // A choice that belongs to another telescope is ignored.
    expect(resolveSessionOptics(seestar, { opticalConfigId: reducer.id, fileFocalMm: 250 }, configs))
      .toMatchObject({ configId: null, source: null, focalLengthMm: 250 });
    const only = new Map([[elendil, [native]]]);
    expect(resolveSessionOptics(elendil, { opticalConfigId: null, fileFocalMm: null }, only)).toMatchObject({ configId: native.id, source: 'only' });
  });

  it('keys rigs by telescope and train, keeping unconfigured focal lengths apart', () => {
    const configs = opticalConfigsByProfile();
    const a = resolveSessionOptics(seestar, { opticalConfigId: null, fileFocalMm: 250 }, configs);
    expect(rigKey(seestar, a)).toBe(`${seestar}|250mm`);
    expect(rigKey(elendil, resolveSessionOptics(elendil, { opticalConfigId: null, fileFocalMm: 609 }, configs))).toBe(`${elendil}|${native.id}`);
    expect(rigKey(null, resolveSessionOptics(null, null, configs))).toBe('-|-');
  });
});

describe('sessions', () => {
  it('reads FOCALLEN once and caches it, until new files arrive', () => {
    expect(fitsFocalForSession('M27', '2026-09-01')).toBe(609);
    fs.writeFileSync(path.join(LIBRARY_DIR, 'M27', 'Light_M27_180.0s_Bin1_H_20260901-230000_0001.fit'), fitsWith(456));
    expect(fitsFocalForSession('M27', '2026-09-01')).toBe(609); // cached
    invalidateSessionFocal('M27', '2026-09-01');
    expect(fitsFocalForSession('M27', '2026-09-01')).toBe(456);
    fs.writeFileSync(path.join(LIBRARY_DIR, 'M27', 'Light_M27_180.0s_Bin1_H_20260901-230000_0001.fit'), fitsWith(609));
    invalidateSessionFocal('M27', '2026-09-01');
  });

  it('gives each night of the object page its optical train', () => {
    const byDate = new Map(getLocalSessions('M27').map(s => [s.date, s]));
    expect(byDate.get('2026-09-01')).toMatchObject({ telescopeName: 'Elendil', optics: { configName: 'Native', source: 'fits' } });
    expect(byDate.get('2026-09-02')).toMatchObject({ optics: { configName: 'Reducer 0.75x', source: 'fits', fileFocalMm: 457.5 } });
    expect(byDate.get('2026-09-03')).toMatchObject({ optics: { configId: null, source: null } });
    expect(byDate.get('2026-09-04')).toMatchObject({ telescopeName: 'Seestar', optics: { configId: null, focalLengthMm: 250 } });
    expect(byDate.get('2026-09-01')!.rigKey).not.toBe(byDate.get('2026-09-02')!.rigKey);
    // No device sidecar: the night's integration is the sum of its sub exposures.
    expect(byDate.get('2026-09-01')!.integrationSec).toBe(180);
  });

  it('reads exposure tokens', () => {
    expect(exposureSeconds('180.0s')).toBe(180);
    expect(exposureSeconds('500ms')).toBe(0.5);
    expect(exposureSeconds('10S')).toBe(10);
    expect(exposureSeconds(undefined)).toBeNull();
    expect(exposureSeconds('fast')).toBeNull();
  });

  it('fills the observations list from the cache, which the background fill completes', async () => {
    invalidateSessionFocal('M27', '2026-09-04');
    expect(getLocalObservations().find(o => o.date === '2026-09-04')?.optics.focalLengthMm).toBeNull();
    backfillSessionFocals();
    await new Promise(r => setTimeout(r, 100));
    expect(getLocalObservations().find(o => o.date === '2026-09-04')?.optics.focalLengthMm).toBe(250);
  });

  it('lets the user choose, refuses another telescope’s configuration, and resets on a telescope change', () => {
    expect(setSessionOptics('M27', '2026-09-03', reducer.id)).toBe('ok');
    expect(getLocalObservationDetail('M27', '2026-09-03')?.optics).toMatchObject({ configId: reducer.id, source: 'manual' });
    expect(setSessionOptics('M27', '2026-09-04', reducer.id)).toBe('wrong_telescope');
    expect(setSessionOptics('M27', '2099-01-01', null)).toBe('not_found');

    // Same telescope: the choice stays. Another telescope: it goes.
    reassignSessionTelescope('M27', '2026-09-03', elendil);
    expect(stmts.getSession.get('M27', '2026-09-03')?.opticalConfigId).toBe(reducer.id);
    reassignSessionTelescope('M27', '2026-09-03', seestar);
    expect(stmts.getSession.get('M27', '2026-09-03')?.opticalConfigId).toBeNull();
    reassignSessionTelescope('M27', '2026-09-03', elendil);
  });

  it('exposes the choice through the route', async () => {
    const put = (date: string, body: unknown) => fetch(`${baseUrl}/library/objects/M27/sessions/${date}/optics`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await put('2026-09-01', { opticalConfigId: reducer.id })).status).toBe(200);
    expect(stmts.getSession.get('M27', '2026-09-01')?.opticalConfigId).toBe(reducer.id);
    expect((await put('2026-09-01', { opticalConfigId: null })).status).toBe(200);
    expect((await put('2026-09-04', { opticalConfigId: native.id })).status).toBe(422);
    expect((await put('2099-01-01', { opticalConfigId: null })).status).toBe(404);
    expect((await put('2026-09-01', {})).status).toBe(400);
  });
});


describe('linked libraries and offline folders', () => {
  const LINKED_ROOT = path.join(TEST_DATA_DIR, 'linked-root');

  function sessionFocalState(objectId: string, date: string) {
    return db.prepare('SELECT fileFocalMm, focalResolved FROM librarySessions WHERE objectId = ? AND date = ?').get(objectId, date) as
      { fileFocalMm: number | null; focalResolved: number };
  }

  /** An object whose only frames live outside the library, in a linked source. */
  function linkedNight(objectId: string, date: string, focal: number | null, opts: { write?: boolean; enabled?: number } = {}) {
    stmts.upsertObject.run(objectId, objectId, 0, new Date().toISOString(), 0, null, objectId, objectId, null, null, null, null, null, null, null);
    stmts.addSessionStamped.run(objectId, date, elendil);
    db.prepare('INSERT OR REPLACE INTO librarySources (id, label, rootPath, enabled, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run('lnk1', 'Disk', LINKED_ROOT, opts.enabled ?? 1, new Date().toISOString());
    const sourcePath = `${objectId}/Light_${objectId}_180.0s_Bin1_H_${date.replace(/-/g, '')}-230000_0001.fit`;
    if (opts.write !== false) {
      fs.mkdirSync(path.join(LINKED_ROOT, objectId), { recursive: true });
      fs.writeFileSync(path.join(LINKED_ROOT, sourcePath), fitsWith(focal));
    }
    recordLinkedLibraryFiles([{
      objectId, relPath: `@src/lnk1/${sourcePath}`, sourceId: 'lnk1', sourcePath, fileName: path.basename(sourcePath),
      role: 'sub', captureDate: date, captureTime: '230000', telescopeId: elendil, bytes: 1, mtimeMs: 1,
    }]);
  }

  it('reads the focal length of a night whose frames are only in a linked folder', () => {
    linkedNight('M101', '2026-09-10', 609);
    expect(fitsFocalForSession('M101', '2026-09-10')).toBe(609);
    expect(sessionFocalState('M101', '2026-09-10')).toEqual({ fileFocalMm: 609, focalResolved: 1 });
  });

  it('remembers "no FOCALLEN" when the file was read and has none', () => {
    linkedNight('M102', '2026-09-11', null);
    expect(fitsFocalForSession('M102', '2026-09-11')).toBeNull();
    expect(sessionFocalState('M102', '2026-09-11').focalResolved).toBe(1);
  });

  it('does not remember "none" when the linked file cannot be reached, and reads it once it can', () => {
    linkedNight('M103', '2026-09-12', 456, { write: false });
    expect(fitsFocalForSession('M103', '2026-09-12')).toBeNull();
    expect(sessionFocalState('M103', '2026-09-12').focalResolved).toBe(0);

    // The drive comes back.
    const sourcePath = `M103/Light_M103_180.0s_Bin1_H_20260912-230000_0001.fit`;
    fs.mkdirSync(path.join(LINKED_ROOT, 'M103'), { recursive: true });
    fs.writeFileSync(path.join(LINKED_ROOT, sourcePath), fitsWith(456));
    expect(fitsFocalForSession('M103', '2026-09-12')).toBe(456);
    expect(sessionFocalState('M103', '2026-09-12')).toEqual({ fileFocalMm: 456, focalResolved: 1 });
  });

  it('does not remember "none" while the linked source is disabled or flagged missing', () => {
    linkedNight('M104', '2026-09-13', 609, { enabled: 0 });
    expect(fitsFocalForSession('M104', '2026-09-13')).toBeNull();
    expect(sessionFocalState('M104', '2026-09-13').focalResolved).toBe(0);
    db.prepare('UPDATE librarySources SET enabled = 1 WHERE id = ?').run('lnk1');
    expect(fitsFocalForSession('M104', '2026-09-13')).toBe(609);
  });

  it('does not remember "none" when the object folder is not there (library offline)', () => {
    stmts.upsertObject.run('M105', 'M105', 0, new Date().toISOString(), 0, null, 'M105', 'M105', null, null, null, null, null, null, null);
    stmts.addSessionStamped.run('M105', '2026-09-14', elendil);
    expect(fitsFocalForSession('M105', '2026-09-14')).toBeNull();
    expect(sessionFocalState('M105', '2026-09-14').focalResolved).toBe(0);
  });

  it('does not ask a failing linked source again within one background pass', async () => {
    linkedNight('M106', '2026-09-15', null, { write: false });
    linkedNight('M107', '2026-09-16', null, { write: false });
    const skip = new Set<string>();
    fitsFocalForSession('M106', '2026-09-15', undefined, skip);
    expect(skip.has('lnk1')).toBe(true);
    // M107's file exists on disk now, but the pass has written the source off.
    fs.mkdirSync(path.join(LINKED_ROOT, 'M107'), { recursive: true });
    fs.writeFileSync(path.join(LINKED_ROOT, 'M107', 'Light_M107_180.0s_Bin1_H_20260916-230000_0001.fit'), fitsWith(609));
    expect(fitsFocalForSession('M107', '2026-09-16', undefined, skip)).toBeNull();
    expect(sessionFocalState('M107', '2026-09-16').focalResolved).toBe(0);
  });
});
