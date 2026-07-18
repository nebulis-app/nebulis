/**
 * Zod schemas for catalog pack index.json and per-tier manifest.json.
 *
 * index.json   — single file at downloads.nebulis.app/catalog/v1/index.json
 * manifest.json — one per tier, referenced by the index
 */

import { z } from 'zod';

export const CATALOG_TIERS = ['messier', 'caldwell', 'popular', 'extended', 'sharpless'] as const;
export type CatalogTier = (typeof CATALOG_TIERS)[number];
export function isCatalogTier(value: string): value is CatalogTier {
  return (CATALOG_TIERS as readonly string[]).includes(value);
}

// ─── index.json ─────────────────────────────────────────────────────────────

const IndexTierEntry = z.object({
  tier:            z.enum(CATALOG_TIERS),
  version:         z.string().min(1),
  archiveUrl:      z.string(),
  manifestUrl:     z.string(),
  manifestSigUrl:  z.string(),
  archiveSha256:   z.string().length(64),
  archiveBytes:    z.number().int().positive(),
  totalObjects:    z.number().int().positive(),
  minAppVersion:   z.string(),
  updatedAt:       z.string(),
});

export const PackIndex = z.object({
  schemaVersion: z.literal(1),
  generatedAt:   z.string(),
  tiers:         z.array(IndexTierEntry),
});

export type PackIndex = z.infer<typeof PackIndex>;
export type IndexTierEntry = z.infer<typeof IndexTierEntry>;

// ─── manifest.json ──────────────────────────────────────────────────────────

const ManifestFile = z.object({
  path:   z.string().min(1),
  sha256: z.string().length(64),
  bytes:  z.number().int().positive(),
});

export const PackManifest = z.object({
  tier:           z.enum(CATALOG_TIERS),
  version:        z.string().min(1),
  minAppVersion:  z.string(),
  totalBytes:     z.number().int().positive(),
  objectCount:    z.number().int().positive(),
  files:          z.array(ManifestFile),
  generatedAt:    z.string(),
});

export type PackManifest = z.infer<typeof PackManifest>;
export type ManifestFile = z.infer<typeof ManifestFile>;

// ─── descriptions.json (embedded in each pack) ──────────────────────────────

const DescriptionEntry = z.object({
  extract:   z.string(),
  sourceUrl: z.string(),
  source:    z.string(),
  status:    z.enum(['ok', 'not_found', 'error']),
});

export const PackDescriptions = z.record(z.string(), DescriptionEntry);
export type PackDescriptions = z.infer<typeof PackDescriptions>;
export type DescriptionEntry = z.infer<typeof DescriptionEntry>;

// ─── credits.json (embedded in each pack) ───────────────────────────────────

const CreditEntry = z.object({
  source:     z.enum(['hubble', 'dss2', 'nasa']),
  credit:     z.string(),
  licenseUrl: z.string(),
});

export const PackCredits = z.record(z.string(), CreditEntry);
export type PackCredits = z.infer<typeof PackCredits>;
