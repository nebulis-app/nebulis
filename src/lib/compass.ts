const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type CompassPoint = (typeof COMPASS)[number];

/** One of eight compass points for an azimuth in degrees (north 0, east 90); the names come from the locale files. */
export function compassKey(azimuth: number): CompassPoint {
  return COMPASS[Math.round((((azimuth % 360) + 360) % 360) / 45) % 8];
}
