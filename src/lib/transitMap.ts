/**
 * A transit band drawn around the site, for a small map with no tiles (it works offline): positions become kilometres
 * east and north of the site (an equirectangular projection, exact enough over a hundred kilometres).
 */
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_AT_EQUATOR = 111.32;

export interface LocalPoint { x: number; y: number }

/** Kilometres east (x) and north (y) of the origin. */
export function toLocalKm(origin: { lat: number; lon: number }, p: { lat: number; lon: number }): LocalPoint {
  return {
    x: (p.lon - origin.lon) * KM_PER_DEG_LON_AT_EQUATOR * Math.cos((origin.lat * Math.PI) / 180),
    y: (p.lat - origin.lat) * KM_PER_DEG_LAT,
  };
}

/** A round scale-bar length (1, 2, 5, 10, 20, 50… km) about a quarter of the map's width. */
export function scaleBarKm(spanKm: number): number {
  const target = spanKm / 4;
  const pow = 10 ** Math.floor(Math.log10(Math.max(target, 0.1)));
  for (const step of [1, 2, 5, 10]) if (step * pow >= target) return step * pow;
  return 10 * pow;
}
