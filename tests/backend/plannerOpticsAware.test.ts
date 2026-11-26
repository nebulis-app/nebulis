import { describe, it, expect, beforeEach } from 'vitest';
import db from '../../server/lib/db';
import {
  BRIGHT_MOON_NARROWBAND_BONUS, brightMoonNarrowbandBonus, generateNightPlan, type PlanCandidate,
} from '../../server/lib/autoPlan';
import { createGear } from '../../server/lib/gear';
import { setRig } from '../../server/lib/telescopeRig';
import { MIN_REVIEWED, getTelescopeNightRate, median, narrowbandCapableFor } from '../../server/lib/trainRate';
import { classifyFit, objectExtentArcmin } from '../../src/lib/telescopeFov';

const OBSERVER_LAT = 40;
const OBSERVER_LON = -74;
const WINDOW_START = new Date('2026-01-01T02:00:00Z');
const WINDOW_END = new Date('2026-01-01T04:00:00Z');

function candidate(overrides: Partial<PlanCandidate> & { id: string; ra: number; dec: number }): PlanCandidate {
  return {
    name: overrides.id, type: 'Galaxy', magnitude: 8, majorAxisArcmin: 10, constellation: null, commonNames: [],
    isAlreadyImaged: false, ...overrides,
  };
}

const plan = (targets: PlanCandidate[], extra: Record<string, unknown> = {}) => generateNightPlan({
  targets, observerLat: OBSERVER_LAT, observerLon: OBSERVER_LON, windowStart: WINDOW_START, windowEnd: WINDOW_END,
  slotMinutes: 120, maxObjects: 1, minAlt: 20, moonIllumination: 0, visibleSkyMap: null, ...extra,
});

/** The candidates as the client sends them for a telescope with this field: each with its frame fit. */
function forField(targets: PlanCandidate[], fov: { widthDeg: number; heightDeg: number }): PlanCandidate[] {
  return targets.map(t => ({ ...t, frameFit: classifyFit(fov, objectExtentArcmin(null, t.majorAxisArcmin))?.tag ?? null }));
}

// Side by side, high in the sky all window: a large nebula (2°) and a small galaxy (4′).
const bigNebula = candidate({ id: 'big-nebula', ra: 0, dec: 65, type: 'Emission Nebula', majorAxisArcmin: 120 });
const smallGalaxy = candidate({ id: 'small-galaxy', ra: 0.05, dec: 65, majorAxisArcmin: 4 });
const WIDE_FIELD = { widthDeg: 3.5, heightDeg: 2.3 }; // a short refractor on an APS-C sensor
const NARROW_FIELD = { widthDeg: 0.5, heightDeg: 0.33 }; // a long focal length

describe('optics-aware planning: frame fit', () => {
  it('picks the large nebula for a wide field and the small galaxy for a narrow one', () => {
    expect(plan(forField([bigNebula, smallGalaxy], WIDE_FIELD))[0]!.target.id).toBe('big-nebula');
    expect(plan(forField([bigNebula, smallGalaxy], NARROW_FIELD))[0]!.target.id).toBe('small-galaxy');
  });

  it('plans exactly as before when the client sends no fit', () => {
    const before = plan([bigNebula, smallGalaxy]);
    const withNulls = plan([bigNebula, smallGalaxy].map(t => ({ ...t, frameFit: null })));
    expect(withNulls.map(b => b.target.id)).toEqual(before.map(b => b.target.id));
    expect(withNulls.map(b => b.start.getTime())).toEqual(before.map(b => b.start.getTime()));
  });

  it('never sends the plan to a much lower target for a better fit', () => {
    // The well-framed one sits about 40° lower: altitude still decides.
    const high = candidate({ id: 'high', ra: 0, dec: 65, frameFit: 'mosaic' });
    const low = candidate({ id: 'low', ra: 0, dec: -15, frameFit: 'fits' });
    expect(plan([high, low])[0]!.target.id).toBe('high');
  });
});

describe('optics-aware planning: narrowband on a bright Moon', () => {
  it('grows from nothing at half Moon to the full bonus at full Moon', () => {
    expect(brightMoonNarrowbandBonus(30)).toBe(0);
    expect(brightMoonNarrowbandBonus(50)).toBe(0);
    expect(brightMoonNarrowbandBonus(75)).toBeCloseTo(BRIGHT_MOON_NARROWBAND_BONUS / 2, 6);
    expect(brightMoonNarrowbandBonus(100)).toBe(BRIGHT_MOON_NARROWBAND_BONUS);
  });

  it('lets a narrowband target edge out a broadband one only when asked, and only on a bright Moon', () => {
    // New Moon night, so the Moon is down and both are checked "ok" whatever illumination is passed: the ordering is
    // then altitude plus the bonus alone. The galaxy is about 4.5° higher; the nebula wins once the bonus applies.
    const galaxy = candidate({ id: 'galaxy', ra: 2, dec: 66 });
    const nebula = candidate({ id: 'nebula', ra: 1.3, dec: 60, type: 'Emission Nebula' });
    const base = {
      narrowbandCapable: true, moonIllumination: 95,
      windowStart: new Date('2026-01-18T02:00:00Z'), windowEnd: new Date('2026-01-18T04:00:00Z'),
    };
    const [plain] = plan([galaxy, nebula], base);
    expect(plain!.target.id).toBe('galaxy');
    expect(plain!.moonVerdict).toBe('ok');
    expect(plan([galaxy, nebula], { ...base, preferNarrowbandOnBrightMoon: true })[0]!.target.id).toBe('nebula');
    expect(plan([galaxy, nebula], { ...base, moonIllumination: 40, preferNarrowbandOnBrightMoon: true })[0]!.target.id).toBe('galaxy');
  });
});

describe('a telescope’s night rate and filters', () => {
  const SCOPE = 'rate-scope';
  const OTHER = 'rate-other';

  function addProfile(id: string): void {
    db.prepare(`INSERT OR IGNORE INTO telescopeProfiles (id, name, createdAt) VALUES (?, ?, '2026-01-01')`).run(id, id);
  }
  let seq = 0;
  /** One light sub: `night` at 23:00 local (the same observing night), its exposure in the header cache. */
  function addSub(telescopeId: string, night: string, exposureSec: number, keep: boolean | null = null): void {
    const relPath = `RATE/sub_${seq++}.fit`;
    db.prepare(
      `INSERT INTO libraryFiles (objectId, relPath, fileName, originalName, role, captureDate, captureTime, telescopeId, importedAt)
       VALUES ('RATE', ?, ?, ?, 'sub', ?, '230000', ?, '2026-01-01')`,
    ).run(relPath, relPath.split('/')[1], relPath.split('/')[1], night, telescopeId);
    db.prepare(`INSERT INTO subFrameHeaderCache (relPath, bytes, mtimeMs, rawFilter, exposureSec, cachedAt) VALUES (?, 1, 1, NULL, ?, 'x')`)
      .run(relPath, exposureSec);
    if (keep !== null) db.prepare(`INSERT INTO frameReview (relPath, keep, decidedAt) VALUES (?, ?, 'x')`).run(relPath, keep ? 1 : 0);
  }

  beforeEach(() => {
    db.prepare("DELETE FROM frameReview WHERE relPath LIKE 'RATE/%'").run();
    db.prepare("DELETE FROM subFrameHeaderCache WHERE relPath LIKE 'RATE/%'").run();
    db.prepare("DELETE FROM libraryFiles WHERE objectId = 'RATE'").run();
    db.prepare('DELETE FROM gearItems').run();
    db.prepare('DELETE FROM telescopeRigSettings WHERE profileId IN (?, ?)').run(SCOPE, OTHER);
    addProfile(SCOPE);
    addProfile(OTHER);
  });

  it('takes the median of its nights, and none below two nights', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    for (let i = 0; i < 12; i++) addSub(SCOPE, '2026-01-10', 300); // 1 h
    expect(getTelescopeNightRate(SCOPE)).toMatchObject({ nights: 1, medianNightSec: null });
    for (let i = 0; i < 36; i++) addSub(SCOPE, '2026-01-11', 300); // 3 h
    for (let i = 0; i < 24; i++) addSub(SCOPE, '2026-01-12', 300); // 2 h
    addSub(OTHER, '2026-01-12', 99_999); // another telescope's frames do not count
    expect(getTelescopeNightRate(SCOPE)).toMatchObject({ nights: 3, medianNightSec: 7200 });
  });

  it('reports the kept ratio only once enough subs were reviewed', () => {
    for (let i = 0; i < MIN_REVIEWED - 1; i++) addSub(SCOPE, '2026-01-10', 300, i % 4 !== 0);
    expect(getTelescopeNightRate(SCOPE)).toMatchObject({ reviewedFrames: MIN_REVIEWED - 1, keptRatio: null });
    addSub(SCOPE, '2026-01-10', 300, false);
    addSub(SCOPE, '2026-01-10', 300); // not reviewed: not counted either way
    const rate = getTelescopeNightRate(SCOPE);
    expect(rate.reviewedFrames).toBe(MIN_REVIEWED);
    expect(rate.keptRatio).toBeCloseTo(14 / 20, 6);
  });

  it("judges narrowband from the telescope's own filters, not another telescope's", () => {
    createGear({ kind: 'filter', name: 'L-eXtreme', specs: { type: 'dualBand' }, telescopeId: OTHER });
    createGear({ kind: 'filter', name: 'UV/IR cut', specs: { type: 'uvir' }, telescopeId: SCOPE });
    expect(narrowbandCapableFor(SCOPE)).toBe(false);
    expect(narrowbandCapableFor(OTHER)).toBe(true);
  });

  it('reads narrowband from the rig filter names too', () => {
    setRig(SCOPE, { sensorType: 'mono', filters: ['L', 'R', 'G', 'B', 'Ha 7nm'] });
    expect(narrowbandCapableFor(SCOPE)).toBe(true);
  });

  it('falls back to the whole inventory for a telescope nothing is known about', () => {
    expect(narrowbandCapableFor(SCOPE)).toBe(false);
    createGear({ kind: 'filter', name: 'L-eNhance', specs: { type: 'triBand' } });
    expect(narrowbandCapableFor(SCOPE)).toBe(true);
  });
});

describe('GET /telescopes/:id/night-rate', () => {
  it('answers the rate of a known telescope and 404 for an unknown one', async () => {
    const http = await import('http');
    const express = (await import('express')).default;
    const { apiEnvelope } = await import('../../server/middleware/apiEnvelope');
    const { telescopesRouter } = await import('../../server/routes/telescopes');
    db.prepare(`INSERT OR IGNORE INTO telescopeProfiles (id, name, createdAt) VALUES ('route-scope', 'route-scope', '2026-01-01')`).run();
    const app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.use('/telescopes', telescopesRouter);
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    const { port } = server.address() as import('net').AddressInfo;
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/telescopes/route-scope/night-rate`);
      expect(ok.status).toBe(200);
      expect((await ok.json()).data).toEqual({ telescopeId: 'route-scope', nights: 0, medianNightSec: null, reviewedFrames: 0, keptRatio: null });
      expect((await fetch(`http://127.0.0.1:${port}/telescopes/nope/night-rate`)).status).toBe(404);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
