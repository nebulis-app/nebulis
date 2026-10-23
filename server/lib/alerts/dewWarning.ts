/**
 * "Dew warning": a heads-up ahead of the hour the air is forecast to get close to its dew point, so there is time to put a dew heater on or
 * bring the rig in. Unlike the evening clear-night alert, which goes to everyone at one time, each channel and phone chooses how far ahead it
 * wants the warning, so every destination is sent its own at its own time, once per observing night.
 *
 * It only goes on nights that are worth imaging, using the same clear-hours threshold as the clear-night alert; a cloudy night has nobody
 * outside to warn.
 */
import { forecastHours, evaluateClearNight } from './clearNight.js';
import { sendToChannel, sendToDevice, type DeliveryResult } from './delivery.js';
import { getAlertConfig, getAlertState, listAlertChannels, listAlertDevices, setAlertState } from './store.js';
import type { AlertEvent, DewForecast } from './types.js';
import { getActiveSite } from '../observingSites.js';
import { addDaysToDateKey, localDateKey, localParts } from '../timezone.js';
import { log } from '../logger.js';

const RETRY_MS = 15 * 60_000;

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;
/** A destination that just failed is left alone for a while, so a down relay is not hit every minute. */
const retryAfter = new Map<string, number>();

/**
 * The observing night a moment belongs to: the evening's date. Dew mostly starts after midnight, when the calendar date has already moved on,
 * so before noon the night is the previous date.
 */
export function observingNight(now: Date, timeZone: string): string {
  const today = localDateKey(now, timeZone);
  return localParts(now, timeZone).hour < 12 ? addDaysToDateKey(today, -1) : today;
}

/** The dew is forecast, its lead time has come, and this destination has not had tonight's warning. */
export function dewWarningDue(now: Date, dew: DewForecast | null, leadMinutes: number, lastSentNight: string | null, night: string): boolean {
  if (!dew || dew.level === 'none' || !dew.from || lastSentNight === night) return false;
  return now.getTime() >= Date.parse(dew.from) - leadMinutes * 60_000;
}

const sentKey = (id: string) => `dew.sent.${id}`;

interface Destination {
  id: string;
  leadMinutes: number;
  send: (event: AlertEvent) => Promise<DeliveryResult>;
}

/** Sends every warning that has come due. Returns how many went out. */
export async function runDewWarnings(now: Date): Promise<number> {
  const destinations: Destination[] = [
    ...listAlertChannels().filter(c => c.enabled && c.events.includes('night.dew'))
      .map(c => ({ id: c.id, leadMinutes: c.details.dewLeadMinutes, send: (e: AlertEvent) => sendToChannel(c, e) })),
    ...listAlertDevices().filter(d => d.enabled && d.events.includes('night.dew'))
      .map(d => ({ id: d.id, leadMinutes: d.details.dewLeadMinutes, send: (e: AlertEvent) => sendToDevice(d, e) })),
  ];
  if (destinations.length === 0) return 0;

  const site = getActiveSite();
  if (site.latitude == null || site.longitude == null) return 0;
  const hours = await forecastHours(site.latitude, site.longitude);
  if (!hours) return 0;

  const config = getAlertConfig();
  const night = observingNight(now, site.timezone);
  const result = evaluateClearNight({
    hours, lat: site.latitude, lon: site.longitude, timeZone: site.timezone, siteName: site.name, night,
    maxCloudCover: config.clearNight.maxCloudCover, from: now,
  });
  if (!result || result.clearHours < config.clearNight.minClearHours) return 0;
  const dew = result.dew;
  if (!dew || dew.level === 'none' || !dew.from) return 0;

  let sent = 0;
  for (const d of destinations) {
    if ((retryAfter.get(d.id) ?? 0) > now.getTime()) continue;
    if (!dewWarningDue(now, dew, d.leadMinutes, getAlertState<string>(sentKey(d.id)), night)) continue;
    const outcome = await d.send({
      type: 'night.dew',
      occurredAt: now.toISOString(),
      data: { siteName: site.name, night, timeZone: site.timezone, level: dew.level, from: dew.from, lowTempC: dew.lowTempC, leadMinutes: d.leadMinutes },
    });
    if (outcome.ok) {
      setAlertState(sentKey(d.id), night);
      retryAfter.delete(d.id);
      sent++;
    } else {
      retryAfter.set(d.id, now.getTime() + RETRY_MS);
    }
  }
  return sent;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runDewWarnings(new Date());
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[alerts] dew warning check failed');
  } finally {
    running = false;
  }
}

export function startDewWarningScheduler(): void {
  stopDewWarningScheduler();
  interval = setInterval(() => { void tick(); }, 60_000);
}

export function stopDewWarningScheduler(): void {
  if (interval) clearInterval(interval);
  interval = null;
}

/** Tests drive the check directly. */
export function _resetDewWarningsForTests(): void {
  retryAfter.clear();
}
