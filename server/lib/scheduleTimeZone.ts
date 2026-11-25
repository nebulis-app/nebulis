/**
 * The time zone every scheduler runs in: the disk archive, the Google Drive backup
 * and the nightly maintenance.
 *
 * It is a setting of the installation (Settings → General), not of the observing
 * site. Schedules run once for the whole server, and a site is about astronomy:
 * twilight, the imaging window, the forecast. Before this setting, the schedulers
 * read the default site's saved zone, which a site created from typed-in
 * coordinates does not have, so in Docker every schedule silently ran in UTC.
 *
 * Order: the installation's zone, else the default site's saved zone (what the
 * schedulers used before), else the server's own zone.
 */
import { getSettingsData } from './telescopes.js';
import { timeZoneOrLocal } from './timezone.js';
import { isValidTimeZone } from './scheduleTimeZoneSeed.js';

export { isValidTimeZone, initialScheduleTimeZone } from './scheduleTimeZoneSeed.js';

export type ScheduleTimeZoneSource = 'installation' | 'site' | 'server';

/** The zone schedules run in, and where it comes from. */
export function scheduleTimeZoneInfo(): { timeZone: string; source: ScheduleTimeZoneSource } {
  const settings = getSettingsData();
  const installation = typeof settings.scheduleTimeZone === 'string' ? settings.scheduleTimeZone : '';
  if (isValidTimeZone(installation)) return { timeZone: installation, source: 'installation' };
  const site = typeof settings.timezone === 'string' ? settings.timezone : '';
  if (isValidTimeZone(site)) return { timeZone: site, source: 'site' };
  return { timeZone: timeZoneOrLocal(null), source: 'server' };
}

/** The zone schedules run in. */
export function scheduleTimeZone(): string {
  return scheduleTimeZoneInfo().timeZone;
}

/** The server's own zone (UTC in most containers), for a page to say what an unset zone means. */
export function serverTimeZone(): string {
  return timeZoneOrLocal(null);
}
