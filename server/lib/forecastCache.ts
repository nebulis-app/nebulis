/**
 * Astro/weather forecast fetching, mapping, and background cache refresh.
 *
 * Pulled out of routes/forecast.ts so lib code (plannerNightlyPrefetch) can
 * trigger a refresh without importing a route module. Route modules may
 * construct Express routers and arm background timers as import side
 * effects; lib must never depend on that. The refresh loop is started
 * explicitly by the composition root (server/index.ts) via
 * startForecastRefresh(), not by importing this module.
 */

import SunCalc from 'suncalc';
import { getActiveSite } from './observingSites.js';
import { getSettingsData } from './telescopes.js';
import { addDaysToDateKey, localDateKey, timeZoneOrLocal, zonedDateTimeToUtc } from './timezone.js';
import { observingNightDateKey } from './telescopeFiles.js';
import { TEMPERATURE_UNITS, WIND_SPEED_UNITS } from './types/appSettings.js';

export interface ForecastHour {
  time: string;          // ISO timestamp
  cloudCover: number;    // 0-100%
  cloudCoverLow: number;
  cloudCoverMid: number;
  cloudCoverHigh: number;
  seeing: number | null; // 1-5 (1=best) from 7Timer, interpolated between 3-hour points
  transparency: number | null; // 1-8 from 7Timer, interpolated
  humidity: number;
  temperature: number;
  dewPoint: number;
  wind: number;
  visibility: number | null;
  precipProb: number;
  jetStream: number | null;  // 500hPa wind speed km/h — primary seeing predictor
  cape: number | null;       // Convective Available Potential Energy J/kg — atmospheric instability
}

export interface AstroConditions {
  moonIllumination: number;
  moonPhase: string;
  moonRise: string | null;
  moonSet: string | null;
  sunset: string;
  sunrise: string;
  astronomicalTwilightEnd: string;   // When it's truly dark (empty if never occurs)
  astronomicalTwilightStart: string; // When dawn begins (empty if never occurs)
  nauticalTwilightEnd: string;       // Nautical dusk fallback
  nauticalTwilightStart: string;     // Nautical dawn fallback
  darkHours: number;                 // Hours of astronomical dark (0 if never occurs)
  nauticalDarkHours: number;         // Hours of nautical dark (fallback for high-lat summers)
}

export interface ForecastCacheEntry {
  data: unknown;
  fetchedAt: number;
  lat: number;
  lon: number;
  /** Last time a `/forecast` request was served for (or forced) this site.
   *  The background refresh only keeps sites requested in the last 24 h warm,
   *  so a one-off lookup for a place the user was travelling doesn't get
   *  re-fetched hourly forever. */
  lastRequestedAt: number;
}

// ─── Server-side forecast cache ────────────────────────────────
// A small per-site LRU. The forecast APIs are grid-cell resolution, so the key
// rounds lat/lon to ~0.01° (about a kilometre). Any multi-site user (or iOS +
// web hitting different siteIds) would otherwise thrash a single global slot
// and re-run buildForecast — two external APIs with 10 s timeouts — on almost
// every request. The API endpoint serves a fresh entry instantly; ?refresh=1
// forces a re-fetch unless the entry is only minutes old.

export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
/** ?refresh=1 is ignored while the cached entry is at least this fresh, so a
 *  client looping refresh can't drive unbounded upstream fetches. */
export const REFRESH_MIN_AGE_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_ENTRIES = 8;
const REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

// Insertion order is the LRU order: the least-recently-used key sits at the
// front. Reads and writes move their key to the back.
const forecastCacheByKey = new Map<string, ForecastCacheEntry>();

export function forecastSiteKey(lat: number, lon: number): string {
  return `${lat.toFixed(2)}|${lon.toFixed(2)}`;
}

function touch(key: string, entry: ForecastCacheEntry): void {
  forecastCacheByKey.delete(key);
  forecastCacheByKey.set(key, entry);
}

/** Cached entry for a site, or null. Does not affect LRU recency — call
 *  `markForecastRequested` for that on the serve path. */
export function getForecastCacheEntry(lat: number, lon: number): ForecastCacheEntry | null {
  return forecastCacheByKey.get(forecastSiteKey(lat, lon)) ?? null;
}

export function setForecastCacheEntry(entry: {
  data: unknown; fetchedAt: number; lat: number; lon: number; lastRequestedAt?: number;
}): void {
  const key = forecastSiteKey(entry.lat, entry.lon);
  const prior = forecastCacheByKey.get(key);
  touch(key, {
    data: entry.data,
    fetchedAt: entry.fetchedAt,
    lat: entry.lat,
    lon: entry.lon,
    lastRequestedAt: entry.lastRequestedAt ?? prior?.lastRequestedAt ?? entry.fetchedAt,
  });
  while (forecastCacheByKey.size > CACHE_MAX_ENTRIES) {
    const lru = forecastCacheByKey.keys().next().value;
    if (lru === undefined) break;
    forecastCacheByKey.delete(lru);
  }
}

/** Record that a client asked for this site now: refreshes its LRU recency and
 *  its 24 h refresh-retention window. */
export function markForecastRequested(lat: number, lon: number): void {
  const key = forecastSiteKey(lat, lon);
  const entry = forecastCacheByKey.get(key);
  if (entry) {
    entry.lastRequestedAt = Date.now();
    touch(key, entry);
  }
}

/** Test/diagnostic hook. */
export function _clearForecastCache(): void {
  forecastCacheByKey.clear();
}

// ─── 7Timer astronomy forecast ──────────────────────────────────

async function fetch7Timer(lat: number, lon: number) {
  const url = `https://www.7timer.info/bin/api.pl?lon=${lon}&lat=${lat}&product=astro&output=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`7Timer API error: ${res.status}`);
  return res.json();
}

// ─── Open-Meteo weather forecast ────────────────────────────────

async function fetchOpenMeteoOnce(lat: number, lon: number) {
  const params = [
    `latitude=${lat}`,
    `longitude=${lon}`,
    'hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,temperature_2m,dew_point_2m,wind_speed_10m,visibility,precipitation_probability,wind_speed_500hPa,cape',
    // 5 days: tonight plus 3 rated nights ahead. The 3rd night ahead (d=3)
    // runs to ~06:00 on the 5th calendar day, so anything shorter would
    // average only its evening hours. Day 4-5 cloud forecasts carry less
    // skill, which is why those nights only get the coarse night rating.
    'forecast_days=5',
    'timezone=auto',
  ].join('&');
  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Open-Meteo API error: ${res.status}`);
  return res.json();
}

/**
 * Open-Meteo is the primary weather source: if it fails, every hourly-derived
 * section of the forecast is blank and the clients show "forecast unavailable".
 * A single quick retry absorbs the common transient failures (a cold-start DNS
 * miss, a brief 5xx/429, a network blip right after the server wakes from
 * sleep) that were otherwise poisoning the cache for a full hour.
 */
async function fetchOpenMeteo(lat: number, lon: number) {
  try {
    return await fetchOpenMeteoOnce(lat, lon);
  } catch (first) {
    await new Promise(r => setTimeout(r, 800));
    try {
      return await fetchOpenMeteoOnce(lat, lon);
    } catch {
      throw first;
    }
  }
}

// ─── Map 7Timer seeing codes ────────────────────────────────────

export function map7TimerSeeing(code: number): number {
  // 7Timer seeing: 1=<0.5", 2=0.5-0.75", 3=0.75-1", 4=1-1.25", 5=1.25-1.5", 6=1.5-2", 7=2-2.5", 8=>2.5"
  if (code <= 2) return 1; // Excellent
  if (code <= 3) return 2; // Good
  if (code <= 5) return 3; // Average
  if (code <= 6) return 4; // Poor
  return 5; // Bad
}

export function map7TimerTransparency(code: number): number {
  // 7Timer transparency: 1=<0.3, 2=0.3-0.4, ... 8=>1 (lower = clearer)
  return code; // Keep raw 1-8 scale
}

export function map7TimerCloud(code: number): number {
  // 7Timer cloud: 1=0-6%, 2=6-19%, 3=19-31%, 4=31-44%, 5=44-56%, 6=56-69%, 7=69-81%, 8=81-94%, 9=94-100%
  const mapping = [0, 3, 12, 25, 37, 50, 62, 75, 87, 97];
  return mapping[code] ?? code * 11;
}

/**
 * Fills in null seeing/transparency hours by interpolating between 7Timer's
 * 3-hourly data points (linear in array-index space, then rounded). Hours
 * before the first anchor or after the last anchor copy the nearest anchor
 * instead of extrapolating. Mutates `hours` in place.
 */
export function interpolateSeeingTransparency(
  hours: Array<{ seeing: number | null; transparency: number | null }>,
): void {
  const anchors = hours
    .map((h, i) => ({ i, seeing: h.seeing, transparency: h.transparency }))
    .filter(p => p.seeing !== null);

  for (let i = 0; i < hours.length; i++) {
    if (hours[i].seeing !== null) continue;
    const prev = [...anchors].reverse().find(p => p.i < i);
    const next = anchors.find(p => p.i > i);
    if (prev && next) {
      const t = (i - prev.i) / (next.i - prev.i);
      hours[i].seeing = Math.round(prev.seeing! * (1 - t) + next.seeing! * t);
      if (prev.transparency !== null && next.transparency !== null) {
        hours[i].transparency = Math.round(prev.transparency * (1 - t) + next.transparency * t);
      }
    } else if (prev) {
      hours[i].seeing = prev.seeing;
      hours[i].transparency = prev.transparency;
    } else if (next) {
      hours[i].seeing = next.seeing;
      hours[i].transparency = next.transparency;
    }
  }
}

export interface NightRating {
  score: number;
  rating: string;
  avgCloudCover: number;
  avgHumidity: number;
  avgWind: number;
  precipChance: number;
  /**
   * `'low'` for the furthest-out rated night (~72-96 h). Cloud-cover skill
   * drops off that far ahead, so the clients render it as a dimmer card with
   * a "less certain" note rather than letting it read as firm as tonight+1.
   */
  confidence: 'normal' | 'low';
}

/**
 * Scores how good a night is for imaging from its hourly forecast slice.
 * Requires at least one hour (callers already skip nights with none — an
 * empty array would divide by zero into NaN throughout).
 */
export function rateNightConditions(nightHours: ForecastHour[]): NightRating {
  const avgCloud = nightHours.reduce((s, h) => s + h.cloudCover, 0) / nightHours.length;
  const avgHumidity = nightHours.reduce((s, h) => s + h.humidity, 0) / nightHours.length;
  const avgWind = nightHours.reduce((s, h) => s + h.wind, 0) / nightHours.length;
  const avgPrecip = nightHours.reduce((s, h) => s + h.precipProb, 0) / nightHours.length;

  let score = 100;
  score -= avgCloud * 0.6;
  score -= avgPrecip * 0.3;
  score -= Math.max(0, avgHumidity - 60) * 0.3;
  score -= Math.max(0, avgWind - 15) * 0.5;
  score = Math.max(0, Math.min(100, Math.round(score)));

  let rating: string;
  if (score >= 80) rating = 'Excellent';
  else if (score >= 60) rating = 'Good';
  else if (score >= 40) rating = 'Fair';
  else if (score >= 20) rating = 'Poor';
  else rating = 'Bad';

  return {
    score,
    rating,
    avgCloudCover: Math.round(avgCloud),
    avgHumidity: Math.round(avgHumidity),
    avgWind: Math.round(avgWind * 10) / 10,
    precipChance: Math.round(avgPrecip),
    confidence: 'normal',
  };
}

// ─── Core forecast builder ──────────────────────────────────────

export async function buildForecast(lat: number, lon: number) {
  // Fetch both APIs in parallel
  const [openMeteoData, sevenTimerData] = await Promise.allSettled([
    fetchOpenMeteo(lat, lon),
    fetch7Timer(lat, lon),
  ]);

  const openMeteo = openMeteoData.status === 'fulfilled' ? openMeteoData.value : null;
  const sevenTimer = sevenTimerData.status === 'fulfilled' ? sevenTimerData.value : null;
  // timeZoneOrLocal validates against Intl.DateTimeFormat and falls back to
  // the machine's own zone on anything it rejects. Every other use of a
  // timezone string in this file already goes through localDateKey/
  // zonedDateTimeToUtc, which call it internally — but this raw value is
  // also serialized straight into the API response below as `timezone`,
  // bypassing that check entirely. Open-Meteo is a third-party API: an
  // unrecognized or malformed identifier for some coordinate (a polar or
  // oceanic point, an API-side quirk) reached the client unvalidated and
  // crashed the Forecast page's own unguarded Intl.DateTimeFormat call.
  const forecastTimezone = timeZoneOrLocal(
    (openMeteo?.timezone as string | undefined) || getActiveSite().timezone,
  );

  // Build hourly forecast from Open-Meteo (primary)
  const hours: ForecastHour[] = [];

  if (openMeteo?.hourly) {
    const h = openMeteo.hourly;
    for (let i = 0; i < (h.time?.length || 0); i++) {
      const time = parseOpenMeteoHour(h.time[i], forecastTimezone);
      hours.push({
        time: time.toISOString(),
        cloudCover: h.cloud_cover?.[i] ?? 0,
        cloudCoverLow: h.cloud_cover_low?.[i] ?? 0,
        cloudCoverMid: h.cloud_cover_mid?.[i] ?? 0,
        cloudCoverHigh: h.cloud_cover_high?.[i] ?? 0,
        seeing: null,
        transparency: null,
        humidity: h.relative_humidity_2m?.[i] ?? 0,
        temperature: h.temperature_2m?.[i] ?? 0,
        dewPoint: h.dew_point_2m?.[i] ?? 0,
        wind: h.wind_speed_10m?.[i] ?? 0,
        visibility: h.visibility?.[i] ?? null,
        precipProb: h.precipitation_probability?.[i] ?? 0,
        jetStream: h.wind_speed_500hPa?.[i] ?? null,
        cape: h.cape?.[i] ?? null,
      });
    }
  }

  // Merge 7Timer seeing/transparency data into hourly forecast
  if (sevenTimer?.dataseries) {
    const initDate = sevenTimer.init ? parseSevenTimerInit(sevenTimer.init) : new Date();

    for (const point of sevenTimer.dataseries) {
      const pointTime = new Date(initDate.getTime() + point.timepoint * 3600 * 1000);
      const pointHour = pointTime.toISOString().slice(0, 13);

      const match = hours.find(h => h.time.slice(0, 13) === pointHour);
      if (match) {
        match.seeing = map7TimerSeeing(point.seeing ?? 5);
        match.transparency = map7TimerTransparency(point.transparency ?? 5);
        if (match.cloudCover === 0 && point.cloudcover) {
          match.cloudCover = map7TimerCloud(point.cloudcover);
        }
      }
    }
  }

  // Interpolate seeing/transparency between 7Timer's 3-hourly data points.
  // Without this, hours lacking a 7Timer hit default to null → "Average" in the UI,
  // creating artificial score swings every 3 hours.
  interpolateSeeingTransparency(hours);

  // SunCalc returns Invalid Date (not null/undefined) when an event doesn't
  // occur (e.g. astronomical dark in a UK summer). Invalid Date is truthy so
  // optional-chaining doesn't protect toISOString() — validate explicitly.
  const validDate = (d: unknown): Date | null =>
    d instanceof Date && !isNaN(d.getTime()) ? d : null;
  const safeIso = (d: unknown): string => validDate(d)?.toISOString() ?? '';

  // Calculate astronomical conditions
  const now = new Date();
  const tonightDate = defaultNightDate(now, forecastTimezone);
  const tonight = zonedDateTimeToUtc(tonightDate, { hour: 20 }, forecastTimezone);

  const sunTimes = SunCalc.getTimes(tonight, lat, lon);
  const tomorrowSunTimes = SunCalc.getTimes(new Date(tonight.getTime() + 86400000), lat, lon);
  const moonTimes = SunCalc.getMoonTimes(tonight, lat, lon);
  const moonIllum = SunCalc.getMoonIllumination(tonight);

  const sunset = validDate(sunTimes.sunset) ?? validDate(sunTimes.dusk);
  const sunrise = validDate(tomorrowSunTimes.sunrise) ?? validDate(tomorrowSunTimes.dawn);
  const astroEnd = validDate(sunTimes.night);
  const astroStart = validDate(tomorrowSunTimes.nightEnd);
  const nauticalEnd = validDate(sunTimes.nauticalDusk);
  const nauticalStart = validDate(tomorrowSunTimes.nauticalDawn);

  let darkHours = 0;
  if (astroEnd && astroStart) {
    darkHours = Math.max(0, (astroStart.getTime() - astroEnd.getTime()) / 3600000);
  }

  let nauticalDarkHours = 0;
  if (nauticalEnd && nauticalStart) {
    nauticalDarkHours = Math.max(0, (nauticalStart.getTime() - nauticalEnd.getTime()) / 3600000);
  }

  const astro: AstroConditions = {
    moonIllumination: Math.round(moonIllum.fraction * 100),
    moonPhase: getMoonPhaseName(moonIllum.phase),
    moonRise: safeIso(moonTimes.rise) || null,
    moonSet: safeIso(moonTimes.set) || null,
    sunset: safeIso(sunset),
    sunrise: safeIso(sunrise),
    astronomicalTwilightEnd: safeIso(astroEnd),
    astronomicalTwilightStart: safeIso(astroStart),
    nauticalTwilightEnd: safeIso(nauticalEnd),
    nauticalTwilightStart: safeIso(nauticalStart),
    darkHours: Math.round(darkHours * 10) / 10,
    nauticalDarkHours: Math.round(nauticalDarkHours * 10) / 10,
  };

  // Rate tonight plus the next 3 nights. Base the date keys on the actual sunset,
  // not tonightDate: before the 7am observing-night rollover `tonightDate` is
  // still yesterday's calendar day, while the sun/twilight times above have
  // already rolled forward to tonight (SunCalc.getTimes returns the sunset
  // after solar noon of the anchor day). Keying the ratings off tonightDate
  // then labels tonight's rating with yesterday's date, so a client that drops
  // "the first night" as tonight leaves the real tonight in its outlook list,
  // duplicated with the hero.
  const ratingsBaseDate = sunset ? localDateKey(sunset, forecastTimezone) : tonightDate;
  const nightRatings = [];
  for (let d = 0; d < 4; d++) {
    const ratingDate = addDaysToDateKey(ratingsBaseDate, d);
    const nightDate = zonedDateTimeToUtc(ratingDate, { hour: 22 }, forecastTimezone);

    const nightHours = hours.filter(h => {
      const hDate = new Date(h.time);
      const diff = (hDate.getTime() - nightDate.getTime()) / 3600000;
      return diff >= -2 && diff <= 8;
    });

    if (nightHours.length === 0) continue;

    // d=3 is the ~72-96 h night: real but noticeably less reliable, so the
    // clients dim its card. d=0 is tonight and the clients drop it (hero).
    const confidence: NightRating['confidence'] = d >= 3 ? 'low' : 'normal';
    nightRatings.push({ date: ratingDate, ...rateNightConditions(nightHours), confidence });
  }

  // Display units the clients should format temperature/wind in. Open-Meteo is
  // always fetched in metric; the number in `hourly[].temperature` stays °C and
  // `wind` stays km/h, the client converts. Served here so iOS/Android don't
  // each need a separate settings round-trip just to pick °F vs °C.
  const settings = getSettingsData();
  const temperatureUnit = (TEMPERATURE_UNITS as readonly string[]).includes(String(settings.temperatureUnit))
    ? (settings.temperatureUnit as string)
    : 'fahrenheit';
  const windUnit = (WIND_SPEED_UNITS as readonly string[]).includes(String(settings.windSpeedUnit))
    ? (settings.windSpeedUnit as string)
    : 'mph';

  return {
    location: { lat, lon },
    timezone: forecastTimezone,
    units: { temperature: temperatureUnit, wind: windUnit },
    hourly: hours,
    tonight: astro,
    nightRatings,
    sources: {
      weather: openMeteo ? 'open-meteo' : null,
      seeing: sevenTimer ? '7timer' : null,
    },
  };
}

/**
 * A forecast is only worth caching or serving if it actually carries hourly
 * weather data. An empty `hourly` array (equivalently, a null weather source)
 * means `buildForecast` ran while Open-Meteo was unreachable, so every
 * hourly-derived section downstream would be blank. Caching one of these used
 * to pin the "forecast unavailable" state for a full hour and block `?refresh=1`
 * recovery for the first ten minutes.
 */
export function isUsableForecast(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as { hourly?: unknown; sources?: { weather?: unknown } | null };
  return Array.isArray(d.hourly) && d.hourly.length > 0 && d.sources?.weather != null;
}

// ─── Background refresh ─────────────────────────────────────────

export async function refreshForecastCache(): Promise<void> {
  // Always keep the active site warm even if nobody has hit /forecast yet this
  // process, plus every other site requested in the last 24 h.
  const targets = new Map<string, { lat: number; lon: number }>();
  const active = getActiveSite();
  if (active.latitude != null && active.longitude != null) {
    targets.set(forecastSiteKey(active.latitude, active.longitude), { lat: active.latitude, lon: active.longitude });
  }
  const cutoff = Date.now() - REQUEST_RETENTION_MS;
  for (const entry of forecastCacheByKey.values()) {
    if (entry.lastRequestedAt >= cutoff) {
      targets.set(forecastSiteKey(entry.lat, entry.lon), { lat: entry.lat, lon: entry.lon });
    }
  }

  for (const { lat, lon } of targets.values()) {
    try {
      const data = await buildForecast(lat, lon);
      if (!isUsableForecast(data)) {
        // Never overwrite a good entry (or seed a bad one) with an empty
        // forecast. The 5-s-after-boot refresh often runs before the network
        // is ready; caching its empty result is what made this "keep
        // happening" for an hour at a time.
        console.warn(`[forecast] Skipped caching empty forecast for ${forecastSiteKey(lat, lon)} (upstream weather unavailable)`);
        continue;
      }
      setForecastCacheEntry({ data, fetchedAt: Date.now(), lat, lon });
      console.log(`[forecast] Cache refreshed for ${forecastSiteKey(lat, lon)}`);
    } catch (err) {
      console.error('[forecast] Background refresh failed:', err instanceof Error ? err.message : err);
    }
  }
}

// Started by the composition root (server/index.ts). Initial fetch after 5s,
// then every hour. Must never run as an import side effect — lib/routes that
// need a refresh call refreshForecastCache() directly instead of importing
// this starter, so importing lib code never arms a timer as a side effect.
export function startForecastRefresh(): void {
  setTimeout(() => {
    refreshForecastCache();
    setInterval(refreshForecastCache, CACHE_TTL_MS);
  }, 5000);
}

export function parseSevenTimerInit(init: string): Date {
  // Format: "2024011512" -> 2024-01-15T12:00:00Z
  const y = init.slice(0, 4);
  const m = init.slice(4, 6);
  const d = init.slice(6, 8);
  const h = init.slice(8, 10);
  return new Date(`${y}-${m}-${d}T${h}:00:00Z`);
}

export function parseOpenMeteoHour(value: string, timeZone: string): Date {
  const [datePart, timePart = '00:00'] = value.split('T');
  const [hour = 0, minute = 0, second = 0] = timePart.split(':').map(Number);
  return zonedDateTimeToUtc(datePart, { hour, minute, second }, timeZone);
}

/** Forecast-domain alias for the shared observing-night rule. */
export function defaultNightDate(now: Date, timeZone: string): string {
  return observingNightDateKey(now, timeZone);
}

export function getMoonPhaseName(phase: number): string {
  if (phase < 0.03 || phase > 0.97) return 'New Moon';
  if (phase < 0.22) return 'Waxing Crescent';
  if (phase < 0.28) return 'First Quarter';
  if (phase < 0.47) return 'Waxing Gibbous';
  if (phase < 0.53) return 'Full Moon';
  if (phase < 0.72) return 'Waning Gibbous';
  if (phase < 0.78) return 'Last Quarter';
  return 'Waning Crescent';
}
