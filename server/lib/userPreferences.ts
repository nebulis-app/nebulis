/**
 * User preferences data access helpers.
 *
 * Encapsulates all direct DB access for the userPreferences table so route
 * handlers do not reach for db.prepare() themselves.
 */
import { z } from 'zod';
import db from './db.js';

// Mirrors src/lib/api/auth.ts's WatermarkPreset — kept in sync manually across
// the client/server boundary, same as every other API-contract type in this app.
//
// Read side stays deliberately loose: `getWatermarkPresets` DROPS entries that
// fail this schema, so a required new field would silently delete every preset
// saved before it existed. x/y/sizePct are the geometry added after the first
// release; absent values mean "preset from before the geometry" and the editor
// applies its old fixed position and pixel size.
export const WatermarkPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  text: z.string(),
  fontSize: z.number(),
  fontFamily: z.string(),
  color: z.string(),
  bold: z.boolean(),
  italic: z.boolean(),
  opacity: z.number(),
  align: z.enum(['left', 'center', 'right']),
  angle: z.number(),
  /** Font size as a fraction of the rendered picture height. */
  sizePct: z.number().optional(),
  /** 0–1 anchor on the rendered canvas. */
  x: z.number().optional(),
  y: z.number().optional(),
});
export type WatermarkPreset = z.infer<typeof WatermarkPresetSchema>;

export const MAX_WATERMARK_PRESETS = 50;
export const MAX_WATERMARK_NAME = 40;
export const MAX_WATERMARK_TEXT = 2000;

/**
 * What a PUT is allowed to store. Stricter than the read schema on purpose: the
 * write path is the only place that can put bad numbers into the column, and a
 * rejected write is cheaper to explain than a preset that draws off-canvas.
 * Geometry stays optional so an older client (or a client still loaded in a
 * tab) can keep saving presets the pre-feature way.
 */
const WatermarkPresetInputSchema = WatermarkPresetSchema.extend({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(MAX_WATERMARK_NAME),
  text: z.string().min(1).max(MAX_WATERMARK_TEXT),
  fontSize: z.number().min(1).max(1000),
  fontFamily: z.string().min(1).max(120),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  opacity: z.number().min(0).max(100),
  angle: z.number().min(-90).max(90),
  sizePct: z.number().gt(0).lte(1).optional(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
});

/** The whole array, because PUT replaces it. Names are unique per user, case-insensitively. */
export const WatermarkPresetsBodySchema = z.array(WatermarkPresetInputSchema)
  .max(MAX_WATERMARK_PRESETS)
  .superRefine((presets, ctx) => {
    const names = new Set<string>();
    const ids = new Set<string>();
    presets.forEach((preset, index) => {
      const nameKey = preset.name.replace(/\s+/g, ' ').toLowerCase();
      if (names.has(nameKey)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate watermark name "${preset.name}"`,
          path: [index, 'name'],
        });
      }
      names.add(nameKey);
      if (ids.has(preset.id)) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate watermark id', path: [index, 'id'] });
      }
      ids.add(preset.id);
    });
  });

interface WatermarkPresetRow {
  watermarkPresets: string;
}

const getWatermarkPresetsStmt = db.prepare<[string], WatermarkPresetRow>(
  'SELECT watermarkPresets FROM userPreferences WHERE userId = ?',
);

const upsertWatermarkPresetsStmt = db.prepare<[string, string]>(`
  INSERT INTO userPreferences (userId, watermarkPresets, updatedAt)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(userId) DO UPDATE
    SET watermarkPresets = excluded.watermarkPresets,
        updatedAt        = excluded.updatedAt
`);

/**
 * Return the saved watermark presets for the given user.
 * Returns an empty array when no presets have been saved yet. Entries that no
 * longer match WatermarkPresetSchema (hand-edited DB row, older app version)
 * are dropped rather than served raw to the client.
 */
export function getWatermarkPresets(userId: string): WatermarkPreset[] {
  const row = getWatermarkPresetsStmt.get(userId);
  if (!row) return [];
  const parsed: unknown = JSON.parse(row.watermarkPresets);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((p): p is WatermarkPreset => WatermarkPresetSchema.safeParse(p).success);
}

/**
 * Persist the full watermark presets array for the given user, replacing
 * any previously saved value.
 */
export function setWatermarkPresets(userId: string, presets: WatermarkPreset[]): void {
  upsertWatermarkPresetsStmt.run(userId, JSON.stringify(presets));
}

// ─── Release-notes dismissal (lastSeenVersion) ──────────────────────────────
// Used by the "What's New" auto-popup: the frontend compares the user's
// lastSeenVersion to /meta/version on app load and shows the modal when they
// differ. "Got it" updates this column; "Remind me later" leaves it alone.

interface LastSeenVersionRow {
  lastSeenVersion: string | null;
}

const getLastSeenVersionStmt = db.prepare<[string], LastSeenVersionRow>(
  'SELECT lastSeenVersion FROM userPreferences WHERE userId = ?',
);

const upsertLastSeenVersionStmt = db.prepare<[string, string]>(`
  INSERT INTO userPreferences (userId, lastSeenVersion, updatedAt)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(userId) DO UPDATE
    SET lastSeenVersion = excluded.lastSeenVersion,
        updatedAt       = excluded.updatedAt
`);

/** Return the version the user last acknowledged in the What's New popup, or
 *  null if they've never seen it. NULL on first-ever login surfaces the
 *  modal the first time they sign in. */
export function getLastSeenVersion(userId: string): string | null {
  const row = getLastSeenVersionStmt.get(userId);
  return row?.lastSeenVersion ?? null;
}

/** Mark `version` as acknowledged for this user. Idempotent. */
export function setLastSeenVersion(userId: string, version: string): void {
  upsertLastSeenVersionStmt.run(userId, version);
}
