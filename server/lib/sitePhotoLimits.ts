/**
 * Upload limits for observing-site pictures.
 *
 * Kept apart from sitePhotos.ts so the published OpenAPI schema can read the
 * caption limit without importing the database, sharp or DATA_DIR.
 */
export const SITE_PHOTO_LIMITS = {
  /** Per site. */
  photos: 40,
  bytes: 30 * 1024 * 1024,
  caption: 300,
  fileName: 200,
} as const;
