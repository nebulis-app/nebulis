import { Router, Request, Response } from 'express';
import SunCalc from 'suncalc';
import { getSettingsData } from '../lib/telescopes.js';

const router = Router();

// ─── Server-side forecast cache ────────────────────────────────
// Refreshes automatically every hour using the user's saved location.
// The API endpoint serves cached data instantly; ?refresh=1 forces a re-fetch.

let forecastCache: { data: unknown; fetchedAt: number; lat: number; lon: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface ForecastHour {
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

interface AstroConditions {
  moonIllumination: number;
  moonPhase: string;
  moonRise: string | null;
  moonSet: string | null;
  sunset: string;
  sunrise: string;
  astronomicalTwilightEnd: string;   // When it's truly dark
  astronomicalTwilightStart: string; // When dawn begins
  darkHours: number;
}

// ─── 7Timer astronomy forecast ──────────────────────────────────

async function fetch7Timer(lat: number, lon: number) {
  const url = `https://www.7timer.info/bin/api.pl?lon=${lon}&lat=${lat}&product=astro&output=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`7Timer API error: ${res.status}`);
  return res.json();
}

// ─── Open-Meteo weather forecast ────────────────────────────────

async function fetchOpenMeteo(lat: number, lon: number) {
  const params = [
    `latitude=${lat}`,
    `longitude=${lon}`,
    'hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,temperature_2m,dew_point_2m,wind_speed_10m,visibility,precipitation_probability,wind_speed_500hPa,cape',
    'forecast_days=3',
    'timezone=auto',
  ].join('&');
  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Open-Meteo API error: ${res.status}`);
  return res.json();
}

// ─── Map 7Timer seeing codes ────────────────────────────────────

function map7TimerSeeing(code: number): number {
  // 7Timer seeing: 1=<0.5", 2=0.5-0.75", 3=0.75-1", 4=1-1.25", 5=1.25-1.5", 6=1.5-2", 7=2-2.5", 8=>2.5"
  if (code <= 2) return 1; // Excellent
  if (code <= 3) return 2; // Good
  if (code <= 5) return 3; // Average
  if (code <= 6) return 4; // Poor
  return 5; // Bad
}

function map7TimerTransparency(code: number): number {
  // 7Timer transparency: 1=<0.3, 2=0.3-0.4, ... 8=>1 (lower = clearer)
  return code; // Keep raw 1-8 scale
}

function map7TimerCloud(code: number): number {
  // 7Timer cloud: 1=0-6%, 2=6-19%, 3=19-31%, 4=31-44%, 5=44-56%, 6=56-69%, 7=69-81%, 8=81-94%, 9=94-100%
  const mapping = [0, 3, 12, 25, 37, 50, 62, 75, 87, 97];
  return mapping[code] ?? code * 11;
}

// ─── Core forecast builder ──────────────────────────────────────

async function buildForecast(lat: number, lon: number) {
  // Fetch both APIs in parallel
  const [openMeteoData, sevenTimerData] = await Promise.allSettled([
    fetchOpenMeteo(lat, lon),
    fetch7Timer(lat, lon),
  ]);

  const openMeteo = openMeteoData.status === 'fulfilled' ? openMeteoData.value : null;
  const sevenTimer = sevenTimerData.status === 'fulfilled' ? sevenTimerData.value : null;

  // Build hourly forecast from Open-Meteo (primary)
  const hours: ForecastHour[] = [];

  if (openMeteo?.hourly) {
    const h = openMeteo.hourly;
    for (let i = 0; i < (h.time?.length || 0); i++) {
      hours.push({
        time: h.time[i],
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
  {
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

  // Calculate astronomical conditions
  const now = new Date();
  const tonight = new Date(now);
  tonight.setHours(20, 0, 0, 0);

  const sunTimes = SunCalc.getTimes(tonight, lat, lon);
  const tomorrowSunTimes = SunCalc.getTimes(new Date(tonight.getTime() + 86400000), lat, lon);
  const moonTimes = SunCalc.getMoonTimes(tonight, lat, lon);
  const moonIllum = SunCalc.getMoonIllumination(tonight);

  const sunset = sunTimes.sunset || sunTimes.dusk;
  const sunrise = tomorrowSunTimes.sunrise || tomorrowSunTimes.dawn;
  const astroEnd = sunTimes.night;
  const astroStart = tomorrowSunTimes.nightEnd;

  let darkHours = 0;
  if (astroEnd && astroStart) {
    darkHours = Math.max(0, (astroStart.getTime() - astroEnd.getTime()) / 3600000);
  }

  const astro: AstroConditions = {
    moonIllumination: Math.round(moonIllum.fraction * 100),
    moonPhase: getMoonPhaseName(moonIllum.phase),
    moonRise: moonTimes.rise?.toISOString() || null,
    moonSet: moonTimes.set?.toISOString() || null,
    sunset: sunset?.toISOString() || '',
    sunrise: sunrise?.toISOString() || '',
    astronomicalTwilightEnd: astroEnd?.toISOString() || '',
    astronomicalTwilightStart: astroStart?.toISOString() || '',
    darkHours: Math.round(darkHours * 10) / 10,
  };

  // Rate each night (next 3 nights)
  const nightRatings = [];
  for (let d = 0; d < 3; d++) {
    const nightDate = new Date(now);
    nightDate.setDate(nightDate.getDate() + d);
    nightDate.setHours(22, 0, 0, 0);

    const nightHours = hours.filter(h => {
      const hDate = new Date(h.time);
      const diff = (hDate.getTime() - nightDate.getTime()) / 3600000;
      return diff >= -2 && diff <= 8;
    });

    if (nightHours.length === 0) continue;

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

    const yy = nightDate.getFullYear();
    const mm = String(nightDate.getMonth() + 1).padStart(2, '0');
    const dd = String(nightDate.getDate()).padStart(2, '0');
    nightRatings.push({
      date: `${yy}-${mm}-${dd}`,
      score,
      rating,
      avgCloudCover: Math.round(avgCloud),
      avgHumidity: Math.round(avgHumidity),
      avgWind: Math.round(avgWind * 10) / 10,
      precipChance: Math.round(avgPrecip),
    });
  }

  return {
    location: { lat, lon },
    hourly: hours,
    tonight: astro,
    nightRatings,
    sources: {
      weather: openMeteo ? 'open-meteo' : null,
      seeing: sevenTimer ? '7timer' : null,
    },
  };
}

// ─── Background refresh ─────────────────────────────────────────

export async function refreshForecastCache(): Promise<void> {
  const settings = getSettingsData();
  const lat = settings.latitude as number | null;
  const lon = settings.longitude as number | null;
  if (lat == null || lon == null) return;

  try {
    const data = await buildForecast(lat, lon);
    forecastCache = { data, fetchedAt: Date.now(), lat, lon };
    console.log('[forecast] Cache refreshed');
  } catch (err) {
    console.error('[forecast] Background refresh failed:', err instanceof Error ? err.message : err);
  }
}

// Initial fetch after 5s, then every hour
setTimeout(() => {
  refreshForecastCache();
  setInterval(refreshForecastCache, CACHE_TTL_MS);
}, 5000);

// ─── Combined forecast endpoint ─────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const lat = parseFloat(String(req.query.lat || ''));
    const lon = parseFloat(String(req.query.lon || ''));
    const forceRefresh = req.query.refresh === '1';

    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      res.apiError(400, 'INVALID_COORDS', 'Valid latitude (-90 to 90) and longitude (-180 to 180) required');
      return;
    }

    // Serve from cache if fresh and coordinates match
    if (
      !forceRefresh &&
      forecastCache &&
      forecastCache.lat === lat &&
      forecastCache.lon === lon &&
      Date.now() - forecastCache.fetchedAt < CACHE_TTL_MS
    ) {
      res.apiSuccess(forecastCache.data);
      return;
    }

    // Cache miss or stale — fetch fresh
    const data = await buildForecast(lat, lon);
    forecastCache = { data, fetchedAt: Date.now(), lat, lon };
    res.apiSuccess(data);
  } catch (err: unknown) {
    // On error, serve stale cache if available
    if (forecastCache) {
      res.apiSuccess(forecastCache.data);
      return;
    }
    const message = err instanceof Error ? err.message : 'Forecast fetch failed';
    res.apiError(500, 'FORECAST_FAILED', message);
  }
});

function parseSevenTimerInit(init: string): Date {
  // Format: "2024011512" -> 2024-01-15T12:00:00Z
  const y = init.slice(0, 4);
  const m = init.slice(4, 6);
  const d = init.slice(6, 8);
  const h = init.slice(8, 10);
  return new Date(`${y}-${m}-${d}T${h}:00:00Z`);
}

function getMoonPhaseName(phase: number): string {
  if (phase < 0.03 || phase > 0.97) return 'New Moon';
  if (phase < 0.22) return 'Waxing Crescent';
  if (phase < 0.28) return 'First Quarter';
  if (phase < 0.47) return 'Waxing Gibbous';
  if (phase < 0.53) return 'Full Moon';
  if (phase < 0.72) return 'Waning Gibbous';
  if (phase < 0.78) return 'Last Quarter';
  return 'Waning Crescent';
}

export { router as forecastRouter };
