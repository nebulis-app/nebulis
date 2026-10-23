import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  process.env.DATA_DIR = _fs.mkdtempSync(_path.join(_root, 'nebulis-planoutcome-test-'));
});

import { computePlanOutcomes, observingNightOfInstant, summarizePlanByNight, DONE_RATIO } from '../../server/lib/planOutcome';
import type { PlannedSession } from '../../server/lib/plannedSessions';
import { recordLibraryFile } from '../../server/lib/library/libraryFiles';
import { stmts } from '../../server/lib/library/objects';
import { updateSettingsData } from '../../server/lib/telescopes';
import { LIBRARY_DIR } from '../../server/lib/paths';
import db from '../../server/lib/db';

const TZ = 'Europe/Paris';
const FOLDER = 'Crescent';

function fits(exptime: number | null): Buffer {
  const card = (k: string, v: string) => `${k.padEnd(8)}= ${v.padStart(20)}`.padEnd(80);
  const cards = [card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '0')];
  if (exptime !== null) cards.push(card('EXPTIME', String(exptime)));
  cards.push('END'.padEnd(80));
  return Buffer.from(cards.join('').padEnd(2880 * 2), 'ascii');
}

/** A sub with a libraryFiles row; local capture date/time like the importers store. */
function addSub(name: string, date: string, hms: string, exptime: number | null = 300): void {
  fs.mkdirSync(path.join(LIBRARY_DIR, FOLDER), { recursive: true });
  fs.writeFileSync(path.join(LIBRARY_DIR, FOLDER, name), fits(exptime));
  recordLibraryFile({ objectId: 'NGC6888', folderName: FOLDER, fileName: name, role: 'sub', captureDate: date, captureTime: hms });
}

let nextId = 1;
function block(startIso: string, endIso: string, over: Partial<PlannedSession> = {}): PlannedSession {
  return {
    id: nextId++, objectId: 'Sh2-105', objectName: 'Crescent', ra: 20.2, dec: 38.3,
    startTime: new Date(startIso).toISOString(), endTime: new Date(endIso).toISOString(),
    notes: '', framingSetup: null, skipped: 0, createdAt: '', updatedAt: '',
    ...over,
  };
}

const LATER = new Date('2026-10-01T12:00:00Z');

beforeEach(() => {
  for (const t of ['libraryFiles', 'libraryObjects', 'libraryDeletedSessions']) db.prepare(`DELETE FROM ${t}`).run();
  fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  updateSettingsData({ groupObservingNights: true });
  // Library folder id differs from the catalog id the Planner schedules.
  stmts.upsertObject.run('NGC6888', FOLDER, 0, new Date().toISOString(), 0, null, 'Sh2-105', 'Crescent', null, null, null, null, null, null, null);
});

describe('observingNightOfInstant', () => {
  it('rolls early-morning instants back to the previous evening', () => {
    expect(observingNightOfInstant(new Date('2026-09-05T20:00:00Z'), TZ)).toBe('2026-09-05');
    expect(observingNightOfInstant(new Date('2026-09-06T01:00:00Z'), TZ)).toBe('2026-09-05');
  });
});

describe('computePlanOutcomes — one block per night', () => {
  it('counts every sub of the object that night, across midnight, through the catalog id', () => {
    // 22:00 → 00:00 local (20:00 → 22:00 UTC). Subs at 22:30, 23:45 and 00:30 local.
    addSub('a.fits', '2026-09-05', '223000');
    addSub('b.fits', '2026-09-05', '234500');
    addSub('c.fits', '2026-09-06', '003000');
    addSub('other-night.fits', '2026-09-07', '223000');
    const b = block('2026-09-05T20:00:00Z', '2026-09-05T22:00:00Z');
    const o = computePlanOutcomes([b], { timeZone: TZ, now: LATER }).get(b.id)!;
    expect(o).toEqual({ status: 'partial', plannedSec: 7200, achievedSec: 900, frames: 3 });
  });

  it(`is done at ${DONE_RATIO * 100}% of the planned time, missed with nothing`, () => {
    for (let i = 0; i < 18; i++) addSub(`s${i}.fits`, '2026-09-05', `22${String(i).padStart(2, '0')}00`);
    const done = block('2026-09-05T20:00:00Z', '2026-09-05T22:00:00Z');
    const missed = block('2026-09-08T20:00:00Z', '2026-09-08T22:00:00Z');
    const out = computePlanOutcomes([done, missed], { timeZone: TZ, now: LATER });
    expect(out.get(done.id)).toMatchObject({ status: 'done', achievedSec: 5400, frames: 18 });
    expect(out.get(missed.id)).toMatchObject({ status: 'missed', achievedSec: 0, frames: 0 });
  });

  it('is awaiting import, not missed, for a day after a block ends with nothing in the library', () => {
    const b = block('2026-09-08T20:00:00Z', '2026-09-08T22:00:00Z');
    const justAfter = new Date(Date.parse('2026-09-08T22:00:00Z') + 3 * 3_600_000);
    const dayAfter = new Date(Date.parse('2026-09-08T22:00:00Z') + 25 * 3_600_000);
    expect(computePlanOutcomes([b], { timeZone: TZ, now: justAfter }).get(b.id)).toMatchObject({ status: 'awaiting_import' });
    expect(computePlanOutcomes([b], { timeZone: TZ, now: dayAfter }).get(b.id)).toMatchObject({ status: 'missed' });
  });

  it('finds subs that have no libraryFiles row by their file name', () => {
    fs.mkdirSync(path.join(LIBRARY_DIR, FOLDER), { recursive: true });
    fs.writeFileSync(
      path.join(LIBRARY_DIR, FOLDER, 'Light_NGC6888_180.0s_Bin1_H_gain252_20260905-221500_-10.0C_0001.fit'),
      fits(180),
    );
    const b = block('2026-09-05T20:00:00Z', '2026-09-05T22:00:00Z');
    expect(computePlanOutcomes([b], { timeZone: TZ, now: LATER }).get(b.id)).toMatchObject({ frames: 1, achievedSec: 180 });
  });

  it('ignores subs of a deleted session', () => {
    addSub('a.fits', '2026-09-05', '223000');
    db.prepare('INSERT INTO libraryDeletedSessions (objectId, date) VALUES (?, ?)').run('NGC6888', '2026-09-05');
    const b = block('2026-09-05T20:00:00Z', '2026-09-05T22:00:00Z');
    expect(computePlanOutcomes([b], { timeZone: TZ, now: LATER }).get(b.id)!.status).toBe('missed');
  });
});

describe('computePlanOutcomes — several blocks of one object in a night', () => {
  it('splits subs by capture time, with tolerance', () => {
    addSub('early.fits', '2026-09-05', '221000'); // first block (22:00–23:00)
    addSub('edge.fits', '2026-09-05', '231000'); // 10 min after first block → first (tolerance)
    addSub('late.fits', '2026-09-06', '011000'); // second block (01:00–02:00)
    addSub('gap.fits', '2026-09-06', '000000'); // between blocks, outside both tolerances
    const first = block('2026-09-05T20:00:00Z', '2026-09-05T21:00:00Z');
    const second = block('2026-09-05T23:00:00Z', '2026-09-06T00:00:00Z');
    const out = computePlanOutcomes([first, second], { timeZone: TZ, now: LATER });
    expect(out.get(first.id)).toMatchObject({ frames: 2 });
    expect(out.get(second.id)).toMatchObject({ frames: 1 });
  });
});

describe('computePlanOutcomes — timing and manual marks', () => {
  it('reports upcoming and in-progress blocks, and honours the skipped mark', () => {
    addSub('a.fits', '2026-09-05', '223000');
    const now = new Date('2026-09-05T21:00:00Z');
    const running = block('2026-09-05T20:00:00Z', '2026-09-05T22:00:00Z');
    const future = block('2026-09-06T20:00:00Z', '2026-09-06T22:00:00Z');
    const skipped = block('2026-09-04T20:00:00Z', '2026-09-04T22:00:00Z');
    const out = computePlanOutcomes([running, future, skipped], { timeZone: TZ, now, skippedIds: new Set([skipped.id]) });
    expect(out.get(running.id)).toMatchObject({ status: 'in_progress', frames: 1 });
    expect(out.get(future.id)).toMatchObject({ status: 'upcoming', frames: 0 });
    expect(out.get(skipped.id)!.status).toBe('skipped');
  });

  it('falls back to the default exposure when a sub has no EXPTIME', () => {
    addSub('a.fits', '2026-09-05', '223000', null);
    const b = block('2026-09-05T20:00:00Z', '2026-09-05T22:00:00Z');
    expect(computePlanOutcomes([b], { timeZone: TZ, now: LATER }).get(b.id)!.achievedSec).toBe(10);
  });
});

describe('summarizePlanByNight', () => {
  it('sums a night\'s blocks per object and matches the library ids', () => {
    addSub('a.fits', '2026-09-05', '221000');
    addSub('b.fits', '2026-09-06', '011000');
    const first = block('2026-09-05T20:00:00Z', '2026-09-05T21:00:00Z');
    const second = block('2026-09-05T23:00:00Z', '2026-09-06T00:00:00Z');
    const other = block('2026-09-08T20:00:00Z', '2026-09-08T21:00:00Z');
    const sessions = [first, second, other];
    const outcomes = computePlanOutcomes(sessions, { timeZone: TZ, now: LATER });
    expect(summarizePlanByNight(sessions, outcomes, TZ)).toEqual([
      {
        night: '2026-09-05', objectId: 'Sh2-105', objectName: 'Crescent', libraryObjectIds: ['NGC6888'],
        blocks: 2, plannedSec: 7200, achievedSec: 600, frames: 2, status: 'partial',
      },
      {
        night: '2026-09-08', objectId: 'Sh2-105', objectName: 'Crescent', libraryObjectIds: ['NGC6888'],
        blocks: 1, plannedSec: 3600, achievedSec: 0, frames: 0, status: 'missed',
      },
    ]);
  });

  it('leaves skipped blocks out of the totals, and reports an all-skipped night as skipped', () => {
    const kept = block('2026-09-05T20:00:00Z', '2026-09-05T21:00:00Z');
    const dropped = block('2026-09-05T23:00:00Z', '2026-09-06T00:00:00Z');
    const lone = block('2026-09-08T20:00:00Z', '2026-09-08T21:00:00Z');
    const sessions = [kept, dropped, lone];
    const outcomes = computePlanOutcomes(sessions, { timeZone: TZ, now: LATER, skippedIds: new Set([dropped.id, lone.id]) });
    const byNight = new Map(summarizePlanByNight(sessions, outcomes, TZ).map(n => [n.night, n]));
    expect(byNight.get('2026-09-05')).toMatchObject({ blocks: 2, plannedSec: 3600, status: 'missed' });
    expect(byNight.get('2026-09-08')).toMatchObject({ blocks: 1, plannedSec: 3600, status: 'skipped' });
  });
});
