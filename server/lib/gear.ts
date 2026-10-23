/**
 * Gear: what the user brings to a night besides the telescopes, and the packing lists built from it.
 *
 * Telescopes stay in telescopeProfiles and their optical trains in telescopeOpticalConfigs; nothing here duplicates them. A gear item
 * may be attached to a telescope, and a kit may list telescope ids beside gear ids.
 *
 * Specs are validated per kind and unknown or out-of-range figures are dropped, never guessed: the Tonight advice that reads them
 * (battery against the night's length, a dual-band filter against a bright Moon) is only as honest as what the user typed.
 */
import { randomUUID } from 'crypto';
import db from './db.js';
import { isRecord } from './typeGuards.js';

export const GEAR_KINDS = [
  'filter', 'camera', 'lens', 'reducer', 'mount', 'tripod', 'dewHeater', 'power', 'computer', 'accessory', 'other',
] as const;
export type GearKind = (typeof GEAR_KINDS)[number];

export const FILTER_TYPES = ['broadband', 'uvir', 'lightPollution', 'dualBand', 'triBand', 'narrowband', 'solar'] as const;
export type FilterType = (typeof FILTER_TYPES)[number];

export type GearSpecs = Record<string, number | string | boolean>;

export interface GearItem {
  id: string;
  kind: GearKind;
  name: string;
  brand: string;
  model: string;
  specs: GearSpecs;
  telescopeId: string | null;
  notes: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GearKit {
  id: string;
  name: string;
  /** Gear ids and telescope ids. */
  itemIds: string[];
  /** Free-text lines: "red torch", "warm hat". */
  extraItems: string[];
  siteId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const MAX_KIT_ITEMS = 200;
export const MAX_EXTRA_ITEMS = 50;
const CHECK_RETENTION_DAYS = 30;

// ─── Specs ──────────────────────────────────────────────────────────

interface NumberSpec { kind: 'number'; min: number; max: number }
interface IntegerSpec { kind: 'integer'; min: number; max: number }
interface BooleanSpec { kind: 'boolean' }
interface TextSpec { kind: 'text'; max: number }
interface EnumSpec { kind: 'enum'; values: readonly string[] }
type SpecRule = NumberSpec | IntegerSpec | BooleanSpec | TextSpec | EnumSpec;

const num = (min: number, max: number): NumberSpec => ({ kind: 'number', min, max });

/** Any gear can draw power; a dew heater's watts are its draw. */
const COMMON: Record<string, SpecRule> = { drawW: num(0, 2000) };

const RULES: Record<GearKind, Record<string, SpecRule>> = {
  filter: { type: { kind: 'enum', values: FILTER_TYPES }, bandsNm: { kind: 'text', max: 60 }, size: { kind: 'text', max: 20 } },
  camera: { sensorWidthMm: num(0.1, 100), sensorHeightMm: num(0.1, 100), pixelUm: num(0.1, 50), cooled: { kind: 'boolean' } },
  lens: { focalLengthMm: num(1, 5000) },
  reducer: { factor: num(0.1, 3) },
  mount: { payloadKg: num(0, 200), goto: { kind: 'boolean' } },
  tripod: {},
  dewHeater: { channels: { kind: 'integer', min: 1, max: 8 } },
  power: { capacityWh: num(1, 5000) },
  computer: {},
  accessory: {},
  other: {},
};

/** Keep only the figures this kind of gear has, each in range. Anything else is dropped rather than coerced. */
export function sanitizeSpecs(kind: GearKind, input: unknown): GearSpecs {
  const out: GearSpecs = {};
  if (!isRecord(input)) return out;
  const rules = { ...RULES[kind], ...COMMON };
  for (const [key, rule] of Object.entries(rules)) {
    const v = input[key];
    switch (rule.kind) {
      case 'number':
        if (typeof v === 'number' && Number.isFinite(v) && v >= rule.min && v <= rule.max) out[key] = v;
        break;
      case 'integer':
        if (typeof v === 'number' && Number.isInteger(v) && v >= rule.min && v <= rule.max) out[key] = v;
        break;
      case 'boolean':
        if (typeof v === 'boolean') out[key] = v;
        break;
      case 'text':
        if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim().slice(0, rule.max);
        break;
      case 'enum':
        if (typeof v === 'string' && rule.values.includes(v)) out[key] = v;
        break;
    }
  }
  return out;
}

// ─── Rows ───────────────────────────────────────────────────────────

interface ItemRow {
  id: string; kind: GearKind; name: string; brand: string; model: string; specsJson: string;
  telescopeId: string | null; notes: string; archivedAt: string | null; createdAt: string; updatedAt: string;
}
interface KitRow {
  id: string; name: string; itemIdsJson: string; extraItemsJson: string; siteId: string | null; createdAt: string; updatedAt: string;
}

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

function toItem(r: ItemRow): GearItem {
  return {
    id: r.id, kind: r.kind, name: r.name, brand: r.brand, model: r.model, telescopeId: r.telescopeId, notes: r.notes,
    archivedAt: r.archivedAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
    specs: sanitizeSpecs(r.kind, parseJson<unknown>(r.specsJson, {})),
  };
}

function toKit(r: KitRow): GearKit {
  const ids = parseJson<unknown>(r.itemIdsJson, []), extras = parseJson<unknown>(r.extraItemsJson, []);
  return {
    id: r.id, name: r.name, siteId: r.siteId, createdAt: r.createdAt, updatedAt: r.updatedAt,
    itemIds: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [],
    extraItems: Array.isArray(extras) ? extras.filter((x): x is string => typeof x === 'string') : [],
  };
}

const stmts = {
  items: db.prepare<[], ItemRow>('SELECT * FROM gearItems ORDER BY kind, name COLLATE NOCASE'),
  item: db.prepare<[string], ItemRow>('SELECT * FROM gearItems WHERE id = ?'),
  insertItem: db.prepare(
    `INSERT INTO gearItems (id, kind, name, brand, model, specsJson, telescopeId, notes, archivedAt, createdAt, updatedAt)
     VALUES (@id, @kind, @name, @brand, @model, @specsJson, @telescopeId, @notes, @archivedAt, @createdAt, @updatedAt)`,
  ),
  updateItem: db.prepare(
    `UPDATE gearItems SET kind = @kind, name = @name, brand = @brand, model = @model, specsJson = @specsJson,
       telescopeId = @telescopeId, notes = @notes, archivedAt = @archivedAt, updatedAt = @updatedAt WHERE id = @id`,
  ),
  deleteItem: db.prepare('DELETE FROM gearItems WHERE id = ?'),
  telescopeExists: db.prepare<[string], { n: number }>('SELECT 1 AS n FROM telescopeProfiles WHERE id = ?'),
  kits: db.prepare<[], KitRow>('SELECT * FROM gearKits ORDER BY name COLLATE NOCASE'),
  kit: db.prepare<[string], KitRow>('SELECT * FROM gearKits WHERE id = ?'),
  insertKit: db.prepare(
    `INSERT INTO gearKits (id, name, itemIdsJson, extraItemsJson, siteId, createdAt, updatedAt)
     VALUES (@id, @name, @itemIdsJson, @extraItemsJson, @siteId, @createdAt, @updatedAt)`,
  ),
  updateKit: db.prepare(
    `UPDATE gearKits SET name = @name, itemIdsJson = @itemIdsJson, extraItemsJson = @extraItemsJson, siteId = @siteId, updatedAt = @updatedAt WHERE id = @id`,
  ),
  deleteKit: db.prepare('DELETE FROM gearKits WHERE id = ?'),
  deleteKitChecks: db.prepare('DELETE FROM gearKitChecks WHERE kitId = ?'),
  checks: db.prepare<[string, string], { itemKey: string }>('SELECT itemKey FROM gearKitChecks WHERE kitId = ? AND night = ? ORDER BY itemKey'),
  check: db.prepare('INSERT OR REPLACE INTO gearKitChecks (kitId, night, itemKey, checkedAt) VALUES (?, ?, ?, ?)'),
  uncheck: db.prepare('DELETE FROM gearKitChecks WHERE kitId = ? AND night = ? AND itemKey = ?'),
  clearChecks: db.prepare('DELETE FROM gearKitChecks WHERE kitId = ? AND night = ?'),
  pruneChecks: db.prepare('DELETE FROM gearKitChecks WHERE night < ?'),
};

// ─── Items ──────────────────────────────────────────────────────────

export class GearError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'INVALID', message: string) { super(message); }
}

export interface GearItemInput {
  kind?: GearKind;
  name?: string;
  brand?: string;
  model?: string;
  specs?: unknown;
  telescopeId?: string | null;
  notes?: string;
}

function checkTelescope(id: string | null | undefined): string | null {
  if (id === null || id === undefined || id === '') return null;
  if (!stmts.telescopeExists.get(id)) throw new GearError('INVALID', 'That telescope does not exist');
  return id;
}

function cleanName(name: string | undefined, label: string): string {
  const v = (name ?? '').trim();
  if (v === '') throw new GearError('INVALID', `${label} cannot be empty`);
  return v.slice(0, 120);
}

export function listGear(opts: { includeArchived?: boolean } = {}): GearItem[] {
  const all = stmts.items.all().map(toItem);
  return opts.includeArchived ? all : all.filter((g) => g.archivedAt === null);
}

/** True when an active filter in the user's gear passes narrowband light (dual-, tri- or narrow-band). */
export function hasNarrowbandCapableFilter(): boolean {
  return listGear().some(g => g.kind === 'filter'
    && (g.specs.type === 'dualBand' || g.specs.type === 'triBand' || g.specs.type === 'narrowband'));
}

export function getGear(id: string): GearItem | null {
  const r = stmts.item.get(id);
  return r ? toItem(r) : null;
}

export function createGear(input: GearItemInput & { kind: GearKind }): GearItem {
  const now = new Date().toISOString();
  const item: GearItem = {
    id: randomUUID(),
    kind: input.kind,
    name: cleanName(input.name, 'The name'),
    brand: (input.brand ?? '').trim().slice(0, 80),
    model: (input.model ?? '').trim().slice(0, 80),
    specs: sanitizeSpecs(input.kind, input.specs),
    telescopeId: checkTelescope(input.telescopeId),
    notes: (input.notes ?? '').slice(0, 2000),
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  stmts.insertItem.run({ ...item, specsJson: JSON.stringify(item.specs) });
  return item;
}

export function updateGear(id: string, patch: GearItemInput): GearItem {
  const existing = getGear(id);
  if (!existing) throw new GearError('NOT_FOUND', 'Gear not found');
  const kind = patch.kind ?? existing.kind;
  const next: GearItem = {
    ...existing,
    kind,
    name: patch.name === undefined ? existing.name : cleanName(patch.name, 'The name'),
    brand: patch.brand === undefined ? existing.brand : patch.brand.trim().slice(0, 80),
    model: patch.model === undefined ? existing.model : patch.model.trim().slice(0, 80),
    // A kind change re-validates the old specs against the new kind, so figures that no longer belong are dropped.
    specs: sanitizeSpecs(kind, patch.specs === undefined ? existing.specs : patch.specs),
    telescopeId: patch.telescopeId === undefined ? existing.telescopeId : checkTelescope(patch.telescopeId),
    notes: patch.notes === undefined ? existing.notes : patch.notes.slice(0, 2000),
    updatedAt: new Date().toISOString(),
  };
  stmts.updateItem.run({ ...next, specsJson: JSON.stringify(next.specs) });
  return next;
}

export function setGearArchived(id: string, archived: boolean): GearItem {
  const existing = getGear(id);
  if (!existing) throw new GearError('NOT_FOUND', 'Gear not found');
  const next: GearItem = { ...existing, archivedAt: archived ? new Date().toISOString() : null, updatedAt: new Date().toISOString() };
  stmts.updateItem.run({ ...next, specsJson: JSON.stringify(next.specs) });
  return next;
}

/** Deleting gear also takes it off every packing list, so a kit never names something that is gone. */
export function deleteGear(id: string): boolean {
  const removed = db.transaction(() => {
    const ok = stmts.deleteItem.run(id).changes > 0;
    if (!ok) return false;
    for (const kit of stmts.kits.all().map(toKit)) {
      if (kit.itemIds.includes(id)) {
        stmts.updateKit.run({
          id: kit.id, name: kit.name, siteId: kit.siteId, extraItemsJson: JSON.stringify(kit.extraItems),
          itemIdsJson: JSON.stringify(kit.itemIds.filter((x) => x !== id)), updatedAt: new Date().toISOString(),
        });
      }
    }
    return true;
  })();
  return removed;
}

// ─── Kits ───────────────────────────────────────────────────────────

export interface GearKitInput {
  name?: string;
  itemIds?: string[];
  extraItems?: string[];
  siteId?: string | null;
}

function cleanKit(input: GearKitInput, base?: GearKit): Pick<GearKit, 'name' | 'itemIds' | 'extraItems' | 'siteId'> {
  const name = input.name === undefined ? base?.name ?? '' : input.name.trim().slice(0, 80);
  if (name === '') throw new GearError('INVALID', 'The kit needs a name');
  const itemIds = [...new Set(input.itemIds ?? base?.itemIds ?? [])];
  if (itemIds.length > MAX_KIT_ITEMS) throw new GearError('INVALID', `A kit holds at most ${MAX_KIT_ITEMS} items`);
  const extraItems = (input.extraItems ?? base?.extraItems ?? []).map((x) => x.trim().slice(0, 100)).filter((x) => x !== '');
  if (extraItems.length > MAX_EXTRA_ITEMS) throw new GearError('INVALID', `A kit holds at most ${MAX_EXTRA_ITEMS} extra lines`);
  return { name, itemIds, extraItems, siteId: input.siteId === undefined ? base?.siteId ?? null : input.siteId };
}

export function listKits(): GearKit[] {
  return stmts.kits.all().map(toKit);
}

export function getKit(id: string): GearKit | null {
  const r = stmts.kit.get(id);
  return r ? toKit(r) : null;
}

export function createKit(input: GearKitInput): GearKit {
  const now = new Date().toISOString();
  const kit: GearKit = { id: randomUUID(), ...cleanKit(input), createdAt: now, updatedAt: now };
  stmts.insertKit.run({ ...kit, itemIdsJson: JSON.stringify(kit.itemIds), extraItemsJson: JSON.stringify(kit.extraItems) });
  return kit;
}

export function updateKit(id: string, patch: GearKitInput): GearKit {
  const existing = getKit(id);
  if (!existing) throw new GearError('NOT_FOUND', 'Kit not found');
  const kit: GearKit = { ...existing, ...cleanKit(patch, existing), updatedAt: new Date().toISOString() };
  stmts.updateKit.run({ ...kit, itemIdsJson: JSON.stringify(kit.itemIds), extraItemsJson: JSON.stringify(kit.extraItems) });
  return kit;
}

export function deleteKit(id: string): boolean {
  return db.transaction(() => {
    stmts.deleteKitChecks.run(id);
    return stmts.deleteKit.run(id).changes > 0;
  })();
}

// ─── Packing checks ─────────────────────────────────────────────────

const NIGHT = /^\d{4}-\d{2}-\d{2}$/;

export function getChecks(kitId: string, night: string): string[] {
  if (!NIGHT.test(night)) throw new GearError('INVALID', 'Nights look like 2026-10-08');
  return stmts.checks.all(kitId, night).map((r) => r.itemKey);
}

/** Tick or untick one line. Ticks older than 30 days are dropped as they are no longer of use. */
export function setCheck(kitId: string, night: string, itemKey: string, checked: boolean, now: Date = new Date()): string[] {
  if (!NIGHT.test(night)) throw new GearError('INVALID', 'Nights look like 2026-10-08');
  if (!getKit(kitId)) throw new GearError('NOT_FOUND', 'Kit not found');
  const key = itemKey.trim().slice(0, 200);
  if (key === '') throw new GearError('INVALID', 'Which line?');
  if (checked) stmts.check.run(kitId, night, key, now.toISOString());
  else stmts.uncheck.run(kitId, night, key);
  const cutoff = new Date(now.getTime() - CHECK_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  stmts.pruneChecks.run(cutoff);
  return getChecks(kitId, night);
}

export function clearChecks(kitId: string, night: string): void {
  if (!NIGHT.test(night)) throw new GearError('INVALID', 'Nights look like 2026-10-08');
  stmts.clearChecks.run(kitId, night);
}
