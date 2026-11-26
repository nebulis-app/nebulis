/**
 * The Moon's geocentric position, precise enough for an ISS transit (Meeus, Astronomical Algorithms, 2nd ed., chapter
 * 47: the ELP-2000/82 series truncated to its main terms, about 10" in longitude and 4" in latitude).
 *
 * SunCalc's Moon, used everywhere else in Nebulis, is good to a fraction of a degree, which is plenty for "is the Moon
 * up". A transit band is a few kilometres wide: at the ISS's distance a tenth of a degree moves it by a kilometre or
 * more, so it needs this. The tests hold it to Skyfield's DE421 Moon.
 *
 * The series runs on Terrestrial Time; UTC is converted with the current leap seconds (37 since 2017) plus the fixed
 * 32.184 s. Ignoring that minute would put the Moon 35" off.
 */

/** TT − UTC, seconds: 37 leap seconds (since 2017-01-01) + 32.184. */
const TT_MINUS_UTC_S = 69.184;
const RAD = Math.PI / 180;

// [D, M, M', F, Σl coefficient, Σr coefficient] — Meeus table 47.A.
const LR: readonly (readonly [number, number, number, number, number, number])[] = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258], [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354], [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421], [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0], [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
];

// [D, M, M', F, Σb coefficient] — Meeus table 47.B.
const B: readonly (readonly [number, number, number, number, number])[] = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833], [0, 0, 1, -3, 777], [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607], [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421], [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351], [4, 0, 0, 1, 331], [2, -1, 1, 1, 315], [2, -2, 0, -1, 302],
  [0, 0, 1, 3, -283], [2, 1, 1, -1, -229], [1, 1, 0, -1, 223], [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220], [2, 1, -1, -1, -220], [1, 0, 1, 1, -185], [2, -1, -2, -1, 181],
  [0, 1, 2, 1, -177], [4, 0, -2, -1, 176], [4, -1, -1, -1, 166], [1, 0, 1, -1, -164],
  [4, 0, 1, -1, 132], [1, 0, -1, -1, -119], [4, -1, 0, -1, 115], [2, -2, 0, 1, 107],
];

export interface MoonPosition {
  /** Ecliptic longitude (true, with nutation) and latitude of date, degrees. */
  longitude: number;
  latitude: number;
  /** Centre of the Earth to centre of the Moon, km. */
  distanceKm: number;
  /** The same as a vector in SGP4's TEME frame (true equator, mean equinox of date), the ISS's frame, km. */
  x: number;
  y: number;
  z: number;
}

const norm360 = (d: number) => ((d % 360) + 360) % 360;

export function moonPosition(date: Date): MoonPosition {
  const jde = (date.getTime() + TT_MINUS_UTC_S * 1000) / 86_400_000 + 2440587.5;
  const T = (jde - 2451545.0) / 36525;
  const T2 = T * T;
  const T3 = T2 * T;
  const T4 = T3 * T;
  const Lp = norm360(218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000);
  const D = norm360(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000);
  const M = norm360(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000);
  const Mp = norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000);
  const F = norm360(93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000);
  const A1 = norm360(119.75 + 131.849 * T);
  const A2 = norm360(53.09 + 479264.290 * T);
  const A3 = norm360(313.45 + 481266.484 * T);
  // The Earth's orbit's eccentricity shrinks: terms with the Sun's anomaly are scaled by E per power of M.
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const eFactor = (m: number) => (Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1);

  let sl = 0;
  let sr = 0;
  for (const [d, m, mp, f, l, r] of LR) {
    const arg = (d * D + m * M + mp * Mp + f * F) * RAD;
    const e = eFactor(m);
    sl += l * e * Math.sin(arg);
    sr += r * e * Math.cos(arg);
  }
  let sb = 0;
  for (const [d, m, mp, f, b] of B) {
    sb += b * eFactor(m) * Math.sin((d * D + m * M + mp * Mp + f * F) * RAD);
  }
  sl += 3958 * Math.sin(A1 * RAD) + 1962 * Math.sin((Lp - F) * RAD) + 318 * Math.sin(A2 * RAD);
  sb += -2235 * Math.sin(Lp * RAD) + 382 * Math.sin(A3 * RAD) + 175 * Math.sin((A1 - F) * RAD)
    + 175 * Math.sin((A1 + F) * RAD) + 127 * Math.sin((Lp - Mp) * RAD) - 115 * Math.sin((Lp + Mp) * RAD);

  // Nutation (Meeus 22, its four main terms: about 0.5"), so the position is in the true equator of date, the one the
  // ISS's SGP4 positions use.
  const omega = norm360(125.04452 - 1934.136261 * T) * RAD;
  const Lsun = norm360(280.4665 + 36000.7698 * T) * RAD;
  const Lmoon = norm360(218.3165 + 481267.8813 * T) * RAD;
  const dPsi = (-17.20 * Math.sin(omega) - 1.32 * Math.sin(2 * Lsun) - 0.23 * Math.sin(2 * Lmoon) + 0.21 * Math.sin(2 * omega)) / 3600;
  const dEps = (9.20 * Math.cos(omega) + 0.57 * Math.cos(2 * Lsun) + 0.10 * Math.cos(2 * Lmoon) - 0.09 * Math.cos(2 * omega)) / 3600;

  const longitude = norm360(Lp + sl / 1e6 + dPsi);
  const latitude = sb / 1e6;
  const distanceKm = 385000.56 + sr / 1000;
  // True obliquity of date (Meeus 22.2 to T², plus nutation in obliquity).
  const eps = (23.43929111 - 0.013004167 * T - 0.0000001639 * T2 + dEps) * RAD;
  const lam = longitude * RAD;
  const bet = latitude * RAD;
  const cx = Math.cos(bet) * Math.cos(lam);
  const cy = Math.cos(bet) * Math.sin(lam);
  const cz = Math.sin(bet);
  // True equator and equinox of date...
  const tx = cx;
  const ty = cy * Math.cos(eps) - cz * Math.sin(eps);
  const tz = cy * Math.sin(eps) + cz * Math.cos(eps);
  // ...turned about the pole by the equation of the equinoxes, to SGP4's TEME (true equator, mean equinox).
  const eqEq = -dPsi * Math.cos(eps) * RAD;
  const ex = tx * Math.cos(eqEq) - ty * Math.sin(eqEq);
  const ey = tx * Math.sin(eqEq) + ty * Math.cos(eqEq);
  return {
    longitude,
    latitude,
    distanceKm,
    x: distanceKm * ex,
    y: distanceKm * ey,
    z: distanceKm * tz,
  };
}
