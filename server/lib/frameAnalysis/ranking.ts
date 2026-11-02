/**
 * Turns each frame's measurements into a verdict by comparing it with the rest of its night: what counts as few
 * stars, soft stars or a bright sky is whatever this night's typical frame shows, so a hazy night is not all marked
 * bad. A port of the macOS app's `FrameRanking`; the thresholds are meant to agree.
 *
 * Reasons are returned as a code plus the numbers behind it, never as a sentence. The server has no notion of the
 * client's language, and the web UI turns each one into text through its own translations.
 */
import { median, type FrameMetrics, type FrameSpot } from './measure.js';

export const FRAME_FLAGS = ['clouds', 'faint', 'trails', 'soft', 'streak', 'spots', 'noStars', 'noisy'] as const;
export type FrameFlag = typeof FRAME_FLAGS[number];
export type FrameGrade = 'good' | 'fair' | 'bad';

export type FrameReason =
  | { flag: 'noStars'; stars: number; typical: number }
  /** `percentDimmer`: how much less light the stars bring than in the night's best frames, when measured. */
  | { flag: 'clouds'; stars: number; typical: number; percentFewer: number; percentDimmer: number | null; brighterSky: boolean }
  /** `plain` is a stretch of 2:1 or more, which makes a frame bad. Less is a slight smear. */
  | { flag: 'trails'; ratio: number; angle: number | null; plain: boolean }
  | { flag: 'soft'; fwhm: number; typical: number }
  | { flag: 'streak'; angle: number }
  | { flag: 'noisy'; percentAbove: number }
  /**
   * Well below what this object's other nights gave (same filter and exposure): `percent` of their signal over noise,
   * and of how plainly the object itself showed when that was measured. `brighterSky` when the sky was brighter than
   * on those nights (Moon, twilight, haze lit from below).
   */
  | { flag: 'faint'; percent: number; targetPercent: number | null; brighterSky: boolean }
  /** Round shadows that the other frames do not share: dew or frost near the sensor, which flats taken another time do not correct. */
  | { flag: 'spots'; count: number; otherNights: boolean };

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
  /** Star flux of the set's better frames (90th percentile): what a clear frame brings in. Null when not measured. */
  signal: number | null;
  /** Point-source signal over noise of the set's better frames (90th percentile), see `pointSNR`. */
  snr: number | null;
  /**
   * The same, over this night and the object's other nights with the same filter and exposure: what a good night
   * gives. Null without other nights.
   */
  bestSnr?: number | null;
  /** How plainly the object shows in the better frames over all those nights (90th percentile). */
  bestTarget?: number | null;
  /** Frames of other nights this was compared with. */
  otherFrames?: number;
  /** Median noise of those frames. */
  otherNoise?: number | null;
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
    signal: quantile(nums(m => m.signal), 0.9),
    snr: quantile(nums(pointSNR), 0.9),
    weak: all.length < 5,
  };
}

/**
 * How well a frame records faint point sources: the stars' flux over the noise of an aperture their size
 * (background-limited photometry: noise grows with the aperture's width). Transparency, sky brightness and seeing all
 * move it, in the proportion they cost the stack.
 */
export function pointSNR(m: FrameMetrics): number | null {
  return m.signal !== null && m.signal > 0 && m.fwhm !== null && m.fwhm > 0 && m.noise > 0 ? m.signal / (m.noise * m.fwhm) : null;
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * The verdict on one frame against its set.
 *
 * The score is the frame's point-source signal over noise as a share of the set's better frames (90th percentile),
 * so 100 is as good as this night gets and 70 is a frame that brings 70 % of the signal to noise of those. It is
 * docked further for stretched stars, which the stack keeps, and a little for a streak, which rejection usually
 * takes out. Each finding is reported on its own, with the numbers behind it.
 */
/** What other frames say about one frame's spots. */
export interface SpotContext {
  /** Spots seen on most of the comparison frames: dust, or a dark patch of the field itself. */
  persistent: FrameSpot[];
  /** Whether the comparison is with other nights (true) or only with this night's other frames. */
  otherNights: boolean;
}

export function verdictFor(m: FrameMetrics, ref: FrameReference, spotContext: SpotContext | null = null): FrameVerdict {
  const flags: FrameFlag[] = [];
  const reasons: FrameReason[] = [];
  let severe = false;

  const typicalStars = Math.round(ref.stars);
  const starRatio = ref.stars >= 8 ? m.starCount / ref.stars : 1;
  const signalRatio = m.signal !== null && ref.signal !== null && ref.signal > 0 ? m.signal / ref.signal : null;
  const brighterSky = ref.noise > 0 && (m.background - ref.background) / ref.noise > 6;
  if (m.starCount < 5 && ref.stars >= 8) {
    flags.push('noStars'); severe = true;
    reasons.push({ flag: 'noStars', stars: m.starCount, typical: typicalStars });
  } else if (!ref.weak && ((signalRatio !== null && signalRatio < 0.65) || starRatio < 0.55)) {
    // Thin cloud, haze or dew dims every star by the same share, which the stars' flux shows at once; the star
    // count only falls once the faint ones sink into the noise, far later.
    const dimmed = signalRatio !== null && signalRatio < 0.65;
    flags.push('clouds');
    if (starRatio < 0.55 || (signalRatio !== null && signalRatio < 0.4)) severe = true;
    reasons.push({
      flag: 'clouds', stars: m.starCount, typical: typicalStars,
      percentFewer: Math.max(0, Math.round((1 - starRatio) * 100)),
      percentDimmer: dimmed ? Math.round((1 - signalRatio) * 100) : null,
      // Cloud lit from below also brightens the sky.
      brighterSky,
    });
  }

  if (m.elongation !== null) {
    const e = m.elongation;
    if ((e >= 1.3 && e > ref.elongation + 0.12) || e >= 1.5) {
      flags.push('trails');
      // At 1.6 the stars are plainly oval in the stack; below that it is a slight smear.
      const plain = e >= 1.6;
      if (plain) severe = true;
      reasons.push({ flag: 'trails', ratio: e, angle: m.orientation, plain });
    }
  }

  if (m.fwhm !== null && ref.fwhm > 0 && m.fwhm > ref.fwhm * 1.25 && !flags.includes('clouds')) {
    flags.push('soft');
    reasons.push({ flag: 'soft', fwhm: m.fwhm, typical: ref.fwhm });
  }

  if (m.streak !== null) {
    flags.push('streak');
    reasons.push({ flag: 'streak', angle: m.streak.angle });
  }

  if (ref.noise > 0 && m.noise > ref.noise * 1.3 && !flags.includes('noStars')) {
    flags.push('noisy');
    reasons.push({ flag: 'noisy', percentAbove: Math.round((m.noise / ref.noise - 1) * 100) });
  }

  const snr = pointSNR(m);
  // Against the object's other nights: a night that is poor all through (a full Moon, dew from the start) looks
  // fine against itself.
  if (snr !== null && ref.bestSnr != null && ref.bestSnr > 0 && !flags.includes('clouds') && !flags.includes('noStars')) {
    const share = snr / ref.bestSnr;
    if (share < 0.6) {
      flags.push('faint');
      if (share < 0.35) severe = true;
      const targetShare = m.target && ref.bestTarget != null && ref.bestTarget > 0 ? m.target.snr / ref.bestTarget : null;
      reasons.push({
        flag: 'faint', percent: Math.round(share * 100),
        targetPercent: targetShare === null ? null : Math.max(0, Math.round(targetShare * 100)),
        brighterSky: ref.otherNoise != null && ref.otherNoise > 0 && m.noise > ref.otherNoise * 1.3,
      });
    }
  }

  const fresh = spotContext ? newSpots(m.spots, spotContext.persistent) : [];
  if (fresh.length > 0) {
    flags.push('spots');
    reasons.push({ flag: 'spots', count: fresh.length, otherNights: spotContext!.otherNights });
  }

  const unit = (x: number): number => Math.min(Math.max(x, 0), 1);
  let quality: number;
  const yardstick = Math.max(ref.snr ?? 0, ref.bestSnr ?? 0);
  if (snr !== null && yardstick > 0) {
    quality = unit(snr / yardstick);
  } else {
    // Not enough stars measured for a flux: fall back on what the set says about count, width and noise.
    const sharp = m.fwhm !== null && m.fwhm > 0 && ref.fwhm > 0 ? unit(ref.fwhm / m.fwhm) : 0.6;
    const quiet = m.noise > 0 && ref.noise > 0 ? unit(ref.noise / m.noise) : 0.6;
    quality = unit(starRatio) * sharp * quiet;
  }
  const e = m.elongation ?? 1;
  const round = e <= 1.2 ? 1 : Math.max(0.3, 1 - (e - 1.2) * 0.8);
  let score = 100 * quality * round;
  if (flags.includes('streak')) score *= 0.9;
  if (flags.includes('spots')) score *= 0.85;
  if (flags.includes('noStars')) score = 0;
  const rounded = Math.round(Math.min(Math.max(score, 0), 100));

  let grade: FrameGrade;
  if (severe || rounded < 50) grade = 'bad';
  else if (rounded < 75 || flags.length > 0) grade = 'fair';
  else grade = 'good';
  return { score: rounded, grade, flags, reasons };
}

/** Spots of `spots` with no spot of `known` near them (within half the larger of the two, plus two blocks). */
function newSpots(spots: FrameSpot[], known: FrameSpot[]): FrameSpot[] {
  return spots.filter(s => !known.some(k => Math.hypot(s.x - k.x, s.y - k.y) <= Math.max(s.diameter, k.diameter) / 2 + 16));
}

/**
 * Spots that most of `frames` share (at least `share` of them): dust that stays put, or a dark patch of the field.
 * Each frame's spots are matched against the others'; one representative is kept per place.
 */
export function persistentSpots(frames: FrameMetrics[], share: number): FrameSpot[] {
  if (frames.length === 0) return [];
  const out: FrameSpot[] = [];
  for (const f of frames) {
    for (const s of f.spots) {
      if (out.some(o => Math.hypot(o.x - s.x, o.y - s.y) <= Math.max(o.diameter, s.diameter) / 2 + 16)) continue;
      const seen = frames.filter(o => o.spots.some(t => Math.hypot(t.x - s.x, t.y - s.y) <= Math.max(t.diameter, s.diameter) / 2 + 16)).length;
      if (seen >= frames.length * share) out.push(s);
    }
  }
  return out;
}

const MIN_HISTORY = 10;

/**
 * A mosaic points somewhere new every frame, and the stars differ field to field (a dusty field shows fewer), so a
 * frame is judged against the ones taken within about a degree of it. Without pointing, or with too few neighbours,
 * it is judged against the whole night, which is the right yardstick for one target.
 *
 * `history` is the object's frames from other nights with the same filter and exposure, when there are any. With
 * enough of them the score is against the better of this night and those, so a night that was poor all through
 * (a full Moon, dew from the start) no longer scores as if it were a good one; and a spot is only reported when
 * those nights did not have it, so dust that stays put and dark patches of the field are left alone.
 */
export function rankFrames(metrics: FrameMetrics[], history: FrameMetrics[] = []): { verdicts: FrameVerdict[]; reference: FrameReference | null } {
  if (metrics.length === 0) return { verdicts: [], reference: null };
  const withHistory = history.length >= MIN_HISTORY;
  const all = withHistory ? [...metrics, ...history] : metrics;
  const bestSnr = withHistory ? quantile(all.map(pointSNR).filter((v): v is number => v !== null), 0.9) : null;
  const bestTarget = withHistory ? quantile(all.flatMap(m => (m.target ? [m.target.snr] : [])), 0.9) : null;
  const otherNoise = withHistory ? median(history.map(m => m.noise)) : null;
  const extend = (r: FrameReference): FrameReference => ({ ...r, bestSnr, bestTarget, otherNoise, otherFrames: withHistory ? history.length : 0 });

  // Dust stays where it is from night to night; dew and frost near the sensor come and go. With other nights, a spot
  // is new when those nights mostly did not have it. Without, only a spot that this night's frames mostly lack is.
  const spotContext: SpotContext | null = withHistory
    ? { persistent: persistentSpots(history, 0.3), otherNights: true }
    : metrics.length >= MIN_HISTORY ? { persistent: persistentSpots(metrics, 0.5), otherNights: false } : null;

  const global = extend(referenceFor(metrics));
  const located = metrics.filter(m => m.ra !== null && m.dec !== null);
  const verdicts = metrics.map(m => {
    if (m.ra === null || m.dec === null || located.length < MIN_NEIGHBOURS) return verdictFor(m, global, spotContext);
    const ra = m.ra, dec = m.dec;
    const near = located.filter(o => {
      if (o.ra === null || o.dec === null) return false;
      let dra = Math.abs(ra - o.ra);
      if (dra > 180) dra = 360 - dra;
      const dx = dra * Math.cos(dec * Math.PI / 180), dy = dec - o.dec;
      return Math.hypot(dx, dy) <= NEIGHBOUR_RADIUS_DEG;
    });
    return near.length >= MIN_NEIGHBOURS ? verdictFor(m, extend(referenceFor(near)), spotContext) : verdictFor(m, global, spotContext);
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
