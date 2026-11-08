/**
 * Request and response shapes for the observing-site routes. They live here so
 * server/routes/openapi.ts can generate the published spec from the schemas the
 * handlers validate with (see telescopeSchemas.ts).
 *
 * The `Missing` checks at the bottom stop compiling when a field is added to
 * ObservingSite or SitePhoto and not to the response schema.
 */
import { z } from 'zod';
import { SKY_MAP_CELLS } from './skyMapConfig.js';
import { SITE_PHOTO_LIMITS } from './sitePhotoLimits.js';
import { DARKNESS_LEVELS, WINDOW_OFFSET_MAX, WINDOW_OFFSET_MIN } from './imagingWindow.js';
import type { ObservingSite } from './observingSites.js';
import type { SitePhoto } from './sitePhotos.js';

export const SiteBodySchema = z.object({
  name: z.string().min(1).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  timezone: z.string().optional().describe('IANA zone, e.g. America/Chicago'),
  minAlt: z.number().min(0).max(90).optional().describe('Minimum altitude in degrees for planner visibility'),
  horizonProfile: z.array(z.number()).length(36).optional()
    .describe('Blocked altitude per 10 degree azimuth bucket, 36 values'),
  visibleSkyMap: z.array(z.boolean()).length(SKY_MAP_CELLS).optional()
    .describe('32 azimuth slices by 8 elevation bands; true where the sky is visible. Omit to keep the stored mask'),
  bortleClass: z.number().int().min(1).max(9).nullable().optional(),
  darkness: z.enum(DARKNESS_LEVELS).optional()
    .describe('Imaging window: the twilight it starts from. Astronomical falls back to nautical where the sky never gets that dark'),
  windowStartOffsetMin: z.number().int().min(WINDOW_OFFSET_MIN).max(WINDOW_OFFSET_MAX).optional()
    .describe('Imaging window: minutes after that dusk the window opens; negative opens it earlier'),
  windowEndOffsetMin: z.number().int().min(WINDOW_OFFSET_MIN).max(WINDOW_OFFSET_MAX).optional()
    .describe('Imaging window: minutes before that dawn the window closes; negative closes it later'),
  isDefault: z.boolean().optional(),
});

/** The generic update cannot move the default: PUT /sites/{id}/default does that in one transaction. */
export const SiteUpdateSchema = SiteBodySchema.omit({ isDefault: true });

export const ActiveSiteBodySchema = z.object({
  siteId: z.string().nullable().describe('Site id, or null to clear the active site'),
});

export const SitePhotoCaptionBodySchema = z.object({
  caption: z.string().max(SITE_PHOTO_LIMITS.caption),
});

export const ObservingSiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  timezone: z.string(),
  minAlt: z.number(),
  horizonProfile: z.array(z.number()).length(36),
  visibleSkyMap: z.array(z.boolean()).describe('Empty when no mask has been drawn, which means the whole sky is visible'),
  bortleClass: z.number().int().nullable(),
  darkness: z.enum(DARKNESS_LEVELS).describe('Imaging window: the twilight it starts from'),
  windowStartOffsetMin: z.number().int().describe('Imaging window: minutes after dusk the window opens'),
  windowEndOffsetMin: z.number().int().describe('Imaging window: minutes before dawn the window closes'),
  isDefault: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  isTransient: z.boolean().optional()
    .describe('True for a site synthesized from ad-hoc client coordinates; never persisted'),
});

export const SitePhotoSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  caption: z.string(),
  createdAt: z.string(),
});

export const BortleLookupSchema = z.object({
  bortleClass: z.number().int().min(1).max(9),
  sqm: z.number().describe('Sky quality, magnitudes per square arcsecond'),
  source: z.enum(['cache', 'live']),
});

export const SiteDeletedSchema = z.object({ deleted: z.literal(true) });

export const SiteDeletedWithIdSchema = z.object({ deleted: z.literal(true), id: z.string() });

// ─── Compile-time coverage checks ──────────────────────────────────────────

type Missing<Type, Schema extends z.ZodType> = Exclude<keyof Type, keyof z.infer<Schema>>;
const siteFieldsDocumented: [Missing<ObservingSite, typeof ObservingSiteSchema>] extends [never] ? true : never = true;
const photoFieldsDocumented: [Missing<SitePhoto, typeof SitePhotoSchema>] extends [never] ? true : never = true;
void [siteFieldsDocumented, photoFieldsDocumented];
