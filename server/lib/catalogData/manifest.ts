/**
 * Zod schema for the catalog data manifest: the signed description of the baked name catalog and planner target list that the iOS and
 * Android apps download for standalone mode (see `build.ts`).
 *
 * Published at downloads.nebulis.app/catalog/v1/data/manifest.json (+ .sig); the files sit beside it under `<version>/`.
 */

import { z } from 'zod';

/** Bumped when the layout of either baked file changes in a way an older app cannot read; apps ignore a manifest with a higher number. */
export const CATALOG_DATA_FORMAT = 1;

export const CATALOG_DATA_FILES = ['catalog-bundle.json.deflate', 'planner-targets.json.deflate'] as const;

const DataFile = z.object({
  path:   z.enum(CATALOG_DATA_FILES),
  sha256: z.string().length(64),
  bytes:  z.number().int().positive(),
});

export const CatalogDataManifest = z.object({
  kind:          z.literal('catalog-data'),
  formatVersion: z.number().int().positive(),
  /** First 12 hex of sha256(bundle JSON, "\n", planner JSON), both uncompressed. The apps compute the same from their bundled copy. */
  version:       z.string().regex(/^[0-9a-f]{12}$/),
  generatedAt:   z.string(),
  minAppVersion: z.string(),
  plannerTargets: z.number().int().positive(),
  files:         z.array(DataFile).length(CATALOG_DATA_FILES.length),
});

export type CatalogDataManifest = z.infer<typeof CatalogDataManifest>;
