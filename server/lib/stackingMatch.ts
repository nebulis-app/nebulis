/**
 * Calibration matching for a stacking export — pure, no filesystem or database.
 *
 * Given the light frames of one or more nights (already grouped by night,
 * filter, exposure, gain and binning) and every calibration bundle in the
 * Calibration Library, picks for each light group:
 *
 *   - darks: same exposure, gain and binning; sensor temperature within
 *     DARK_TEMP_TOLERANCE_C of the lights. Preferred: the session's own
 *     telescope, not expired, closest temperature, more frames, newer.
 *   - flats: a bundle attached to the session (or the whole object) for this
 *     filter first; otherwise a flat bundle for the same filter and binning
 *     shot during the same observing night; otherwise the nearest one in time
 *     for that filter, flagged, since flats only hold for the optical train's
 *     state when they were shot.
 *   - flat darks: attached first, else same exposure, gain and binning as the
 *     picked flats, closest in time.
 *   - bias: same gain and binning. Only required when the flats have no flat
 *     darks, but included whenever found (stackers use it for the flats).
 *
 * "Same" for a setting means equal when both sides know it: a field missing
 * from a filename or header never blocks a match on its own (that is how the
 * Calibration Library groups bundles too).
 */

export type CalType = 'bias' | 'dark' | 'flat' | 'flatDark';

/** One calibration bundle, flattened from the Calibration Library. */
export interface CalCandidate {
  type: CalType;
  scope: string | null;
  folderName: string;
  key: string;
  /** Human-facing bundle name, e.g. `Darks_180s_Bin1_gain200_-10C`. */
  name: string;
  exposureSec: number | null;
  gain: number | null;
  binning: number | null;
  sensorTempC: number | null;
  /** Most common filter label among the bundle's files (flats). */
  filter: string | null;
  capturedAt: string | null;
  isExpired: boolean;
  fileCount: number;
  bytes: number;
}

export interface LightGroupInput {
  night: string;
  filter: string | null;
  exposureSec: number | null;
  gain: number | null;
  binning: number | null;
  /** Median of the group's frames. */
  sensorTempC: number | null;
  /** Telescope that captured the night, when known. */
  scope: string | null;
}

export interface CalPick {
  candidate: CalCandidate;
  source: 'attached' | 'matched';
  /** Dark: |light − dark| temperature. */
  deltaTempC?: number;
  /** Flats / flat darks: days between the night and the bundle. */
  deltaDays?: number;
}

export type IssueCode =
  | 'no_dark'
  | 'dark_temp_far'
  | 'dark_expired'
  | 'no_flat'
  | 'flat_other_night'
  | 'no_flat_calibration'
  | 'bias_expired'
  | 'unknown_settings';

export interface MatchIssue {
  code: IssueCode;
  /** 'error' leaves a hole in the calibration; 'warning' is usable but worth a look. */
  severity: 'error' | 'warning';
  /** Values for the message (temperature gap, days, bundle name…). */
  params?: Record<string, string | number>;
}

export interface GroupMatch {
  dark: CalPick | null;
  flat: CalPick | null;
  flatDark: CalPick | null;
  bias: CalPick | null;
  issues: MatchIssue[];
}

export const DARK_TEMP_TOLERANCE_C = 2;

const sameExposure = (a: number | null, b: number | null) =>
  a === null || b === null || Math.abs(a - b) <= Math.max(0.01, 0.005 * Math.max(a, b));
const sameSetting = (a: number | null, b: number | null) => a === null || b === null || a === b;
const normFilter = (f: string | null) => (f ?? '').trim().toLowerCase() || null;

/** Noon of the night's date to noon two days later, local time — covers dusk
 *  flats, dawn flats and flats shot the next afternoon. */
function nightWindow(night: string): [number, number] {
  const start = new Date(`${night}T12:00:00`).getTime();
  return [start, start + 36 * 3600_000];
}

function daysFromNight(night: string, capturedAt: string | null): number | null {
  if (!capturedAt) return null;
  const t = new Date(capturedAt).getTime();
  if (Number.isNaN(t)) return null;
  const [start, end] = nightWindow(night);
  if (t >= start && t <= end) return 0;
  const gap = t < start ? start - t : t - end;
  return Math.max(1, Math.round(gap / 86_400_000));
}

/** Lower is better; compared lexicographically. */
type Score = number[];
function best<T>(items: T[], score: (t: T) => Score): T | null {
  let winner: T | null = null;
  let winnerScore: Score = [];
  for (const it of items) {
    const s = score(it);
    if (winner === null || compare(s, winnerScore) < 0) { winner = it; winnerScore = s; }
  }
  return winner;
}
function compare(a: Score, b: Score): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const timeScore = (c: CalCandidate) => -(c.capturedAt ? new Date(c.capturedAt).getTime() : 0);

export function pickDark(group: LightGroupInput, all: CalCandidate[]): { pick: CalPick | null; issues: MatchIssue[] } {
  const settings = all.filter(c =>
    c.type === 'dark'
    && sameExposure(c.exposureSec, group.exposureSec)
    && sameSetting(c.gain, group.gain)
    && sameSetting(c.binning, group.binning));
  const delta = (c: CalCandidate) =>
    c.sensorTempC === null || group.sensorTempC === null ? 0 : Math.abs(c.sensorTempC - group.sensorTempC);
  const inTolerance = settings.filter(c => delta(c) <= DARK_TEMP_TOLERANCE_C);

  if (inTolerance.length === 0) {
    const nearest = best(settings, c => [delta(c)]);
    return {
      pick: null,
      issues: nearest
        ? [{ code: 'dark_temp_far', severity: 'error', params: { bundle: nearest.name, delta: round1(delta(nearest)) } }]
        : [{ code: 'no_dark', severity: 'error' }],
    };
  }
  const chosen = best(inTolerance, c => [
    group.scope && c.scope !== group.scope ? 1 : 0,
    c.isExpired ? 1 : 0,
    round1(delta(c)),
    -c.fileCount,
    timeScore(c),
  ])!;
  const issues: MatchIssue[] = chosen.isExpired ? [{ code: 'dark_expired', severity: 'warning', params: { bundle: chosen.name } }] : [];
  return { pick: { candidate: chosen, source: 'matched', deltaTempC: round1(delta(chosen)) }, issues };
}

export function pickBias(group: LightGroupInput, all: CalCandidate[]): CalPick | null {
  const chosen = best(
    all.filter(c => c.type === 'bias' && sameSetting(c.gain, group.gain) && sameSetting(c.binning, group.binning)),
    c => [group.scope && c.scope !== group.scope ? 1 : 0, c.isExpired ? 1 : 0, timeScore(c), -c.fileCount],
  );
  return chosen ? { candidate: chosen, source: 'matched' } : null;
}

/**
 * Flats for the group's filter. `attached` are the bundles attached to this
 * session (or the whole object); one without a filter label is taken when
 * the night has a single filter, since nothing else could tell them apart.
 */
export function pickFlat(
  group: LightGroupInput,
  all: CalCandidate[],
  attached: CalCandidate[],
  nightFilterCount: number,
): { pick: CalPick | null; issues: MatchIssue[] } {
  const filter = normFilter(group.filter);
  const fits = (c: CalCandidate) => sameSetting(c.binning, group.binning)
    && (normFilter(c.filter) === filter || (c.filter === null && nightFilterCount <= 1));

  const att = best(attached.filter(c => c.type === 'flat' && fits(c)), c => [normFilter(c.filter) === filter ? 0 : 1, timeScore(c)]);
  if (att) {
    return { pick: { candidate: att, source: 'attached', deltaDays: daysFromNight(group.night, att.capturedAt) ?? undefined }, issues: [] };
  }

  // Unattached flats only match on an explicit filter label (or a lone
  // filter): guessing a filter for a mixed night would pair the wrong flats.
  const pool = all.filter(c => c.type === 'flat' && fits(c));
  const withDays = pool.map(c => ({ c, days: daysFromNight(group.night, c.capturedAt) }));
  const chosen = best(withDays, ({ c, days }) => [days === null ? 1e6 : days, timeScore(c)]);
  if (!chosen) return { pick: null, issues: [{ code: 'no_flat', severity: 'error', params: { filter: group.filter ?? '' } }] };
  const issues: MatchIssue[] = chosen.days === 0
    ? []
    : [{ code: 'flat_other_night', severity: 'warning', params: { bundle: chosen.c.name, days: chosen.days ?? '?' } }];
  return { pick: { candidate: chosen.c, source: 'matched', deltaDays: chosen.days ?? undefined }, issues };
}

export function pickFlatDark(flat: CalCandidate, night: string, all: CalCandidate[], attached: CalCandidate[]): CalPick | null {
  const fits = (c: CalCandidate) => c.type === 'flatDark'
    && sameExposure(c.exposureSec, flat.exposureSec)
    && sameSetting(c.gain, flat.gain)
    && sameSetting(c.binning, flat.binning);
  const dist = (c: CalCandidate) => daysFromNight(night, c.capturedAt) ?? 1e6;
  const att = best(attached.filter(fits), c => [dist(c), timeScore(c)]);
  if (att) return { candidate: att, source: 'attached', deltaDays: dist(att) };
  const chosen = best(all.filter(fits), c => [dist(c), timeScore(c)]);
  return chosen ? { candidate: chosen, source: 'matched', deltaDays: dist(chosen) } : null;
}

export function matchGroup(
  group: LightGroupInput,
  all: CalCandidate[],
  attached: CalCandidate[],
  nightFilterCount: number,
): GroupMatch {
  const issues: MatchIssue[] = [];
  if (group.exposureSec === null) issues.push({ code: 'unknown_settings', severity: 'warning' });

  const dark = pickDark(group, all);
  issues.push(...dark.issues);
  const flat = pickFlat(group, all, attached, nightFilterCount);
  issues.push(...flat.issues);
  const flatDark = flat.pick ? pickFlatDark(flat.pick.candidate, group.night, all, attached) : null;
  const bias = pickBias(group, all);

  if (flat.pick && !flatDark && !bias) issues.push({ code: 'no_flat_calibration', severity: 'error' });
  if (bias?.candidate.isExpired && !flatDark) issues.push({ code: 'bias_expired', severity: 'warning', params: { bundle: bias.candidate.name } });

  return { dark: dark.pick, flat: flat.pick, flatDark, bias, issues };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// Exported for tests.
export const _internal = { nightWindow, daysFromNight };