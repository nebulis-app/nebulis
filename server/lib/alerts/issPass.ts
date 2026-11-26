/**
 * "ISS pass": a heads-up shortly before the station becomes visible over the active site, so there is time to step
 * outside or point a camera. Each channel and phone chooses how far ahead (`issLeadMinutes`) and how high a pass has to
 * get to be worth it (`issMinAltitude`), so each is sent its own, once per pass.
 *
 * Passes are worked out from the station's elements (iss/tle.ts, refreshed at most every few hours) for the next
 * hours and kept until the elements or the site change. Old elements still give an alert, saying the times may be
 * minutes off. Off unless a destination subscribes to `iss.pass`.
 */
import { sendToChannel, sendToDevice, type DeliveryResult } from './delivery.js';
import { getAlertState, listAlertChannels, listAlertDevices, setAlertState } from './store.js';
import type { AlertEvent } from './types.js';
import { getActiveSite } from '../observingSites.js';
import { PassCalculator, type IssPass } from '../iss/passes.js';
import { getIssTle, type IssTle } from '../iss/tle.js';
import { log } from '../logger.js';

const RETRY_MS = 5 * 60_000;
/** How far ahead passes are worked out; longer than any lead time. */
const LOOKAHEAD_MS = 3 * 3_600_000;
/** Passes are worked out again this often, and whenever the elements or the site change. */
const RECOMPUTE_MS = 30 * 60_000;
/** Floor for the computation; each destination filters on its own minimum. */
const COMPUTE_MIN_ALT = 10;

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;
const retryAfter = new Map<string, number>();
let computed: { key: string; at: number; passes: IssPass[] } | null = null;

const sentKey = (id: string) => `iss.sent.${id}`;

interface Destination {
  id: string;
  leadMinutes: number;
  minAltitude: number;
  send: (event: AlertEvent) => Promise<DeliveryResult>;
}

/** This pass is visible, high enough for this destination, its lead time has come, and it has not started yet. */
export function issPassDue(now: Date, pass: IssPass, leadMinutes: number, minAltitude: number): boolean {
  if (!pass.visible || pass.visible.peak.alt < minAltitude) return false;
  const start = Date.parse(pass.visible.start.t);
  return now.getTime() >= start - leadMinutes * 60_000 && now.getTime() < start;
}

function passesFor(tle: IssTle, site: { latitude: number; longitude: number }, now: Date): IssPass[] {
  const key = `${tle.epoch}|${site.latitude}|${site.longitude}`;
  if (!computed || computed.key !== key || now.getTime() - computed.at > RECOMPUTE_MS) {
    const passes = new PassCalculator(tle.record.line1, tle.record.line2, site)
      .passes(new Date(now.getTime() - 60_000), new Date(now.getTime() + LOOKAHEAD_MS), COMPUTE_MIN_ALT);
    computed = { key, at: now.getTime(), passes };
  }
  return computed.passes;
}

/** Sends every pass alert that has come due. Returns how many went out. */
export async function runIssPassAlerts(now: Date, tleSource: () => Promise<IssTle | null> = () => getIssTle({ allowFetch: true })): Promise<number> {
  const destinations: Destination[] = [
    ...listAlertChannels().filter(c => c.enabled && c.events.includes('iss.pass')).map(c => ({
      id: c.id, leadMinutes: c.details.issLeadMinutes, minAltitude: c.details.issMinAltitude, send: (e: AlertEvent) => sendToChannel(c, e),
    })),
    ...listAlertDevices().filter(d => d.enabled && d.events.includes('iss.pass')).map(d => ({
      id: d.id, leadMinutes: d.details.issLeadMinutes, minAltitude: d.details.issMinAltitude, send: (e: AlertEvent) => sendToDevice(d, e),
    })),
  ];
  if (destinations.length === 0) return 0;
  const site = getActiveSite();
  if (site.latitude == null || site.longitude == null) return 0;
  const tle = await tleSource();
  if (!tle) return 0;
  const passes = passesFor(tle, { latitude: site.latitude, longitude: site.longitude }, now);

  let sent = 0;
  for (const d of destinations) {
    if ((retryAfter.get(d.id) ?? 0) > now.getTime()) continue;
    const pass = passes.find(p => issPassDue(now, p, d.leadMinutes, d.minAltitude));
    if (!pass?.visible) continue;
    // Once per pass: the pass is known by when it becomes visible.
    if (getAlertState<string>(sentKey(d.id)) === pass.visible.start.t) continue;
    const outcome = await d.send({
      type: 'iss.pass',
      occurredAt: now.toISOString(),
      data: {
        siteName: site.name,
        timeZone: site.timezone,
        start: pass.visible.start.t,
        peak: pass.visible.peak.t,
        end: pass.visible.end.t,
        startAz: pass.visible.start.az,
        peakAz: pass.visible.peak.az,
        endAz: pass.visible.end.az,
        maxAlt: pass.visible.peak.alt,
        magnitude: pass.magnitude,
        endsInShadow: pass.endsInShadow,
        leadMinutes: Math.max(1, Math.round((Date.parse(pass.visible.start.t) - now.getTime()) / 60_000)),
        staleDays: tle.stale ? Math.round(tle.ageHours / 24) : null,
      },
    });
    if (outcome.ok) {
      setAlertState(sentKey(d.id), pass.visible.start.t);
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
    await runIssPassAlerts(new Date());
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[alerts] ISS pass check failed');
  } finally {
    running = false;
  }
}

export function startIssPassScheduler(): void {
  stopIssPassScheduler();
  interval = setInterval(() => { void tick(); }, 60_000);
}

export function stopIssPassScheduler(): void {
  if (interval) clearInterval(interval);
  interval = null;
}

export function _resetIssPassAlertsForTests(): void {
  retryAfter.clear();
  computed = null;
}
