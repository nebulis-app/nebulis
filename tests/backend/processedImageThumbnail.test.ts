import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors libraryTrash.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-processedthumb-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { LIBRARY_DIR } from '../../server/lib/paths';
import { stmts, LIBRARY_API_BASE } from '../../server/lib/library/objects';
import { getLocalSessions, getLocalObservations } from '../../server/lib/library/observations';

let seq = 0;

/** Seed a library object with a raw stacked JPG for one session date, so the
 *  raw-file fallback has something to lose to. */
function seedObjectWithStackedImage(objectId: string, date: string): void {
  const compact = date.replace(/-/g, '');
  fs.mkdirSync(path.join(LIBRARY_DIR, objectId), { recursive: true });
  fs.writeFileSync(
    path.join(LIBRARY_DIR, objectId, `Stacked_10_${objectId}_30.0s_IRCUT_${compact}-220000.jpg`),
    'jpg',
  );
  const cat = { catalogId: objectId, objectName: objectId, objectType: 'Galaxy', constellation: '', description: '', magnitude: null, ra: null, dec: null, distanceLy: null };
  stmts.upsertObject.run(objectId, objectId, 1, new Date().toISOString(), 0, null,
    cat.catalogId, cat.objectName, cat.objectType, cat.constellation,
    cat.description, cat.magnitude, cat.ra, cat.dec, cat.distanceLy);
  stmts.addSession.run(objectId, date);
}

/** Insert a sessionProcessedImages row directly, bypassing the upload route —
 *  this test cares about the read-side priority, not the upload pipeline.
 *  `uploadedAt` is caller-controlled so recency ordering can be tested
 *  deterministically instead of racing Date.now(). */
function seedProcessedImage(
  objectId: string,
  date: string,
  filename: string,
  uploadedAt: string,
): void {
  seq++;
  stmts.insertProcessedImage.run(
    `proc_test_${seq}`, objectId, date, filename, filename, '', '', 100, 'image/jpeg', uploadedAt, null, 'user',
  );
}

function expectedUrl(relPath: string): string {
  return /\.(jpg|jpeg)$/i.test(relPath)
    ? `${LIBRARY_API_BASE}/file?path=${encodeURIComponent(relPath)}`
    : `${LIBRARY_API_BASE}/file/thumbnail?path=${encodeURIComponent(relPath)}`;
}

describe('processed images auto-win the session thumbnail', () => {
  afterAll(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

  it('getLocalSessions: a processed image beats the raw stacked file', () => {
    seedObjectWithStackedImage('M1', '2026-01-01');
    seedProcessedImage('M1', '2026-01-01', 'final.jpg', '2026-01-02T00:00:00.000Z');

    const session = getLocalSessions('M1').find(s => s.date === '2026-01-01')!;
    expect(session.thumbnailUrl).toBe(expectedUrl('M1/processed/final.jpg'));
  });

  it('getLocalSessions: picks the most recently uploaded processed image', () => {
    seedObjectWithStackedImage('M2', '2026-01-05');
    seedProcessedImage('M2', '2026-01-05', 'v1.jpg', '2026-01-06T00:00:00.000Z');
    seedProcessedImage('M2', '2026-01-05', 'v2.jpg', '2026-01-07T00:00:00.000Z');

    const session = getLocalSessions('M2').find(s => s.date === '2026-01-05')!;
    expect(session.thumbnailUrl).toBe(expectedUrl('M2/processed/v2.jpg'));
  });

  it('getLocalSessions: skips a processed image no browser can render', () => {
    // An XISF/FITS deliverable can't be handed to an <img>, so a session with
    // only that must still fall back to the raw stacked file.
    seedObjectWithStackedImage('M3', '2026-01-10');
    seedProcessedImage('M3', '2026-01-10', 'master.xisf', '2026-01-11T00:00:00.000Z');

    const session = getLocalSessions('M3').find(s => s.date === '2026-01-10')!;
    expect(session.thumbnailUrl).toBe(expectedUrl('M3/Stacked_10_M3_30.0s_IRCUT_20260110-220000.jpg'));
  });

  it('getLocalSessions: an explicit crown still wins over the auto-pick', () => {
    seedObjectWithStackedImage('M4', '2026-01-15');
    seedProcessedImage('M4', '2026-01-15', 'final.jpg', '2026-01-16T00:00:00.000Z');
    // Crown the raw stacked file by hand — the same "Set as session image"
    // action the observation page exposes.
    const rawPath = 'M4/Stacked_10_M4_30.0s_IRCUT_20260115-220000.jpg';
    stmts.setSessionImage.run(rawPath, 'M4', '2026-01-15');

    const session = getLocalSessions('M4').find(s => s.date === '2026-01-15')!;
    expect(session.thumbnailUrl).toBe(`${LIBRARY_API_BASE}/file?path=${encodeURIComponent(rawPath)}`);
  });

  it('getLocalObservations: the calendar card agrees with the object page', () => {
    seedObjectWithStackedImage('M5', '2026-01-20');
    seedProcessedImage('M5', '2026-01-20', 'final.jpg', '2026-01-21T00:00:00.000Z');

    const observation = getLocalObservations().find(o => o.objectId === 'M5' && o.date === '2026-01-20')!;
    expect(observation.thumbnailUrl).toBe(expectedUrl('M5/processed/final.jpg'));
  });
});
