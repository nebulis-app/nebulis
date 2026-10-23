/**
 * Alerts — channels (webhook, ntfy, Discord, Slack), their events, and the
 * alert options. Admin only: a channel URL is a credential.
 *
 * URLs and secrets are write-only from the API's point of view: responses
 * carry a masked preview of the URL and whether a secret is set, never the
 * values, and an update that leaves them out keeps what is stored.
 *
 * See server/lib/alerts for the events and how they are sent.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import {
  createAlertChannel,
  deleteAlertChannel,
  deleteAlertDevice,
  getAlertChannel,
  getAlertConfig,
  getAlertDevice,
  listAlertChannels,
  listAlertDevices,
  registerAlertDevice,
  setAlertConfig,
  updateAlertChannel,
  updateAlertDevice,
  EVENING_HHMM,
} from '../lib/alerts/store.js';
import { pushRelayUrl, sendToChannel, sendToDevice } from '../lib/alerts/delivery.js';
import { lastClearNightCheck, nextClearNightCheck, runClearNightCheck } from '../lib/alerts/clearNight.js';
import { getActiveSite } from '../lib/observingSites.js';
import {
  ALERT_CHANNEL_KINDS, ALERT_EVENTS, ALERT_LANGUAGES, DEFAULT_DEVICE_EVENTS, DEW_LEAD_MAX_MINUTES, DEW_LEAD_MIN_MINUTES,
  type AlertChannel, type AlertDevice, type AlertEvent,
} from '../lib/alerts/types.js';

const router = Router();
router.use(requireAdmin);

const HttpUrl = z.string().trim().max(2000).refine(v => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'Enter an http:// or https:// URL');

/** The optional lines of the clear-night alert; a switch left out keeps its stored value. */
const Details = z.object({
  dew: z.boolean().optional(),
  plan: z.boolean().optional(),
  dewLeadMinutes: z.number().int().min(DEW_LEAD_MIN_MINUTES).max(DEW_LEAD_MAX_MINUTES).optional(),
});

const ChannelBody = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(ALERT_CHANNEL_KINDS),
  url: HttpUrl,
  secret: z.string().max(200).nullable().optional(),
  events: z.array(z.enum(ALERT_EVENTS)).max(ALERT_EVENTS.length),
  details: Details.optional(),
  enabled: z.boolean().optional(),
});

const ChannelPatch = ChannelBody.partial();

const DeviceRegistration = z.object({
  token: z.string().regex(/^[0-9a-fA-F]{64,200}$/, 'Not an Apple device token'),
  env: z.enum(['production', 'sandbox']),
  credential: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(100),
  language: z.enum(ALERT_LANGUAGES).nullable().optional(),
});

const DevicePatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  events: z.array(z.enum(ALERT_EVENTS)).max(ALERT_EVENTS.length).optional(),
  details: Details.optional(),
  enabled: z.boolean().optional(),
});

const ConfigBody = z.object({
  language: z.enum(ALERT_LANGUAGES).optional(),
  clearNight: z.object({
    checkTime: z.string().regex(EVENING_HHMM).optional(),
    minClearHours: z.number().min(0.5).max(14).optional(),
    maxCloudCover: z.number().int().min(0).max(100).optional(),
  }).optional(),
});

/** "https://discord.com/…a1b2": enough to recognise a channel, not to use it. */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const rest = `${u.pathname}${u.search}`;
    const tail = rest.length > 4 ? rest.slice(-4) : '';
    return `${u.protocol}//${u.host}${rest.length > 1 ? `/…${tail}` : ''}`;
  } catch {
    return '';
  }
}

function present(c: AlertChannel) {
  const { url, secret, ...rest } = c;
  return { ...rest, urlPreview: maskUrl(url), hasSecret: secret !== null };
}

/** A phone as the settings page sees it: never its Apple token or relay credential. */
function presentDevice(d: AlertDevice) {
  // Listed field by field, so a field added to a device later is not sent to a browser by accident.
  return {
    id: d.id, name: d.name, apnsEnv: d.apnsEnv, language: d.language, events: d.events, details: d.details, enabled: d.enabled,
    createdAt: d.createdAt, lastSentAt: d.lastSentAt, lastStatus: d.lastStatus, lastError: d.lastError,
  };
}

function invalid(res: Response, error: z.ZodError): void {
  res.apiError(422, 'VALIDATION_ERROR', error.issues[0]?.message ?? 'Invalid request body');
}

router.get('/', (_req: Request, res: Response) => {
  const config = getAlertConfig();
  const last = lastClearNightCheck();
  res.apiSuccess({
    channels: listAlertChannels().map(present),
    devices: listAlertDevices().map(presentDevice),
    config,
    events: ALERT_EVENTS,
    lastClearNightCheck: last,
    // When the evening check runs next, and in which time zone, so the page can say so instead of leaving it to be guessed.
    nextClearNightCheck: (() => {
      const site = getActiveSite();
      return { ...nextClearNightCheck(new Date(), config.clearNight.checkTime, site.timezone, last?.night ?? null), timeZone: site.timezone };
    })(),
  });
});

router.post('/channels', (req: Request, res: Response) => {
  const parsed = ChannelBody.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  res.status(201);
  res.apiSuccess(present(createAlertChannel(parsed.data)));
});

router.put('/channels/:id', (req: Request, res: Response) => {
  const parsed = ChannelPatch.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const updated = updateAlertChannel(String(req.params.id), parsed.data);
  if (!updated) {
    res.apiError(404, 'NOT_FOUND', 'Alert channel not found');
    return;
  }
  res.apiSuccess(present(updated));
});

router.delete('/channels/:id', (req: Request, res: Response) => {
  if (!deleteAlertChannel(String(req.params.id))) {
    res.apiError(404, 'NOT_FOUND', 'Alert channel not found');
    return;
  }
  res.apiSuccess({ deleted: true });
});

// Send a test alert to one channel, whatever its events, and say how it went.
router.post('/channels/:id/test', async (req: Request, res: Response) => {
  const channel = getAlertChannel(String(req.params.id));
  if (!channel) {
    res.apiError(404, 'NOT_FOUND', 'Alert channel not found');
    return;
  }
  const result = await sendToChannel(channel, { type: 'test', occurredAt: new Date().toISOString(), data: {} });
  res.apiSuccess({ ...result, channel: present(getAlertChannel(channel.id) ?? channel) });
});

// ─── iPhones ────────────────────────────────────────────────────────────────

// What a phone needs before it registers: where the push relay is, and what a new phone starts on.
router.get('/push-info', (_req: Request, res: Response) => {
  res.apiSuccess({ relayUrl: pushRelayUrl(), defaultEvents: DEFAULT_DEVICE_EVENTS, events: ALERT_EVENTS });
});

// A phone registering, or registering again with a fresh Apple token or relay credential. Admin only, like the rest:
// alerts say what the server is doing, so the phone that gets them belongs to someone who may see that.
router.post('/devices', (req: Request, res: Response) => {
  const parsed = DeviceRegistration.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const { token, env, credential, name, language } = parsed.data;
  const { device, created } = registerAlertDevice({ token, apnsEnv: env, credential, name, language });
  res.status(created ? 201 : 200);
  res.apiSuccess(presentDevice(device));
});

// One phone, so the phone can tell whether the server still knows it (an administrator may have removed it).
router.get('/devices/:id', (req: Request, res: Response) => {
  const device = getAlertDevice(String(req.params.id));
  if (!device) {
    res.apiError(404, 'NOT_FOUND', 'Phone not found');
    return;
  }
  res.apiSuccess(presentDevice(device));
});

router.put('/devices/:id', (req: Request, res: Response) => {
  const parsed = DevicePatch.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const updated = updateAlertDevice(String(req.params.id), parsed.data);
  if (!updated) {
    res.apiError(404, 'NOT_FOUND', 'Phone not found');
    return;
  }
  res.apiSuccess(presentDevice(updated));
});

router.delete('/devices/:id', (req: Request, res: Response) => {
  if (!deleteAlertDevice(String(req.params.id))) {
    res.apiError(404, 'NOT_FOUND', 'Phone not found');
    return;
  }
  res.apiSuccess({ deleted: true });
});

router.post('/devices/:id/test', async (req: Request, res: Response) => {
  const device = getAlertDevice(String(req.params.id));
  if (!device) {
    res.apiError(404, 'NOT_FOUND', 'Phone not found');
    return;
  }
  const result = await sendToDevice(device, { type: 'test', occurredAt: new Date().toISOString(), data: {} });
  const after = getAlertDevice(device.id);
  res.apiSuccess({ ...result, removed: after === null, device: after ? presentDevice(after) : null });
});

router.put('/config', (req: Request, res: Response) => {
  const parsed = ConfigBody.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  res.apiSuccess(setAlertConfig(parsed.data));
});

// What tonight's clear-night check would say right now, without sending it.
router.post('/clear-night/preview', async (_req: Request, res: Response) => {
  res.apiSuccess(await runClearNightCheck(new Date(), false));
});

/** Sends one event per phone and says how it went: how many got it, and any that did not, by name and with the reason. */
async function sendToEachPhone(phones: AlertDevice[], eventFor: (d: AlertDevice) => AlertEvent) {
  const outcomes = await Promise.all(phones.map(async d => ({ d, result: await sendToDevice(d, eventFor(d)) })));
  const failed = outcomes
    .filter(o => !o.result.ok)
    .map(o => ({ name: o.d.name, error: getAlertDevice(o.d.id) === null ? 'Apple no longer accepts notifications from this phone.' : (o.result.error ?? '') }));
  return { sent: outcomes.length - failed.length, failed };
}

/**
 * Sends tonight's clear-night alert, as it would go out, to every iPhone that is switched on, so its look can be judged on a real lock screen.
 * Each phone gets the lines it chose. It goes whether or not tonight would qualify, and it does not count as tonight's alert having been sent.
 */
router.post('/clear-night/send-to-phones', async (_req: Request, res: Response) => {
  const phones = listAlertDevices().filter(d => d.enabled);
  const check = await runClearNightCheck(new Date(), false);
  if (!check.result || phones.length === 0) {
    res.apiSuccess({ sent: 0, failed: [], phones: phones.length, check });
    return;
  }
  const event: AlertEvent = { type: 'night.clear', occurredAt: new Date().toISOString(), data: check.result };
  res.apiSuccess({ ...(await sendToEachPhone(phones, () => event)), phones: phones.length, check });
});

/**
 * Sends a dew warning to every switched-on iPhone that asked for them, to judge how it looks. It uses tonight's real dew forecast when there
 * is a risk; with none, it uses example times and says so (`sample`), since a warning that cannot be seen is a warning that cannot be judged.
 * Each phone's own lead time is shown. It does not count as tonight's warning having gone.
 */
router.post('/dew/send-to-phones', async (_req: Request, res: Response) => {
  const phones = listAlertDevices().filter(d => d.enabled && d.events.includes('night.dew'));
  const check = await runClearNightCheck(new Date(), false);
  if (!check.result || phones.length === 0) {
    res.apiSuccess({ sent: 0, failed: [], phones: phones.length, sample: false, check });
    return;
  }
  const r = check.result;
  const real = r.dew && r.dew.level !== 'none' && r.dew.from ? { level: r.dew.level, from: r.dew.from } : null;
  const outcome = await sendToEachPhone(phones, d => ({
    type: 'night.dew',
    occurredAt: new Date().toISOString(),
    data: {
      siteName: r.siteName, night: r.night, timeZone: r.timeZone, level: real?.level ?? ('likely' as const),
      from: real?.from ?? new Date(Date.now() + 3 * 3_600_000).toISOString(), lowTempC: r.dew?.lowTempC ?? 4, leadMinutes: d.details.dewLeadMinutes,
    },
  }));
  res.apiSuccess({ ...outcome, phones: phones.length, sample: real === null, check });
});

export { router as alertsRouter };
