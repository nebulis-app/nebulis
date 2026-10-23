/**
 * Weather on the night, kept for the logbook.
 *
 * Every forecast the server builds is also a record of what a night was
 * predicted to be like. `recordNightConditions` keeps the sunset-to-sunrise
 * hours of the current observing night, merging across fetches so each hour
 * ends up with the newest value we saw for it. Seeing and transparency come
 * from 7Timer, which has no history, so they can only ever be captured this way.
 *
 * Deliberately free of imports from forecastCache.ts (which calls this): the
 * caller hands in the hours and the night-rating function.
 */
import SunCalc from 'suncalc';
import db from './db.js';
import { addDaysToDateKey, timeZoneOrLocal, zonedDateTimeToUtc } from './timezone.js';
import { observingNightDateKey } from './telescopeFiles.js';
import type { ForecastHour } from './forecastCache.js';

export type NightConditionsSource = 'forecast' | 'archive';

export interface NightConditions {
  siteKey: string;
  night: string;
  source: NightConditionsSource;
  hours: ForecastHour[];
  avgCloud: number;
  maxWind: number;
  /** Smallest temperature minus dew point across the dark hours, in °C. */
  minDewGap: number;
  avgHumidity: number;
  medianSeeing: number | null;
  moonIllum: number;
  darkHours: number;
  nightScore: number;
  fetchedAt: string;
}

/** The hours either side of sunset and sunrise that are kept, so dusk and dawn show on the chart. */
const PAD_MS = 45 * 60 * 1000;

interface NightWindow {
  sunset: Date;
  sunrise: Date;
  /** Astronomical dark, else nautical, else sunset to sunrise. */
  coreStart: Date;
  coreEnd: Date;
  darkHours: number;
  middle: Date;
}

function valid(d: Date | undefined): Date | null {
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** Sunset to sunrise of the night that begins on `night` (yyyy-MM-dd) at this place. */
export function nightWindow(night: string, lat: number, lon: number, timeZone: string): NightWindow | null {
  const tz = timeZoneOrLocal(timeZone);
  const today = SunCalc.getTimes(zonedDateTimeToUtc(night, { hour: 12 }, tz), lat, lon);
  const next = SunCalc.getTimes(zonedDateTimeToUtc(addDaysToDateKey(night, 1), { hour: 12 }, tz), lat, lon);
  const sunset = valid(today.sunset);
  const sunrise = valid(next.sunrise);
  if (!sunset || !sunrise || sunrise <= sunset) return null;

  const astroStart = valid(today.night), astroEnd = valid(next.nightEnd);
  const hasAstro = astroStart !== null && astroEnd !== null && astroEnd > astroStart;
  const nauticalStart = valid(today.nauticalDusk), nauticalEnd = valid(next.nauticalDawn);
  const hasNautical = nauticalStart !== null && nauticalEnd !== null && nauticalEnd > nauticalStart;
  let coreStart = sunset, coreEnd = sunrise, darkHours = 0;
  if (hasAstro) {
    coreStart = astroStart; coreEnd = astroEnd;
    darkHours = (astroEnd.getTime() - astroStart.getTime()) / 3600000;
  } else if (hasNautical) {
    coreStart = nauticalStart; coreEnd = nauticalEnd;
  }
  return {
    sunset, sunrise, coreStart, coreEnd,
    darkHours: Math.round(darkHours * 10) / 10,
    middle: new Date((sunset.getTime() + sunrise.getTime()) / 2),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** One hour per timestamp; for a repeated hour the later entry wins, but never loses a seeing value it lacks. */
export function mergeHours(older: ForecastHour[], newer: ForecastHour[]): ForecastHour[] {
  const byTime = new Map<string, ForecastHour>();
  for (const h of older) byTime.set(h.time, h);
  for (const h of newer) {
    const prior = byTime.get(h.time);
    byTime.set(h.time, prior
      ? { ...h, seeing: h.seeing ?? prior.seeing, transparency: h.transparency ?? prior.transparency }
      : h);
  }
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
}

export function summarizeNight(
  hours: ForecastHour[],
  w: Pick<NightWindow, 'coreStart' | 'coreEnd'>,
  rate: (hours: ForecastHour[]) => { score: number },
): Pick<NightConditions, 'avgCloud' | 'maxWind' | 'minDewGap' | 'avgHumidity' | 'medianSeeing' | 'nightScore'> | null {
  const core = hours.filter((h) => {
    const t = new Date(h.time).getTime();
    return t >= w.coreStart.getTime() - 1800_000 && t <= w.coreEnd.getTime() + 1800_000;
  });
  const used = core.length > 0 ? core : hours;
  if (used.length === 0) return null;
  const mean = (f: (h: ForecastHour) => number) => used.reduce((s, h) => s + f(h), 0) / used.length;
  return {
    avgCloud: Math.round(mean((h) => h.cloudCover) * 10) / 10,
    maxWind: Math.max(...used.map((h) => h.wind)),
    minDewGap: Math.round(Math.min(...used.map((h) => h.temperature - h.dewPoint)) * 10) / 10,
    avgHumidity: Math.round(mean((h) => h.humidity) * 10) / 10,
    medianSeeing: median(used.flatMap((h) => (h.seeing == null ? [] : [h.seeing]))),
    nightScore: rate(used).score,
  };
}

interface Row {
  siteKey: string; night: string; source: NightConditionsSource; hourlyJson: string;
  avgCloud: number; maxWind: number; minDewGap: number; avgHumidity: number; medianSeeing: number | null;
  moonIllum: number; darkHours: number; nightScore: number; fetchedAt: string;
}

const stmts = {
  get: db.prepare<[string, string, string], Row>('SELECT * FROM nightConditions WHERE siteKey = ? AND night = ? AND source = ?'),
  range: db.prepare<[string, string, string], Row>(
    'SELECT * FROM nightConditions WHERE siteKey = ? AND night >= ? AND night <= ? ORDER BY night, source',
  ),
  upsert: db.prepare(
    `INSERT INTO nightConditions
       (siteKey, night, source, hourlyJson, avgCloud, maxWind, minDewGap, avgHumidity, medianSeeing, moonIllum, darkHours, nightScore, fetchedAt)
     VALUES (@siteKey, @night, @source, @hourlyJson, @avgCloud, @maxWind, @minDewGap, @avgHumidity, @medianSeeing, @moonIllum, @darkHours, @nightScore, @fetchedAt)
     ON CONFLICT (siteKey, night, source) DO UPDATE SET
       hourlyJson = excluded.hourlyJson, avgCloud = excluded.avgCloud, maxWind = excluded.maxWind,
       minDewGap = excluded.minDewGap, avgHumidity = excluded.avgHumidity, medianSeeing = excluded.medianSeeing,
       moonIllum = excluded.moonIllum, darkHours = excluded.darkHours, nightScore = excluded.nightScore,
       fetchedAt = excluded.fetchedAt`,
  ),
};

function fromRow(row: Row): NightConditions | null {
  try {
    const hours = JSON.parse(row.hourlyJson) as ForecastHour[];
    return Array.isArray(hours) ? { ...row, hours } : null;
  } catch {
    return null;
  }
}

export function getNightConditions(siteKey: string, night: string, source: NightConditionsSource = 'forecast'): NightConditions | null {
  const row = stmts.get.get(siteKey, night, source);
  return row ? fromRow(row) : null;
}

/** Every stored night between two dates inclusive, a forecast row before an archive row for the same night. */
export function listNightConditions(siteKey: string, from: string, to: string): NightConditions[] {
  return stmts.range.all(siteKey, from, to).flatMap((r) => fromRow(r) ?? []);
}

export interface RecordInput {
  siteKey: string;
  lat: number;
  lon: number;
  timezone: string;
  hourly: ForecastHour[];
  rate: (hours: ForecastHour[]) => { score: number };
  now?: Date;
}

/**
 * Keep this fetch's hours for the observing night that `now` falls in.
 *
 * That night is picked by the 7 AM rule, not by the forecast's own "tonight":
 * between midnight and 7 AM the forecast has already moved on to the coming
 * evening, but the night actually in progress is still the one to finish. The
 * forecast also starts at today's midnight, so an early-morning fetch holds
 * only the second half of that night; merging by hour keeps the evening that
 * an earlier fetch already stored instead of replacing it with half a night.
 *
 * Never throws: recording history must not be able to break serving a forecast.
 */
export function recordNightConditions(input: RecordInput): NightConditions | null {
  try {
    const now = input.now ?? new Date();
    const tz = timeZoneOrLocal(input.timezone);
    const night = observingNightDateKey(now, tz);
    const w = nightWindow(night, input.lat, input.lon, tz);
    if (!w) return null;

    const lo = w.sunset.getTime() - PAD_MS, hi = w.sunrise.getTime() + PAD_MS;
    const fresh = input.hourly.filter((h) => {
      const t = new Date(h.time).getTime();
      return Number.isFinite(t) && t >= lo && t <= hi;
    });
    if (fresh.length === 0) return null;

    const existing = getNightConditions(input.siteKey, night, 'forecast');
    const hours = mergeHours(existing?.hours ?? [], fresh);
    const summary = summarizeNight(hours, w, input.rate);
    if (!summary) return null;

    const record: NightConditions = {
      siteKey: input.siteKey, night, source: 'forecast', hours, ...summary,
      moonIllum: Math.round(SunCalc.getMoonIllumination(w.middle).fraction * 100),
      darkHours: w.darkHours,
      fetchedAt: now.toISOString(),
    };
    stmts.upsert.run({ ...record, hourlyJson: JSON.stringify(hours) });
    return record;
  } catch (err) {
    console.error('[nightConditions] Could not record the night:', err instanceof Error ? err.message : err);
    return null;
  }
}
