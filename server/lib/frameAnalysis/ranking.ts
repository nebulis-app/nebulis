/**
 * Turns each frame's measurements into a verdict by comparing it with the rest of its night: what counts as few
 * stars, soft stars or a bright sky is whatever this night's typical frame shows, so a hazy night is not all marked
 * bad. A port of the macOS app's `FrameRanking`; the thresholds are meant to agree.
 *
 * Reasons are returned as a code plus the numbers behind it, never as a sentence. The server has no notion of the
 * client's language, and the web UI turns each one into text through its own translations.
 */
import { median, type FrameMetrics } from './measure.js';

export const FRAME_FLAGS = ['clouds', 'trails', 'soft', 'streak', 'noStars', 'noisy'] as const;
export type FrameFlag = typeof FRAME_FLAGS[number];
export type FrameGrade = 'good' | 'fair' | 'bad';

export type FrameReason =
  | { flag: 'noStars'; stars: number; typical: number }
  | { flag: 'clouds'; stars: number; typical: number; percentFewer: number; brighterSky: boolean }
  /** `plain` is a stretch of 2:1 or more, which makes a frame bad. Less is a slight smear. */
  | { flag: 'trails'; ratio: number; angle: number | null; plain: boolean }
  | { flag: 'soft'; fwhm: number; typical: number }
  | { flag: 'streak'; angle: number }
  | { flag: 'noisy'; percentAbove: number };

export interface FrameVerdict {
  score: number;
  grade: FrameGrade;
  flags: FrameFlag[];
  reasons: FrameReason[];
}

/** What a typical frame of the set looks like. */
export interface FrameReference {
  stars: number;
  fwhm: number;
  elongation: number;
  noise: number;
  background: number;
  /** Too few frames to trust a comparison with the set. */
  weak: boolean;
}

/**
 * How far apart two pointings may be and still count as the same part of the sky, and how many such frames a
 * comparison needs before it is better than the whole night's.
 */
const NEIGHBOUR_RADIUS_DEG = 1.0;
const MIN_NEIGHBOURS = 5;

export function referenceFor(all: FrameMetrics[]): FrameReference {
  // Frames that show nothing would drag the typical star count down and hide a cloudy night's decline.
  const seen = all.filter(m => m.starCount >= 5);
  const base = seen.length === 0 ? all : seen;
  const nums = (pick: (m: FrameMetrics) => number | null): number[] =>
    base.map(pick).filter((v): v is number => v !== null);
  return {
    stars: median(base.map(m => m.starCount)) ?? 0,
    fwhm: median(nums(m => m.fwhm)) ?? 3,
    elongation: median(nums(m => m.elongation)) ?? 1.1,
    noise: median(base.map(m => m.noise)) ?? 1,
    background: median(base.map(m => m.background)) ?? 0,
    weak: all.length < 5,
  };
}

export function verdictFor(m: FrameMetrics, ref: FrameReference): FrameVerdict {
  const flags: FrameFlag[] = [];
  const reasons: FrameReason[] = [];
  let severe = false;

  const typicalStars = Math.round(ref.stars);
  const ratio = ref.stars >= 8 ? m.starCount / ref.stars : 1;
  if (m.starCount < 5 && ref.stars >= 8) {
    flags.push('noStars'); severe = true;
    reasons.push({ flag: 'noStars', stars: m.starCount, typical: typicalStars });
  } else if (ratio < 0.55 && !ref.weak) {
    flags.push('clouds'); severe = true;
    reasons.push({
      flag: 'clouds', stars: m.starCount, typical: typicalStars,
      percentFewer: Math.round((1 - ratio) * 100),
      // Cloud lit from below also brightens the sky.
      brighterSky: ref.noise > 0 && (m.background - ref.background) / ref.noise > 6,
    });
  }

  if (m.elongation !== null) {
    const e = m.elongation;
    const relative = e >= 1.4 && e > ref.elongation + 0.2;
    if (relative || e >= 1.8) {
      flags.push('trails');
      // Under about 2:1 the smear is a pixel or so and hardly shows once frames are stacked; only a plain trail
      // makes a frame bad.
      const plain = e >= 2.0;
      if (plain) severe = true;
      reasons.push({ flag: 'trails', ratio: e, angle: m.orientation, plain });
    }
  }

  if (m.fwhm !== null && ref.fwhm > 0 && m.fwhm > ref.fwhm * 1.4 && m.fwhm > ref.fwhm + 0.8 && !flags.includes('clouds')) {
    flags.push('soft');
    reasons.push({ flag: 'soft', fwhm: m.fwhm, typical: ref.fwhm });
  }

  if (m.streak !== null) {
    flags.push('streak');
    reasons.push({ flag: 'streak', angle: m.streak.angle });
  }

  if (ref.noise > 0 && m.noise > ref.noise * 1.6 && !flags.includes('clouds') && !flags.includes('noStars')) {
    flags.push('noisy');
    reasons.push({ flag: 'noisy', percentAbove: Math.round((m.noise / ref.noise - 1) * 100) });
  }

  // The score is for ranking: how this frame compares with the night's typical one. Better than typical earns a
  // little above the line, so the best frames of a good night still separate from the rest.
  const unit = (x: number): number => Math.min(Math.max(x, 0), 1);
  const starPart = ref.stars >= 8 ? unit(ratio / 1.2) : 0.8;
  const sharpPart = m.fwhm !== null && m.fwhm > 0 && ref.fwhm > 0 ? unit(ref.fwhm / m.fwhm / 1.2) : 0.4;
  const roundPart = m.elongation !== null ? unit(1 - (m.elongation - 1) / 0.8) : 0.4;
  const noisePart = m.noise > 0 && ref.noise > 0 ? unit(ref.noise / m.noise / 1.2) : 0.6;
  let score = 100 * (0.40 * starPart + 0.25 * sharpPart + 0.20 * roundPart + 0.15 * noisePart);
  if (flags.includes('streak')) score -= 20;
  if (flags.includes('clouds')) score -= 15;
  if (flags.includes('noStars')) score = 0;
  const rounded = Math.round(Math.min(Math.max(score, 0), 100));

  let grade: FrameGrade;
  if (severe || rounded < 45) grade = 'bad';
  else if (rounded < 65 || flags.length > 0) grade = 'fair';
  else grade = 'good';
  return { score: rounded, grade, flags, reasons };
}

/**
 * A mosaic points somewhere new every frame, and the stars differ field to field (a dusty field shows fewer), so a
 * frame is judged against the ones taken within about a degree of it. Without pointing, or with too few neighbours,
 * it is judged against the whole night, which is the right yardstick for one target.
 */
export function rankFrames(metrics: FrameMetrics[]): { verdicts: FrameVerdict[]; reference: FrameReference | null } {
  if (metrics.length === 0) return { verdicts: [], reference: null };
  const global = referenceFor(metrics);
  const located = metrics.filter(m => m.ra !== null && m.dec !== null);
  const verdicts = metrics.map(m => {
    if (m.ra === null || m.dec === null || located.length < MIN_NEIGHBOURS) return verdictFor(m, global);
    const ra = m.ra, dec = m.dec;
    const near = located.filter(o => {
      if (o.ra === null || o.dec === null) return false;
      let dra = Math.abs(ra - o.ra);
      if (dra > 180) dra = 360 - dra;
      const dx = dra * Math.cos(dec * Math.PI / 180), dy = dec - o.dec;
      return Math.hypot(dx, dy) <= NEIGHBOUR_RADIUS_DEG;
    });
    return near.length >= MIN_NEIGHBOURS ? verdictFor(m, referenceFor(near)) : verdictFor(m, global);
  });
  return { verdicts, reference: global };
}

/**
 * Whether a frame belongs in a stack. The user's call (`'keep'` / `'reject'`) wins; otherwise a frame is kept unless
 * the analyzer graded it bad. A frame that has not been measured has no grade against it, so it is kept.
 */
export function isFrameKept(review: 'keep' | 'reject' | null, verdict: FrameVerdict | null): boolean {
  if (review) return review === 'keep';
  return verdict?.grade !== 'bad';
}
