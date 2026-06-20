import { timeZoneOrLocal } from './timezone.js';

const CACHE_TTL_MS = 24 * 60 * 60_000;
const MISS_TTL_MS = 60 * 60_000;

interface CacheEntry {
  timezone: string | null;
  expiresAt: number;
}

const timezoneCache = new Map<string, CacheEntry>();

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

function validTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    return null;
  }
}

export async function lookupTimeZoneForCoordinates(lat: number, lon: number): Promise<string | null> {
  const key = cacheKey(lat, lon);
  const cached = timezoneCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.timezone;

  try {
    const params = [
      `latitude=${encodeURIComponent(String(lat))}`,
      `longitude=${encodeURIComponent(String(lon))}`,
      'current=temperature_2m',
      'forecast_days=1',
      'timezone=auto',
    ].join('&');
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Open-Meteo API error: ${res.status}`);
    const data: unknown = await res.json();
    const timezone = data !== null && typeof data === 'object' && 'timezone' in data
      ? validTimeZone(data.timezone)
      : null;
    timezoneCache.set(key, {
      timezone,
      expiresAt: Date.now() + (timezone ? CACHE_TTL_MS : MISS_TTL_MS),
    });
    return timezone;
  } catch {
    timezoneCache.set(key, { timezone: null, expiresAt: Date.now() + MISS_TTL_MS });
    return null;
  }
}

export async function observerTimezoneForCoordinates(
  lat: number,
  lon: number,
  savedTimezone?: string | null,
): Promise<string> {
  const fromCoordinates = await lookupTimeZoneForCoordinates(lat, lon);
  return fromCoordinates ?? timeZoneOrLocal(savedTimezone);
}
