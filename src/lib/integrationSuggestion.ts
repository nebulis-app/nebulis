/**
 * Suggested integration goals for one object.
 *
 * Pure logic: answers "how many hours should I plan on this object, and how
 * should they be split across filters?". Returns numbers and stable keys only;
 * the explanatory copy lives in `src/locales/<lang>/library.json` under
 * `objectDetail.integrationSection.suggest`, resolved by
 * `src/components/objectDetail/IntegrationSuggestionPanel.tsx`.
 *
 * The model, its constants and the reasoning behind each are written up in
 * the private integration-goals notes. Keep the two in step: a constant
 * changed here without its rationale changed there is a bug.
 *
 *   totalHours = base(brightness) × type × skyMoon(bortle, moon, band) × tier
 *
 * It is a planning heuristic, not a measurement. Every input is something the
 * app already knows about the object (catalog type, magnitude, size), the
 * user's active site (Bortle class) or a choice the user makes in the panel
 * (rig, moon plan, tier). It is per object by design: nothing here depends on
 * a date, so the answer does not change from night to night.
 */
import { filterRecommendations, type FilterRecommendationKey } from './filterRecommendations';
import { bandForFilterName } from './filterBands';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Which gear the plan is for; picks the column of `filterRecommendations`. */
export type SuggestionRig = 'color' | 'mono';

/**
 * How much the Moon is allowed to cost.
 *   'dark'  — shoot only when the Moon is down or far away: no Moon penalty,
 *             at the price of fewer usable nights.
 *   'mixed' — shoot most nights, skipping the worst of it (default).
 *   'any'   — ignore the Moon entirely.
 */
export type MoonPlan = 'dark' | 'mixed' | 'any';

/** Ambition. Time buys signal-to-noise as a square root, so the steps double. */
export type GoalTier = 'standard' | 'deep' | 'showpiece';

/** How hard the object is to image, from its mean surface brightness. */
export type BrightnessClass = 'bright' | 'moderate' | 'faint' | 'very-faint';

/**
 * What the telescope can shoot through, so the plan only names filters that exist.
 *
 * Two sources with different weight. A custom rig's list is its owner's whole
 * inventory (`inventory: true`): a filter recommended but not on it is dropped
 * or replaced. A smart telescope's list is only the names it has used, which
 * says nothing about what else it could take, so it names buckets and never
 * removes any. An empty list always means "not said", never "owns nothing".
 */
export interface RigKit {
  filters: readonly string[];
  inventory: boolean;
}

export interface SuggestionInput {
  /** Catalog type string, e.g. "Emission Nebula". */
  objectType: string | null | undefined;
  /** Integrated visual magnitude, when the catalog has one. */
  magnitude?: number | null;
  /** Major axis in arcminutes, when the catalog has one. */
  majorAxisArcmin?: number | null;
  /** Bortle class 1–9 of the observing site; null when unknown. */
  bortle?: number | null;
  rig: SuggestionRig;
  /** Omitted: assume every filter in the recommendation is available. */
  kit?: RigKit | null;
  moon: MoonPlan;
  tier: GoalTier;
}

export interface SuggestedFilter {
  /** Canonical filter name as the library stores it, or null for "no filter" /
   *  a single catch-all bucket (colour rigs). */
  filter: string | null;
  hours: number;
}

export interface SuggestionBasis {
  brightness: BrightnessClass;
  /** `'surface-brightness'` when computed from magnitude and size,
   *  `'type-default'` when the catalog lacked one of them. */
  brightnessSource: 'surface-brightness' | 'type-default';
  /** Mean surface brightness in mag/arcsec², when computed. */
  surfaceBrightness: number | null;
  band: 'narrowband' | 'broadband';
  /** What the plan actually uses, which differs from `requested` when the kit lacked the filters. */
  recommendation: FilterRecommendationKey;
  /** What the object type calls for with no regard to the kit. */
  requested: FilterRecommendationKey;
  /** True when the kit could not do what the type calls for and the plan fell back to something it can. */
  fellBack: boolean;
  /** Filters the type calls for that the kit lacks, as the library names them ("OIII"), or "dual-band". */
  missing: string[];
  /** The Bortle class actually used. */
  bortle: number;
  /** True when the input had none and the reference class was substituted. */
  bortleAssumed: boolean;
  factors: {
    base: number;
    type: number;
    sky: number;
    moon: number;
    tier: number;
  };
}

export interface IntegrationSuggestion {
  totalHours: number;
  filters: SuggestedFilter[];
  basis: SuggestionBasis;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const MOON_PLANS: readonly MoonPlan[] = ['dark', 'mixed', 'any'];
export const GOAL_TIERS: readonly GoalTier[] = ['standard', 'deep', 'showpiece'];

/** The Bortle class every base figure is written for. */
export const REFERENCE_BORTLE = 4;

/**
 * Base hours at the reference sky, dark Moon, standard tier, for the
 * recommended filter set as a whole (not per filter).
 */
export const BASE_HOURS: Readonly<Record<BrightnessClass, number>> = {
  'bright': 2,
  'moderate': 4,
  'faint': 8,
  'very-faint': 14,
};

/** Upper edges (mag/arcsec², exclusive) of the brightness classes. Larger
 *  numbers are fainter. Anything past the last edge is 'very-faint'. */
const BRIGHTNESS_EDGES: ReadonlyArray<readonly [number, BrightnessClass]> = [
  [21.0, 'bright'],
  [22.5, 'moderate'],
  [24.0, 'faint'],
];

/** Representative zenith sky brightness (SQM, mag/arcsec²) per Bortle class. */
const BORTLE_SQM: Readonly<Record<number, number>> = {
  1: 21.9, 2: 21.8, 3: 21.5, 4: 21.0, 5: 20.0, 6: 19.2, 7: 18.7, 8: 18.2, 9: 17.8,
};

/**
 * Extra sky flux the Moon adds, in units of the reference (Bortle 4) sky.
 * 'any' is roughly a half Moon at a typical separation (about 19.5 mag/arcsec²,
 * four times the reference sky); 'mixed' avoids the worst of it.
 */
const MOON_EXTRA_FLUX: Readonly<Record<MoonPlan, number>> = { dark: 0, mixed: 1, any: 4 };

/**
 * Exponent applied to the relative sky flux. Time to a given SNR grows with
 * sky flux when sky-limited (exponent 1) and not at all when signal-limited
 * (exponent 0); 0.5 sits between them for broadband. A narrowband filter
 * passes a few percent of the sky continuum, so the object stays closer to
 * signal- and read-noise-limited: half the exponent.
 */
const SKY_EXPONENT = { broadband: 0.5, narrowband: 0.25 } as const;

/** Bounds on the combined sky-and-Moon factor. Beyond the ceiling more hours
 *  stop being a sensible answer and a different filter or site is. */
const SKY_FACTOR_MIN = 0.6;
const SKY_FACTOR_MAX = 3;

const TIER_FACTOR: Readonly<Record<GoalTier, number>> = { standard: 1, deep: 2, showpiece: 4 };

/** Bounds on the suggested total, in hours. */
const MIN_TOTAL_HOURS = 1;
const MAX_TOTAL_HOURS = 40;
const HOUR_STEP = 0.5;

/** Smallest size treated as real; catalog sizes below this are noise. */
const MIN_SIZE_ARCMIN = 0.5;

/** Star-dominated types: there is no faint structure to dig out, so they
 *  reach a clean result in about half the time. */
const STELLAR_TYPE_FACTOR = 0.5;

// ─── Type profile ────────────────────────────────────────────────────────────

interface TypeProfile {
  /** Brightness class to fall back on when magnitude or size is missing. */
  defaultBrightness: BrightnessClass;
  factor: number;
}

/** First match wins, like filterRecommendations.ts; more specific rules first. */
const TYPE_PROFILES: ReadonlyArray<{
  match: readonly string[];
  all?: boolean;
  profile: TypeProfile;
}> = [
  { match: ['cluster', 'nebula'], all: true, profile: { defaultBrightness: 'moderate', factor: 1 } },
  { match: ['globular', 'open cluster', 'star cloud', 'star association', 'double star'],
    profile: { defaultBrightness: 'bright', factor: STELLAR_TYPE_FACTOR } },
  { match: ['planetary'], profile: { defaultBrightness: 'bright', factor: 1 } },
  { match: ['supernova'], profile: { defaultBrightness: 'faint', factor: 1 } },
  { match: ['dark'], profile: { defaultBrightness: 'faint', factor: 1 } },
  { match: ['galaxy'], profile: { defaultBrightness: 'faint', factor: 1 } },
  { match: ['nebula'], profile: { defaultBrightness: 'moderate', factor: 1 } },
];

const FALLBACK_PROFILE: TypeProfile = { defaultBrightness: 'moderate', factor: 1 };

function typeProfile(objectType: string | null | undefined): TypeProfile {
  const type = (objectType ?? '').toLowerCase();
  for (const rule of TYPE_PROFILES) {
    const hit = rule.all ? rule.match.every(m => type.includes(m)) : rule.match.some(m => type.includes(m));
    if (hit) return rule.profile;
  }
  return FALLBACK_PROFILE;
}

// ─── Filter split ────────────────────────────────────────────────────────────

/** How the total divides across filters, per recommendation key. Canonical
 *  names match `BUILTIN_ALIASES` in server/lib/library/integration.ts, so a
 *  goal set here lands on the same row as the frames. */
const SPLITS: Readonly<Record<FilterRecommendationKey, ReadonlyArray<readonly [string | null, number]>>> = {
  'no-filter': [[null, 1]],
  'no-filter-lrgb': [[null, 1]],
  'ha-dual': [[null, 1]],
  'lrgb': [['L', 0.5], ['R', 1 / 6], ['G', 1 / 6], ['B', 1 / 6]],
  'luminance': [['L', 0.5], ['R', 1 / 6], ['G', 1 / 6], ['B', 1 / 6]],
  'ha-oiii': [['Ha', 0.5], ['OIII', 0.5]],
  'oiii-ha': [['OIII', 0.6], ['Ha', 0.4]],
  'sho': [['Ha', 0.4], ['OIII', 0.3], ['SII', 0.3]],
};

const NARROWBAND_KEYS: ReadonlySet<FilterRecommendationKey> = new Set(['ha-dual', 'ha-oiii', 'oiii-ha', 'sho']);

type Split = ReadonlyArray<readonly [string | null, number]>;

const LINE_ALIASES: Readonly<Record<string, string>> = {
  ha: 'Ha', halpha: 'Ha', 'hα': 'Ha', hydrogenalpha: 'Ha',
  oiii: 'OIII', o3: 'OIII', oxygen: 'OIII',
  sii: 'SII', s2: 'SII', sulfur: 'SII', sulphur: 'SII',
  l: 'L', lum: 'L', luminance: 'L',
  r: 'R', red: 'R', g: 'G', green: 'G', b: 'B', blue: 'B',
};

/**
 * The single line or colour a filter name stands for ("Ha 7nm" is Ha), or null
 * for anything else, including multi-band filters. Matches the names the
 * library stores (`BUILTIN_ALIASES` in server/lib/library/integration.ts).
 */
export function filterLine(name: string): string | null {
  const tokens = name
    .toLowerCase()
    .replace(/h[\s-]?alpha/g, 'halpha')
    .split(/[\s_/,+()-]+/)
    .filter(t => t !== '' && !/^\d+(\.\d+)?(nm|mm|")?$/.test(t));
  if (tokens.length === 0) return null;
  const lines = new Set(tokens.map(t => LINE_ALIASES[t] ?? null));
  return lines.size === 1 ? [...lines][0] : null;
}

/** A filter that passes more than one narrow band (L-eXtreme, Duo-Band, ...), as opposed to a single line. */
function isMultiBand(name: string): boolean {
  return bandForFilterName(name) === 'narrowband' && filterLine(name) === null;
}

function renormalise(split: Split): Split {
  const total = split.reduce((sum, [, share]) => sum + share, 0);
  return total > 0 ? split.map(([name, share]) => [name, share / total] as const) : split;
}

interface Plan {
  key: FilterRecommendationKey;
  split: Split;
  fellBack: boolean;
  missing: string[];
}

const BROADBAND_FALLBACK: Plan = { key: 'no-filter-lrgb', split: [[null, 1]], fellBack: true, missing: [] };

/**
 * Turn what the object type calls for into what this kit can do.
 *
 * Colour camera: one bucket. A narrowband plan needs a multi-band or Ha filter
 * and takes its name; with an inventory that has neither, it falls back to
 * broadband. Mono: only the lines owned are planned, the shares renormalised;
 * with none of them it falls back to the owned broadband filters, then to a
 * single unnamed bucket.
 */
function resolvePlan(requested: FilterRecommendationKey, rig: SuggestionRig, kit: RigKit | null | undefined): Plan {
  const declared = SPLITS[requested];
  const names = kit?.filters ?? [];
  const asked: Plan = { key: requested, split: declared, fellBack: false, missing: [] };
  if (names.length === 0) return asked;

  if (rig === 'color') {
    if (!NARROWBAND_KEYS.has(requested)) return asked;
    const chosen = names.find(isMultiBand)
      ?? names.find(n => filterLine(n) === 'Ha')
      // A telescope's own used names only decide what to call the bucket.
      ?? (kit?.inventory ? undefined : names.find(n => bandForFilterName(n) === 'narrowband'));
    if (chosen) return { ...asked, split: [[chosen, 1]] };
    return kit?.inventory ? { ...BROADBAND_FALLBACK, missing: ['dual-band'] } : asked;
  }

  if (!kit?.inventory) return asked;
  const owned = new Set(names.map(filterLine).filter((x): x is string => x !== null));
  const wanted = declared.map(([name]) => name).filter((n): n is string => n !== null);
  const missing = wanted.filter(n => !owned.has(n));
  const kept = declared.filter(([name]) => name !== null && owned.has(name));
  if (kept.length > 0) return { ...asked, split: renormalise(kept), missing };

  if (NARROWBAND_KEYS.has(requested)) {
    const broadband = SPLITS.lrgb.filter(([name]) => name !== null && owned.has(name));
    if (broadband.length > 0) return { key: 'lrgb', split: renormalise(broadband), fellBack: true, missing };
  }
  return { ...BROADBAND_FALLBACK, missing };
}

// ─── Model ───────────────────────────────────────────────────────────────────

/**
 * Mean surface brightness in mag/arcsec², treating the object as a disc whose
 * diameter is its major axis. The catalog has no minor axis, so elongated
 * objects come out slightly fainter than they are; the class edges are wide
 * enough that this rarely changes the class. Null when either input is
 * missing or not a positive number.
 */
export function meanSurfaceBrightness(
  magnitude: number | null | undefined,
  majorAxisArcmin: number | null | undefined,
): number | null {
  if (typeof magnitude !== 'number' || !Number.isFinite(magnitude)) return null;
  if (typeof majorAxisArcmin !== 'number' || !Number.isFinite(majorAxisArcmin) || majorAxisArcmin <= 0) return null;
  const diameterArcsec = Math.max(majorAxisArcmin, MIN_SIZE_ARCMIN) * 60;
  const areaArcsec2 = (Math.PI / 4) * diameterArcsec * diameterArcsec;
  return magnitude + 2.5 * Math.log10(areaArcsec2);
}

export function brightnessClassFor(surfaceBrightness: number): BrightnessClass {
  for (const [edge, cls] of BRIGHTNESS_EDGES) {
    if (surfaceBrightness < edge) return cls;
  }
  return 'very-faint';
}

/** Sky flux of a Bortle class relative to the reference class. Out-of-range
 *  or fractional input is clamped and rounded to a real class first. */
function relativeSkyFlux(bortle: number): number {
  return 10 ** (0.4 * (BORTLE_SQM[REFERENCE_BORTLE] - BORTLE_SQM[bortle]));
}

function normaliseBortle(bortle: number | null | undefined): { value: number; assumed: boolean } {
  if (typeof bortle !== 'number' || !Number.isFinite(bortle)) return { value: REFERENCE_BORTLE, assumed: true };
  return { value: Math.min(9, Math.max(1, Math.round(bortle))), assumed: false };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const roundToStep = (hours: number) => Math.round(hours / HOUR_STEP) * HOUR_STEP;

/**
 * Divide a total (a multiple of HOUR_STEP) across filters in whole steps by
 * largest remainder, so the buckets add up to the total the model produced
 * instead of drifting by a rounding step per filter. A bucket never drops
 * below one step; on a very small total that can push the sum a step or two
 * over, which is preferable to a goal of 0 (0 removes the goal on save).
 */
function splitHours(
  totalHours: number,
  split: ReadonlyArray<readonly [string | null, number]>,
): SuggestedFilter[] {
  const totalSteps = Math.round(totalHours / HOUR_STEP);
  const exact = split.map(([, share]) => share * totalSteps);
  const steps = exact.map(Math.floor);
  let leftover = totalSteps - steps.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((value, i) => ({ i, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (const { i } of byRemainder) {
    if (leftover <= 0) break;
    steps[i] += 1;
    leftover -= 1;
  }
  return split.map(([filter], i) => ({ filter, hours: Math.max(1, steps[i]) * HOUR_STEP }));
}

export function suggestIntegration(input: SuggestionInput): IntegrationSuggestion {
  const profile = typeProfile(input.objectType);
  const requested = filterRecommendations(input.objectType)[input.rig];
  const plan = resolvePlan(requested, input.rig, input.kit);
  const recommendation = plan.key;
  const band = NARROWBAND_KEYS.has(recommendation) ? 'narrowband' : 'broadband';

  const sb = meanSurfaceBrightness(input.magnitude, input.majorAxisArcmin);
  const brightness = sb === null ? profile.defaultBrightness : brightnessClassFor(sb);

  const { value: bortle, assumed: bortleAssumed } = normaliseBortle(input.bortle);
  const skyFlux = relativeSkyFlux(bortle);
  const exponent = SKY_EXPONENT[band];
  const skyFactor = clamp(skyFlux ** exponent, SKY_FACTOR_MIN, SKY_FACTOR_MAX);
  const combinedFactor = clamp((skyFlux + MOON_EXTRA_FLUX[input.moon]) ** exponent, SKY_FACTOR_MIN, SKY_FACTOR_MAX);
  // Reported separately so the panel can show each, but the product is the
  // clamped combined factor, so the moon share never double-counts the cap.
  const moonFactor = combinedFactor / skyFactor;

  const base = BASE_HOURS[brightness];
  const tier = TIER_FACTOR[input.tier];
  const rawTotal = clamp(base * profile.factor * combinedFactor * tier, MIN_TOTAL_HOURS, MAX_TOTAL_HOURS);

  const filters = splitHours(roundToStep(rawTotal), plan.split);

  return {
    totalHours: filters.reduce((sum, f) => sum + f.hours, 0),
    filters,
    basis: {
      brightness,
      brightnessSource: sb === null ? 'type-default' : 'surface-brightness',
      surfaceBrightness: sb,
      band,
      recommendation,
      requested,
      fellBack: plan.fellBack,
      missing: plan.missing,
      bortle,
      bortleAssumed,
      factors: { base, type: profile.factor, sky: skyFactor, moon: moonFactor, tier },
    },
  };
}
