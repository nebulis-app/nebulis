import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import db from '../../server/lib/db';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';
import { gearRouter } from '../../server/routes/gear';
import {
  GearError,
  createGear,
  createKit,
  deleteGear,
  deleteKit,
  getChecks,
  getKit,
  listGear,
  sanitizeSpecs,
  setCheck,
  setGearArchived,
  updateGear,
  updateKit,
} from '../../server/lib/gear';

beforeEach(() => {
  db.prepare('DELETE FROM gearItems').run();
  db.prepare('DELETE FROM gearKits').run();
  db.prepare('DELETE FROM gearKitChecks').run();
});

describe('sanitizeSpecs', () => {
  it('keeps the figures a kind has, in range, and drops everything else', () => {
    expect(sanitizeSpecs('power', { capacityWh: 99, drawW: 12, colour: 'red', capacity: 5 })).toEqual({ capacityWh: 99, drawW: 12 });
    expect(sanitizeSpecs('filter', { type: 'dualBand', bandsNm: ' 656 / 500 ', size: '2"', capacityWh: 99 })).toEqual({ type: 'dualBand', bandsNm: '656 / 500', size: '2"' });
    expect(sanitizeSpecs('camera', { sensorWidthMm: 7.4, sensorHeightMm: 5, pixelUm: 2.9, cooled: true })).toEqual({ sensorWidthMm: 7.4, sensorHeightMm: 5, pixelUm: 2.9, cooled: true });
  });

  it('never coerces: a string where a number belongs, or a value out of range, is dropped', () => {
    expect(sanitizeSpecs('power', { capacityWh: '99' })).toEqual({});
    expect(sanitizeSpecs('power', { capacityWh: 0 })).toEqual({});
    expect(sanitizeSpecs('power', { capacityWh: 1e9 })).toEqual({});
    expect(sanitizeSpecs('power', { capacityWh: NaN })).toEqual({});
    expect(sanitizeSpecs('filter', { type: 'rainbow' })).toEqual({});
    expect(sanitizeSpecs('dewHeater', { channels: 2.5 })).toEqual({});
    expect(sanitizeSpecs('mount', { goto: 'yes' })).toEqual({});
    expect(sanitizeSpecs('power', 'nope')).toEqual({});
    expect(sanitizeSpecs('power', null)).toEqual({});
  });

  it('lets any kind carry a power draw', () => {
    expect(sanitizeSpecs('dewHeater', { drawW: 15, channels: 2 })).toEqual({ drawW: 15, channels: 2 });
    expect(sanitizeSpecs('computer', { drawW: 45 })).toEqual({ drawW: 45 });
    expect(sanitizeSpecs('computer', { drawW: -1 })).toEqual({});
  });
});

describe('gear items', () => {
  it('creates, lists in kind-then-name order, and round-trips the specs', () => {
    createGear({ kind: 'power', name: 'Jackery', specs: { capacityWh: 288 } });
    createGear({ kind: 'filter', name: 'UV/IR cut', specs: { type: 'uvir' } });
    createGear({ kind: 'filter', name: 'L-eXtreme', brand: ' Optolong ', specs: { type: 'dualBand', size: '2"' } });
    const list = listGear();
    expect(list.map((g) => g.name)).toEqual(['L-eXtreme', 'UV/IR cut', 'Jackery']);
    expect(list[0]).toMatchObject({ kind: 'filter', brand: 'Optolong', specs: { type: 'dualBand', size: '2"' }, archivedAt: null, telescopeId: null });
  });

  it('refuses an empty name and a telescope that does not exist', () => {
    expect(() => createGear({ kind: 'other', name: '   ' })).toThrow(GearError);
    expect(() => createGear({ kind: 'other', name: 'x', telescopeId: 'no-such-scope' })).toThrow(/telescope does not exist/);
  });

  it('attaches to a real telescope', () => {
    db.prepare("INSERT OR REPLACE INTO telescopeProfiles (id, name, createdAt) VALUES ('scope-1', 'Seestar', ?)").run(new Date().toISOString());
    try {
      expect(createGear({ kind: 'filter', name: 'x', telescopeId: 'scope-1' }).telescopeId).toBe('scope-1');
    } finally {
      db.prepare("DELETE FROM telescopeProfiles WHERE id = 'scope-1'").run();
    }
  });

  it('re-validates specs when the kind changes, so a figure that no longer belongs is dropped', () => {
    const g = createGear({ kind: 'power', name: 'Bank', specs: { capacityWh: 99, drawW: 5 } });
    const changed = updateGear(g.id, { kind: 'filter' });
    expect(changed.kind).toBe('filter');
    expect(changed.specs).toEqual({ drawW: 5 });
  });

  it('changes only what it is told to', () => {
    const g = createGear({ kind: 'lens', name: '35mm', brand: 'Rokinon', specs: { focalLengthMm: 35 } });
    const u = updateGear(g.id, { notes: 'sharp at f/2.8' });
    expect(u).toMatchObject({ name: '35mm', brand: 'Rokinon', specs: { focalLengthMm: 35 }, notes: 'sharp at f/2.8' });
    expect(() => updateGear('missing', { name: 'x' })).toThrow(/not found/);
  });

  it('archives without losing it and brings it back', () => {
    const g = createGear({ kind: 'tripod', name: 'Old tripod' });
    expect(setGearArchived(g.id, true).archivedAt).not.toBeNull();
    expect(listGear()).toHaveLength(0);
    expect(listGear({ includeArchived: true })).toHaveLength(1);
    expect(setGearArchived(g.id, false).archivedAt).toBeNull();
    expect(listGear()).toHaveLength(1);
  });

  it('takes deleted gear off every kit', () => {
    const a = createGear({ kind: 'power', name: 'A' }), b = createGear({ kind: 'power', name: 'B' });
    const kit = createKit({ name: 'Backyard', itemIds: [a.id, b.id], extraItems: ['red torch'] });
    expect(deleteGear(a.id)).toBe(true);
    expect(getKit(kit.id)?.itemIds).toEqual([b.id]);
    expect(getKit(kit.id)?.extraItems).toEqual(['red torch']);
    expect(deleteGear(a.id)).toBe(false);
  });
});

describe('kits and packing checks', () => {
  it('trims, de-duplicates and limits a kit', () => {
    const kit = createKit({ name: '  Dark-site trip ', itemIds: ['a', 'a', 'b'], extraItems: [' warm hat ', '', '  '] });
    expect(kit).toMatchObject({ name: 'Dark-site trip', itemIds: ['a', 'b'], extraItems: ['warm hat'], siteId: null });
    expect(() => createKit({ name: '' })).toThrow(GearError);
    expect(() => createKit({ name: 'big', itemIds: Array.from({ length: 201 }, (_, i) => `i${i}`) })).toThrow(/at most 200/);
    expect(updateKit(kit.id, { siteId: 'site-1' }).siteId).toBe('site-1');
    expect(updateKit(kit.id, { siteId: null }).siteId).toBeNull();
  });

  it('keeps tick state per kit and night, and clears it with the kit', () => {
    const kit = createKit({ name: 'Backyard', itemIds: ['a'], extraItems: ['red torch'] });
    expect(setCheck(kit.id, '2026-10-08', 'a', true)).toEqual(['a']);
    expect(setCheck(kit.id, '2026-10-08', 'extra:red torch', true)).toEqual(['a', 'extra:red torch']);
    expect(getChecks(kit.id, '2026-10-09')).toEqual([]);
    expect(setCheck(kit.id, '2026-10-08', 'a', false)).toEqual(['extra:red torch']);
    expect(deleteKit(kit.id)).toBe(true);
    expect(getChecks(kit.id, '2026-10-08')).toEqual([]);
  });

  it('refuses a bad night or an unknown kit', () => {
    const kit = createKit({ name: 'x' });
    expect(() => getChecks(kit.id, 'tonight')).toThrow(/Nights look like/);
    expect(() => setCheck('missing', '2026-10-08', 'a', true)).toThrow(/Kit not found/);
    expect(() => setCheck(kit.id, '2026-10-08', '  ', true)).toThrow(GearError);
  });

  it('drops ticks older than 30 days as it goes', () => {
    const kit = createKit({ name: 'x' });
    setCheck(kit.id, '2026-08-01', 'a', true, new Date('2026-08-01T20:00:00Z'));
    expect(getChecks(kit.id, '2026-08-01')).toEqual(['a']);
    setCheck(kit.id, '2026-10-08', 'a', true, new Date('2026-10-08T20:00:00Z'));
    expect(getChecks(kit.id, '2026-08-01')).toEqual([]);
    expect(getChecks(kit.id, '2026-10-08')).toEqual(['a']);
  });
});

/** What a reply carries, loosely: a gear item, a kit, a tick list or an array of them. The tests assert on what they use. */
interface Reply {
  id: string; name: string; notes: string; archivedAt: string | null; specs: Record<string, unknown>;
  night: string; checked: string[]; deleted: boolean; length: number;
}

describe('/gear', () => {
  let server: http.Server;
  let base: string;
  let role = 'admin';

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(apiEnvelope);
    app.use((req, _res, next) => { req.id = 'test'; req.userId = 'u'; req.userRole = role as 'admin'; next(); });
    app.use('/gear', gearRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  beforeEach(() => { role = 'admin'; });

  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/gear${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as { data: Reply; error?: { code: string; message: string } } };
  };

  it('adds, reads, changes, archives and deletes gear', async () => {
    const created = await call('POST', '', { kind: 'power', name: 'Anker 99Wh', specs: { capacityWh: 99, bogus: 1 } });
    expect(created.status).toBe(200);
    expect(created.body.data.specs).toEqual({ capacityWh: 99 });
    const id = created.body.data.id as string;

    expect((await call('GET', `/${id}`)).body.data.name).toBe('Anker 99Wh');
    expect((await call('PUT', `/${id}`, { notes: 'in the grey bag' })).body.data.notes).toBe('in the grey bag');
    expect((await call('POST', `/${id}/archive`)).body.data.archivedAt).not.toBeNull();
    expect((await call('GET', '')).body.data).toHaveLength(0);
    expect((await call('GET', '?archived=1')).body.data).toHaveLength(1);
    expect((await call('POST', `/${id}/unarchive`)).body.data.archivedAt).toBeNull();
    expect((await call('DELETE', `/${id}`)).body.data).toEqual({ deleted: true });
    expect((await call('GET', `/${id}`)).status).toBe(404);
  });

  it('reads "kits" as the kits, not as a gear id', async () => {
    const r = await call('GET', '/kits');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
  });

  it('runs a packing list for a night', async () => {
    const gear = (await call('POST', '', { kind: 'power', name: 'Bank' })).body.data;
    const kit = (await call('POST', '/kits', { name: 'Backyard', itemIds: [gear.id], extraItems: ['red torch'] })).body.data;
    expect((await call('PUT', `/kits/${kit.id}/checks?night=2026-10-08`, { itemKey: gear.id, checked: true })).body.data)
      .toEqual({ night: '2026-10-08', checked: [gear.id] });
    expect((await call('GET', `/kits/${kit.id}/checks?night=2026-10-08`)).body.data.checked).toEqual([gear.id]);
    expect((await call('DELETE', `/kits/${kit.id}/checks?night=2026-10-08`)).body.data.checked).toEqual([]);
    expect((await call('DELETE', `/kits/${kit.id}`)).body.data).toEqual({ deleted: true });
    expect((await call('GET', `/kits/${kit.id}/checks?night=2026-10-08`)).status).toBe(404);
  });

  it('says what is wrong', async () => {
    expect((await call('POST', '', { kind: 'toaster', name: 'x' })).body.error?.code).toBe('VALIDATION_ERROR');
    expect((await call('POST', '', { kind: 'power', name: '' })).body.error?.code).toBe('VALIDATION_ERROR');
    expect((await call('POST', '', { kind: 'power', name: 'x', telescopeId: 'nope' })).body.error?.message).toMatch(/telescope/);
    expect((await call('PUT', '/missing', { name: 'x' })).status).toBe(404);
    expect((await call('GET', '/kits/x/checks?night=nope')).status).toBe(404);
  });

  it('lets anyone signed in read but only an admin write', async () => {
    const gear = (await call('POST', '', { kind: 'power', name: 'Bank' })).body.data;
    role = 'viewer';
    expect((await call('GET', '')).status).toBe(200);
    expect((await call('GET', `/${gear.id}`)).status).toBe(200);
    expect((await call('GET', '/kits')).status).toBe(200);
    for (const [method, path, body] of [
      ['POST', '', { kind: 'power', name: 'x' }], ['PUT', `/${gear.id}`, { name: 'y' }], ['DELETE', `/${gear.id}`, undefined],
      ['POST', `/${gear.id}/archive`, undefined], ['POST', '/kits', { name: 'k' }],
    ] as const) {
      expect((await call(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
  });
});
