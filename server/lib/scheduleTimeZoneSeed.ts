/**
 * The parts of the schedule time zone that touch no setting, so the database
 * migration can use them without importing the settings module (which imports the
 * database). See scheduleTimeZone.ts.
 */
import { lookupTimeZoneForCoordinates } from './observerTimezone.js';

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * The value an existing install starts with when the setting is added. The zone the
 * schedules already used when there was one (the default site's saved zone), else
 * the one found from the default site's coordinates, else `TZ` when the container
 * sets one. Empty otherwise: the settings page then says the server's zone is in use.
 */
export function initialScheduleTimeZone(input: {
  siteTimeZone: string | null;
  latitude: number | null;
  longitude: number | null;
  envTimeZone: string | undefined;
}): string {
  const site = input.siteTimeZone?.trim() ?? '';
  if (isValidTimeZone(site)) return site;
  if (input.latitude != null && input.longitude != null) {
    const looked = lookupTimeZoneForCoordinates(input.latitude, input.longitude);
    if (looked && isValidTimeZone(looked)) return looked;
  }
  const env = input.envTimeZone?.trim() ?? '';
  if (isValidTimeZone(env)) return env;
  return '';
}
