/**
 * Narrowband sky plates for faint emission nebulae.
 *
 * The DSS2 plate is red-sensitive photographic film. A faint HII region on it is
 * often a brown smudge or nothing, which is why about half of the Sharpless
 * pictures in the published packs showed a star field. The VPHAS+ survey (ESO,
 * VST telescope, CC BY 4.0) images the southern Galactic plane through an
 * H-alpha filter and shows the same nebulae as clear red clouds.
 *
 * VPHAS+ only covers part of the sky, with missing tiles and uneven edges, so a
 * plate is used only when it comes back whole; anything else falls back to DSS2.
 * IPHAS (the northern counterpart) was tried and rejected: its bands are not
 * combined on the server and a hand-made composite came out in blocks.
 */
import sharp from 'sharp';
import { analyzeImage, qualityProblems } from './imageQuality.js';

export const NARROWBAND_SURVEYS = ['vphas'] as const;
export type NarrowbandSurvey = (typeof NARROWBAND_SURVEYS)[number];

export const SURVEY_CREDITS: Record<NarrowbandSurvey, { credit: string; licenseUrl: string }> = {
  vphas: {
    credit: 'Based on data from the VST Photometric H-alpha Survey of the Southern Galactic Plane and Bulge (VPHAS+), ESO. CC BY 4.0.',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
};

const HIPS_HOSTS = ['alasky.cds.unistra.fr', 'alaskybis.cds.unistra.fr', 'alasky.u-strasbg.fr'];
const HIPS_ID: Record<NarrowbandSurvey, string> = { vphas: 'CDS/P/VPHAS/DR4/color' };

export interface PlateRequest {
  /** Degrees. */
  ra: number;
  dec: number;
  /** Field of view in degrees. */
  fovDeg: number;
  width?: number;
  height?: number;
}

/**
 * The colour cast of the sky background, taken out (VPHAS+ and DSS2 plates alike). VPHAS+ combines filters
 * with different sky levels, so the plate comes back violet or green. Each
 * channel's median (the sky) is moved to the same dark neutral grey; the
 * nebula and the stars sit above the sky and keep their colour.
 */
export async function neutraliseBackground(input: Buffer, target: number | 'keep' | 'dark' = 14): Promise<Buffer> {
  const { data, info } = await sharp(input).removeAlpha().resize(160, 107, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const medians = [0, 1, 2].map(c => {
    const hist = new Uint32Array(256);
    for (let p = 0; p < n; p++) hist[data[p * 3 + c]]++;
    let seen = 0;
    for (let v = 0; v < 256; v++) { seen += hist[v]; if (seen >= n / 2) return v; }
    return 0;
  });
  // 'keep' removes the tint without changing how dark the sky is (a photographic
  // plate's sky is already dark; lifting it would wash the picture out).
  // 'dark' is for photographic plates: no tint, and a sky no lighter than 10, but a plate that is
  // already darker keeps its own darkness.
  const mean = Math.round(medians.reduce((a, b) => a + b, 0) / 3);
  const level = target === 'keep' ? mean : target === 'dark' ? Math.min(10, mean) : target;
  return sharp(input).removeAlpha().linear([1, 1, 1], medians.map(m => level - m)).jpeg({ quality: 90 }).toBuffer();
}

/**
 * Share of the picture made of large, grain-free, non-dark blocks. A survey
 * tile that was never filled in (a pale diamond, a block of one colour) has no
 * grain; real sky and nebulosity always do.
 */
export async function flatBrightShare(input: Buffer): Promise<number> {
  const { data, info } = await sharp(input).removeAlpha().resize(960, 640, { fit: 'fill', kernel: 'nearest' }).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const B = 16;
  let flat = 0;
  let total = 0;
  for (let by = 0; by + B <= H; by += B) {
    for (let bx = 0; bx + B <= W; bx += B) {
      let sum = 0;
      let sq = 0;
      for (let y = 0; y < B; y++) {
        for (let x = 0; x < B; x++) {
          const i = ((by + y) * W + bx + x) * 3;
          const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
          sum += l;
          sq += l * l;
        }
      }
      const n = B * B;
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
      total++;
      if (sd < 0.9 && mean > 12) flat++;
    }
  }
  return total > 0 ? flat / total : 0;
}

/** One plate from the survey, or null when the survey has none for this spot. */
export async function fetchNarrowbandPlate(
  survey: NarrowbandSurvey,
  req: PlateRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer | null> {
  const query = `?hips=${encodeURIComponent(HIPS_ID[survey])}&width=${req.width ?? 1920}&height=${req.height ?? 1280}`
    + `&fov=${req.fovDeg}&ra=${req.ra}&dec=${req.dec}&projection=TAN&format=jpg`;
  for (const host of HIPS_HOSTS) {
    try {
      const res = await fetchImpl(`https://${host}/hips-image-services/hips2fits${query}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) continue;
      const raw = Buffer.from(await res.arrayBuffer());
      const stats = await analyzeImage(raw);
      // Missing tiles come back as flat white, flat black or a flat green block.
      if (qualityProblems(stats).some(p => p === 'notch' || p === 'blank')) return null;
      if ((await flatBrightShare(raw)) >= 0.05) return null;
      return await neutraliseBackground(raw);
    } catch {
      /* next host */
    }
  }
  return null;
}
