import tzlookup from 'tz-lookup';
import { timeZoneOrLocal } from './timezone.js';

export function lookupTimeZoneForCoordinates(lat: number, lon: number): string | null {
  try {
    const tz = tzlookup(lat, lon);
    return tz || null;
  } catch {
    return null;
  }
}

export async function observerTimezoneForCoordinates(
  lat: number,
  lon: number,
  savedTimezone?: string | null,
): Promise<string> {
  return lookupTimeZoneForCoordinates(lat, lon) ?? timeZoneOrLocal(savedTimezone);
}
