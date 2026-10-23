/**
 * Sending an alert to a channel.
 *
 * Each channel kind gets the request shape its receiver expects:
 *   - webhook: JSON `{ event, title, message, occurredAt, data }`, signed with
 *     HMAC-SHA256 in `X-Nebulis-Signature: sha256=<hex>` when a secret is set,
 *     for Home Assistant, n8n, a script of your own…
 *   - ntfy: the text as the body, the title and tags as query parameters (the
 *     query form works for non-ASCII titles, which headers do not).
 *   - discord / slack: their incoming-webhook JSON (`content` / `text`).
 *
 * Delivery never throws into the caller: an import or a scheduler tick must
 * not fail because a phone was offline. Each attempt's outcome is stored on
 * the channel (lastSentAt / lastStatus / lastError) for the settings page.
 */
import { createHmac } from 'crypto';
import { log } from '../logger.js';
import { formatAlert, type AlertFormatOptions, type AlertMessage } from './messages.js';
import { getSettingsData } from '../telescopes.js';
import {
  deleteAlertDevice, getAlertConfig, listAlertChannels, listAlertDevices, recordDeliveryResult, recordDeviceResult,
} from './store.js';
import type { AlertChannel, AlertDetails, AlertDevice, AlertEvent } from './types.js';

const TIMEOUT_MS = 10_000;
const DISCORD_MAX = 2000;
const SLACK_MAX = 3000;
let retryDelayMs = 5_000;

/** Tests shorten the wait before the single retry. */
export function _setRetryDelayForTests(ms: number): void {
  retryDelayMs = ms;
}

export interface AlertRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** The HTTP request for one channel. Pure, so the shapes are unit-tested. */
export function buildAlertRequest(channel: AlertChannel, event: AlertEvent, message: AlertMessage): AlertRequest {
  switch (channel.kind) {
    case 'ntfy': {
      const url = new URL(channel.url);
      url.searchParams.set('title', message.title);
      if (message.tags.length > 0) url.searchParams.set('tags', message.tags.join(','));
      if (message.url) url.searchParams.set('click', message.url);
      return { url: url.toString(), headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: message.body };
    }
    case 'discord': {
      const text = [`**${message.title}**`, message.body, message.url].filter(Boolean).join('\n');
      return {
        url: channel.url,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: clip(text, DISCORD_MAX), username: 'Nebulis' }),
      };
    }
    case 'slack': {
      const text = [`*${message.title}*`, message.body, message.url].filter(Boolean).join('\n');
      return {
        url: channel.url,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clip(text, SLACK_MAX) }),
      };
    }
    case 'webhook': {
      const body = JSON.stringify({
        source: 'nebulis',
        event: event.type,
        title: message.title,
        message: message.body,
        url: message.url,
        occurredAt: event.occurredAt,
        data: event.data,
      });
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Nebulis-Alerts',
        'X-Nebulis-Event': event.type,
      };
      if (channel.secret) headers['X-Nebulis-Signature'] = signBody(channel.secret, body);
      return { url: channel.url, headers, body };
    }
  }
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

async function attempt(req: AlertRequest): Promise<DeliveryResult> {
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    if (res.ok) return { ok: true, status: res.status, error: null };
    const text = (await res.text().catch(() => '')).trim();
    return { ok: false, status: res.status, error: `HTTP ${res.status}${text ? `: ${clip(text, 200)}` : ''}` };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'TimeoutError' ? 'timed out' : err.message) : String(err);
    return { ok: false, status: null, error: msg };
  }
}

/** One destination's choices about the clear-night lines, and the unit the person reads temperatures in. */
function formatOptions(details: AlertDetails): AlertFormatOptions {
  return {
    details,
    temperatureUnit: getSettingsData().temperatureUnit === 'celsius' ? 'celsius' : 'fahrenheit',
  };
}

/** Send one event to one channel: one retry on a network error or a 5xx,
 *  none on a 4xx (a wrong URL or token won't fix itself). */
export async function sendToChannel(channel: AlertChannel, event: AlertEvent): Promise<DeliveryResult> {
  let req: AlertRequest;
  try {
    req = buildAlertRequest(channel, event, formatAlert(event, getAlertConfig().language, formatOptions(channel.details)));
  } catch (err) {
    const result = { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
    recordDeliveryResult(channel.id, false, result.error);
    return result;
  }
  let result = await attempt(req);
  if (!result.ok && (result.status === null || result.status >= 500)) {
    await new Promise(r => setTimeout(r, retryDelayMs));
    result = await attempt(req);
  }
  recordDeliveryResult(channel.id, result.ok, result.error);
  if (!result.ok) {
    log.warn({ channel: channel.name, kind: channel.kind, event: event.type, error: result.error }, '[alerts] delivery failed');
  }
  return result;
}

// ─── iPhones, through the push relay ────────────────────────────────────────

const DEFAULT_RELAY_URL = 'https://push.nebulis.app';

/**
 * Where phone alerts are sent. The Nebulis relay holds the Apple push key that cannot ship inside software people
 * host themselves; `NEBULIS_PUSH_RELAY_URL` points at a relay of your own instead. Only https (or http on this
 * machine, for development): a token and a credential must not cross a network in the clear.
 */
export function pushRelayUrl(): string {
  const raw = (process.env.NEBULIS_PUSH_RELAY_URL ?? '').trim();
  if (raw) {
    try {
      const u = new URL(raw);
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return raw.replace(/\/+$/, '');
    } catch { /* fall through to the default */ }
    log.warn('[alerts] NEBULIS_PUSH_RELAY_URL is not a usable https URL; using the default relay');
  }
  return DEFAULT_RELAY_URL;
}

/** How long Apple keeps trying while the phone is off: a clear-night notice is stale by morning. */
const DEVICE_TTL_SECONDS: Record<AlertEvent['type'], number> = {
  'night.clear': 4 * 3600,
  'night.dew': 3 * 3600,
  'import.finished': 12 * 3600,
  'import.failed': 12 * 3600,
  'update.available': 24 * 3600,
  test: 300,
};

/** Where tapping the notification lands in the app. */
const DEVICE_LINKS: Partial<Record<AlertEvent['type'], string>> = {
  'night.clear': 'nebulis://sky',
  'night.dew': 'nebulis://sky',
  'import.finished': 'nebulis://library',
  'import.failed': 'nebulis://settings',
};

/**
 * What the phone shows under the title. When the message has a lead line it becomes the subtitle and the rest is the body, so the answer is
 * the first thing read and the lock screen's few lines are not spent on a long first sentence.
 */
function pushText(message: AlertMessage): { subtitle?: string; body: string } {
  const [first, ...rest] = message.body.split('\n');
  if (message.lead && first === message.lead && rest.length > 0) return { subtitle: clip(message.lead, 100), body: clip(rest.join('\n'), 300) };
  return { body: clip(message.body, 300) };
}

/** The relay request for one phone. Pure, so the shape is unit-tested. */
export function buildDeviceRequest(device: AlertDevice, event: AlertEvent, message: AlertMessage): AlertRequest {
  const body: Record<string, unknown> = {
    token: device.token,
    env: device.apnsEnv,
    credential: device.credential,
    title: clip(message.title, 100),
    ...pushText(message),
    threadId: event.type,
    collapseId: event.type,
    ttlSeconds: DEVICE_TTL_SECONDS[event.type],
  };
  const link = message.deepLink ?? DEVICE_LINKS[event.type];
  if (link) body.link = link;
  return { url: `${pushRelayUrl()}/v1/push`, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Nebulis-Alerts' }, body: JSON.stringify(body) };
}

function describeRelayFailure(status: number | null, error: string | null): string {
  switch (status) {
    case 403: return 'The phone needs to register again: open Nebulis on it.';
    case 410: return 'The phone no longer accepts notifications from Nebulis.';
    case 429: return 'The push relay is busy. Try again in a minute.';
    case 502: return 'The push relay could not reach Apple.';
    case 503: return 'Apple is not accepting pushes right now.';
    default: return status === null ? (error ?? 'Could not reach the push relay.') : `The push relay answered ${status}.`;
  }
}

async function relayAttempt(req: AlertRequest): Promise<DeliveryResult> {
  try {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    if (res.ok) return { ok: true, status: res.status, error: null };
    return { ok: false, status: res.status, error: describeRelayFailure(res.status, null) };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'TimeoutError' ? 'The push relay timed out.' : err.message) : String(err);
    return { ok: false, status: null, error: describeRelayFailure(null, msg) };
  }
}

/**
 * Send one event to one phone. Like a channel: one retry on a network error, a busy relay or a 5xx, none on a 4xx.
 * A 410 means Apple has dropped the token (the app was removed, or alerts were turned off on the phone), so the
 * phone is forgotten here; it comes back by registering again.
 */
export async function sendToDevice(device: AlertDevice, event: AlertEvent): Promise<DeliveryResult> {
  const lang = device.language ?? getAlertConfig().language;
  const req = buildDeviceRequest(device, event, formatAlert(event, lang, formatOptions(device.details)));
  let result = await relayAttempt(req);
  if (!result.ok && (result.status === null || result.status === 429 || result.status >= 500)) {
    await new Promise(r => setTimeout(r, retryDelayMs));
    result = await relayAttempt(req);
  }
  if (result.status === 410) {
    deleteAlertDevice(device.id);
    log.info({ device: device.name }, '[alerts] phone no longer registered with Apple; removed');
    return result;
  }
  recordDeviceResult(device.id, result.ok, result.error);
  if (!result.ok) log.warn({ device: device.name, event: event.type, error: result.error }, '[alerts] phone delivery failed');
  return result;
}

/**
 * Send an event to every enabled channel subscribed to it. Resolves once all
 * attempts are done; callers that must not wait (an import finishing) just
 * don't await it.
 */
export async function dispatchAlert(event: AlertEvent): Promise<void> {
  if (event.type === 'test') return;
  const channels = listAlertChannels().filter(c => c.enabled && c.url && c.events.includes(event.type));
  const devices = listAlertDevices().filter(d => d.enabled && d.events.includes(event.type));
  if (channels.length === 0 && devices.length === 0) return;
  await Promise.allSettled([...channels.map(c => sendToChannel(c, event)), ...devices.map(d => sendToDevice(d, event))]);
}

/** Fire-and-forget form for hooks in hot paths. */
export function emitAlert(event: AlertEvent): void {
  dispatchAlert(event).catch(err =>
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[alerts] dispatch failed'));
}
