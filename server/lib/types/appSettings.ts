// Single source of truth for every enum-valued app setting. Both the route
// layer (Zod validation, OpenAPI schema) and the lib layer (DB read/write
// coercion in telescopes.ts) import from here, so a new value only needs to
// be added once instead of drifting across hand-copied unions.
export const GALLERY_IMAGE_SOURCES = ['sky-survey', 'telescope'] as const;
export type GalleryImageSource = (typeof GALLERY_IMAGE_SOURCES)[number];

export const PREFERRED_CATALOGS = ['default', 'caldwell'] as const;
export type PreferredCatalog = (typeof PREFERRED_CATALOGS)[number];

/** Narrows a DB column / request body value to the union. Takes `unknown` so
 *  the same guard covers both the TEXT column read and the settings-patch
 *  write, neither of which is typed on the way in. */
export function isPreferredCatalog(value: unknown): value is PreferredCatalog {
  return typeof value === 'string' && (PREFERRED_CATALOGS as readonly string[]).includes(value);
}

export const TEMPERATURE_UNITS = ['celsius', 'fahrenheit'] as const;
export type TemperatureUnit = (typeof TEMPERATURE_UNITS)[number];

export const WIND_SPEED_UNITS = ['mph', 'kmh'] as const;
export type WindSpeedUnit = (typeof WIND_SPEED_UNITS)[number];
