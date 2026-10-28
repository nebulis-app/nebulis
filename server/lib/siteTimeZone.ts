import { getActiveSite } from './observingSites.js';
import { lookupTimeZoneForCoordinates } from './observerTimezone.js';
import { timeZoneOrLocal } from './timezone.js';

/**
 * IANA zone of the active observing site: looked up from its coordinates,
 * else its saved zone, else the process zone.
 *
 * Use this, never the server's own clock, whenever an instant has to become a
 * site-local date or hour. A Docker server runs in UTC, so `getHours()` or
 * `toISOString().slice(0, 10)` there gives the Greenwich date, which is
 * tomorrow every evening in the Americas.
 */
export function activeSiteTimeZone(): string {
  const site = getActiveSite();
  const looked = site.latitude != null && site.longitude != null
    ? lookupTimeZoneForCoordinates(site.latitude, site.longitude)
    : null;
  return looked ?? timeZoneOrLocal(site.timezone);
}
