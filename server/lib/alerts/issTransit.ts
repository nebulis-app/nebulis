/**
 * "ISS transit": the station crossing the Moon or the Sun near the active site. Each channel and phone chooses how far
 * from the site the centre line may pass (`issTransitRadiusKm`, how far they would drive).
 *
 * A transit is told twice: a first notice about a day ahead (`day`), and again about two hours ahead (`final`),
 * worked out again then with the freshest orbital elements, because a day-old TLE can move the band by kilometres.
 * Each notice goes once per transit and destination. A transit is known by its body and its time, within SAME_TRANSIT_MS,
 * so a recomputation that moves it by seconds is still the same transit.
 */
import { sendToChannel, sendToDevice, type DeliveryResult } from './delivery.js';
import { getAlertState, listAlertChannels, listAlertDevices, setAlertState } from './store.js';
import type { AlertEvent } from './types.js';
import { getActiveSite } from '../observingSites.js';
import { TransitFinder, type IssTransit } from '../iss/transits.js';
import { getIssTle, type IssTle } from '../iss/tle.js';
import { log } from '../logger.js';

const CHECK_MS = 5 * 60_000;
const RETRY_MS = 15 * 60_000;
const DAY_AHEAD_MS = 24 * 3_600_000;
const FINAL_AHEAD_MS = 2 * 3_600_000;
/** Transits are worked out again this often, and whenever the elements, the site or the widest radius change. */
const RECOMPUTE_MS = 30 * 60_000;

export type TransitStage = 'day' | 'final';

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;
const retryAfter = new Map<string, number>();
let computed: { key: string; at: number; transits: IssTransit[] } | null = null;

const stateKey = (id: string) => `iss.transit.${id}`;
/** Two transits of the same body this close in time are the same one, worked out again. The station takes 90 minutes
 *  to come round, so two real transits of one body near one site are never this close. */
export const SAME_TRANSIT_MS = 10 * 60_000;

/** What a destination was told: per transit (body and time), which notices went. */
export interface ToldTransit { body: IssTransit['body']; time: string; stages: TransitStage[] }

export function findTold(told: readonly ToldTransit[], t: Pick<IssTransit, 'body' | 'time'>): ToldTransit | undefined {
  return told.find(x => x.body === t.body && Math.abs(Date.parse(x.time) - Date.parse(t.time)) < SAME_TRANSIT_MS);
}

/** Which notice is due for this transit now, if any: the day notice in the last 24 hours, the final one in the last 2. */
export function transitStageDue(now: Date, transit: Pick<IssTransit, 'time'>): TransitStage | null {
  const left = Date.parse(transit.time) - now.getTime();
  if (left <= 0) return null;
  if (left <= FINAL_AHEAD_MS) return 'final';
  if (left <= DAY_AHEAD_MS) return 'day';
  return null;
}

interface Destination {
  id: string;
  radiusKm: number;
  send: (event: AlertEvent) => Promise<DeliveryResult>;
}

/** Sends every transit notice that has come due. Returns how many went out. */
export async function runIssTransitAlerts(now: Date, tleSource: () => Promise<IssTle | null> = () => getIssTle({ allowFetch: true })): Promise<number> {
  const destinations: Destination[] = [
    ...listAlertChannels().filter(c => c.enabled && c.events.includes('iss.transit')).map(c => ({
      id: c.id, radiusKm: c.details.issTransitRadiusKm, send: (e: AlertEvent) => sendToChannel(c, e),
    })),
    ...listAlertDevices().filter(d => d.enabled && d.events.includes('iss.transit')).map(d => ({
      id: d.id, radiusKm: d.details.issTransitRadiusKm, send: (e: AlertEvent) => sendToDevice(d, e),
    })),
  ];
  if (destinations.length === 0) return 0;
  const site = getActiveSite();
  if (site.latitude == null || site.longitude == null) return 0;
  const tle = await tleSource();
  if (!tle) return 0;

  const widest = Math.max(...destinations.map(d => d.radiusKm));
  const key = `${tle.epoch}|${site.latitude}|${site.longitude}|${widest}`;
  if (!computed || computed.key !== key || now.getTime() - computed.at > RECOMPUTE_MS) {
    const finder = new TransitFinder(tle.record.line1, tle.record.line2, { lat: site.latitude, lon: site.longitude });
    const to = new Date(now.getTime() + DAY_AHEAD_MS + 3_600_000);
    computed = {
      key,
      at: now.getTime(),
      transits: [...finder.find('moon', now, to, widest), ...finder.find('sun', now, to, widest)],
    };
  }

  let sent = 0;
  for (const d of destinations) {
    if ((retryAfter.get(d.id) ?? 0) > now.getTime()) continue;
    const stored = getAlertState<unknown>(stateKey(d.id));
    const told: ToldTransit[] = Array.isArray(stored) ? (stored as ToldTransit[]) : [];
    for (const transit of computed.transits) {
      if (transit.nearest.distanceKm > d.radiusKm) continue;
      const stage = transitStageDue(now, transit);
      if (!stage) continue;
      const already = findTold(told, transit);
      if (already?.stages.includes(stage)) continue;
      const outcome = await d.send({
        type: 'iss.transit',
        occurredAt: now.toISOString(),
        data: {
          siteName: site.name, timeZone: site.timezone, body: transit.body, time: transit.time, durationSec: transit.durationSec,
          distanceKm: transit.nearest.distanceKm, bearingDeg: transit.nearest.bearingDeg, siteInBand: transit.siteInBand,
          bandHalfWidthKm: transit.bandHalfWidthKm, stage, tleAgeHours: tle.ageHours,
        },
      });
      if (!outcome.ok) {
        retryAfter.set(d.id, now.getTime() + RETRY_MS);
        break;
      }
      // A final notice also stands for a day notice that never went (a transit found less than 2 hours ahead).
      const stages: TransitStage[] = stage === 'final' ? ['day', 'final'] : [...(already?.stages ?? []), stage];
      if (already) {
        already.stages = stages;
        already.time = transit.time;
      } else {
        told.push({ body: transit.body, time: transit.time, stages });
      }
      sent++;
    }
    // Forget transits that are over.
    setAlertState(stateKey(d.id), told.filter(x => Date.parse(x.time) > now.getTime() - 3_600_000));
  }
  return sent;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runIssTransitAlerts(new Date());
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[alerts] ISS transit check failed');
  } finally {
    running = false;
  }
}

export function startIssTransitScheduler(): void {
  stopIssTransitScheduler();
  interval = setInterval(() => { void tick(); }, CHECK_MS);
}

export function stopIssTransitScheduler(): void {
  if (interval) clearInterval(interval);
  interval = null;
}

export function _resetIssTransitAlertsForTests(): void {
  retryAfter.clear();
  computed = null;
}
