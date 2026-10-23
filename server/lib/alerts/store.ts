/**
 * Alert channels and options, in the `alertChannels` / `alertState` tables.
 *
 * Channel URLs and signing secrets are encrypted at rest (secretBox): a
 * Discord or Slack webhook URL is itself the credential, and an ntfy topic
 * name is often the only thing keeping it private.
 */
import { createHash, randomUUID } from 'crypto';
import db from '../db.js';
import { decrypt, encrypt } from '../crypto/secretBox.js';
import {
  ALERT_CHANNEL_KINDS,
  ALERT_EVENTS,
  ALERT_LANGUAGES,
  DEFAULT_ALERT_CONFIG,
  DEFAULT_DEVICE_EVENTS,
  type AlertChannel,
  type AlertChannelKind,
  type AlertDevice,
  type AlertLanguage,
  type AlertConfig,
  type AlertDetails,
  type AlertEventType,
  DEW_LEAD_DEFAULT_MINUTES,
  DEW_LEAD_MAX_MINUTES,
  DEW_LEAD_MIN_MINUTES,
  NO_ALERT_DETAILS,
} from './types.js';

interface ChannelRow {
  id: string;
  name: string;
  kind: string;
  url: string;
  secret: string | null;
  events: string;
  details: string;
  enabled: number;
  createdAt: string;
  lastSentAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

const stmts = {
  all: db.prepare<[], ChannelRow>('SELECT * FROM alertChannels ORDER BY createdAt, id'),
  get: db.prepare<[string], ChannelRow>('SELECT * FROM alertChannels WHERE id = ?'),
  insert: db.prepare(
    `INSERT INTO alertChannels (id, name, kind, url, secret, events, details, enabled, createdAt)
     VALUES (@id, @name, @kind, @url, @secret, @events, @details, @enabled, @createdAt)`,
  ),
  update: db.prepare(
    `UPDATE alertChannels SET name = @name, kind = @kind, url = @url, secret = @secret,
       events = @events, details = @details, enabled = @enabled WHERE id = @id`,
  ),
  remove: db.prepare<[string]>('DELETE FROM alertChannels WHERE id = ?'),
  result: db.prepare(
    'UPDATE alertChannels SET lastSentAt = @at, lastStatus = @status, lastError = @error WHERE id = @id',
  ),
  getState: db.prepare<[string], { value: string }>('SELECT value FROM alertState WHERE key = ?'),
  setState: db.prepare('INSERT OR REPLACE INTO alertState (key, value) VALUES (?, ?)'),
  removeState: db.prepare<[string]>('DELETE FROM alertState WHERE key = ?'),
};

function safeDecrypt(blob: string | null): string | null {
  if (!blob) return null;
  try {
    return decrypt(blob);
  } catch {
    // Data key rotated or blob damaged: treat as unset rather than crash the
    // whole list. The admin sees an empty URL and can re-enter it.
    return null;
  }
}

function parseEvents(raw: string): AlertEventType[] {
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((e): e is AlertEventType => (ALERT_EVENTS as readonly string[]).includes(String(e)))
      : [];
  } catch {
    return [];
  }
}

/** The switches, each only ever true or false; anything else, or nothing stored, reads as off. */
export function parseDetails(raw: string | null | undefined): AlertDetails {
  try {
    const v = JSON.parse(raw ?? '{}') as Partial<Record<keyof AlertDetails, unknown>> | null;
    return { dew: v?.dew === true, plan: v?.plan === true, dewLeadMinutes: leadOrDefault(v?.dewLeadMinutes) };
  } catch {
    return { ...NO_ALERT_DETAILS };
  }
}

/** A stored lead time is only trusted when it is a whole number of minutes in range. */
function leadOrDefault(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= DEW_LEAD_MIN_MINUTES && v <= DEW_LEAD_MAX_MINUTES ? v : DEW_LEAD_DEFAULT_MINUTES;
}

/** A change to some of the switches leaves the others as they were. */
export function mergeDetails(current: AlertDetails, patch: Partial<AlertDetails> | undefined): AlertDetails {
  return { dew: patch?.dew ?? current.dew, plan: patch?.plan ?? current.plan, dewLeadMinutes: patch?.dewLeadMinutes === undefined ? current.dewLeadMinutes : leadOrDefault(patch.dewLeadMinutes) };
}

function fromRow(row: ChannelRow): AlertChannel {
  return {
    id: row.id,
    name: row.name,
    kind: (ALERT_CHANNEL_KINDS as readonly string[]).includes(row.kind) ? (row.kind as AlertChannelKind) : 'webhook',
    url: safeDecrypt(row.url) ?? '',
    secret: safeDecrypt(row.secret),
    events: parseEvents(row.events),
    details: parseDetails(row.details),
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    lastSentAt: row.lastSentAt,
    lastStatus: row.lastStatus === 'ok' || row.lastStatus === 'error' ? row.lastStatus : null,
    lastError: row.lastError,
  };
}

export function listAlertChannels(): AlertChannel[] {
  return stmts.all.all().map(fromRow);
}

export function getAlertChannel(id: string): AlertChannel | null {
  const row = stmts.get.get(id);
  return row ? fromRow(row) : null;
}

export interface AlertChannelInput {
  name: string;
  kind: AlertChannelKind;
  url: string;
  secret?: string | null;
  events: AlertEventType[];
  details?: Partial<AlertDetails>;
  enabled?: boolean;
}

function toParams(id: string, input: AlertChannelInput) {
  return {
    id,
    name: input.name.trim(),
    kind: input.kind,
    url: encrypt(input.url.trim()),
    secret: input.secret ? encrypt(input.secret) : null,
    events: JSON.stringify([...new Set(input.events)]),
    details: JSON.stringify(mergeDetails(NO_ALERT_DETAILS, input.details)),
    enabled: input.enabled === false ? 0 : 1,
  };
}

export function createAlertChannel(input: AlertChannelInput): AlertChannel {
  const id = randomUUID();
  stmts.insert.run({ ...toParams(id, input), createdAt: new Date().toISOString() });
  return getAlertChannel(id)!;
}

/**
 * Update a channel. `url` and `secret` left undefined keep their stored
 * value, so the UI never has to send a secret back that it was never shown.
 * `secret: null` clears it.
 */
export function updateAlertChannel(
  id: string,
  patch: Partial<Omit<AlertChannelInput, 'url' | 'secret'>> & { url?: string; secret?: string | null },
): AlertChannel | null {
  const current = getAlertChannel(id);
  if (!current) return null;
  stmts.update.run(toParams(id, {
    name: patch.name ?? current.name,
    kind: patch.kind ?? current.kind,
    url: patch.url ?? current.url,
    secret: patch.secret === undefined ? current.secret : patch.secret,
    events: patch.events ?? current.events,
    details: mergeDetails(current.details, patch.details),
    enabled: patch.enabled ?? current.enabled,
  }));
  return getAlertChannel(id);
}

/** A removed destination forgets which night it was last warned of dew, so adding it back is not met by a warning already counted as sent. */
function forgetDewWarnings(id: string): void {
  stmts.removeState.run(`dew.sent.${id}`);
}

export function deleteAlertChannel(id: string): boolean {
  forgetDewWarnings(id);
  return stmts.remove.run(id).changes > 0;
}

export function recordDeliveryResult(id: string, ok: boolean, error: string | null): void {
  stmts.result.run({ id, at: new Date().toISOString(), status: ok ? 'ok' : 'error', error: ok ? null : error });
}

// ─── iPhones ─────────────────────────────────────────────────────────────────

interface DeviceRow {
  id: string;
  name: string;
  apnsEnv: string;
  token: string;
  credential: string;
  language: string | null;
  events: string;
  details: string;
  enabled: number;
  createdAt: string;
  lastSentAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

const deviceStmts = {
  all: db.prepare<[], DeviceRow>('SELECT * FROM alertDevices ORDER BY createdAt, id'),
  get: db.prepare<[string], DeviceRow>('SELECT * FROM alertDevices WHERE id = ?'),
  insert: db.prepare(
    `INSERT INTO alertDevices (id, name, apnsEnv, token, credential, language, events, details, enabled, createdAt)
     VALUES (@id, @name, @apnsEnv, @token, @credential, @language, @events, '{}', 1, @createdAt)`,
  ),
  refresh: db.prepare(
    'UPDATE alertDevices SET name = @name, apnsEnv = @apnsEnv, token = @token, credential = @credential, language = @language WHERE id = @id',
  ),
  update: db.prepare('UPDATE alertDevices SET name = @name, events = @events, details = @details, enabled = @enabled WHERE id = @id'),
  remove: db.prepare<[string]>('DELETE FROM alertDevices WHERE id = ?'),
  result: db.prepare('UPDATE alertDevices SET lastSentAt = @at, lastStatus = @status, lastError = @error WHERE id = @id'),
};

/** The same phone always maps to the same id, so registering again refreshes the row instead of adding a second. */
export function deviceIdFor(token: string): string {
  return createHash('sha256').update(token.toLowerCase()).digest('hex').slice(0, 24);
}

function deviceFromRow(row: DeviceRow): AlertDevice | null {
  const token = safeDecrypt(row.token);
  const credential = safeDecrypt(row.credential);
  // A token that no longer decrypts (data key rotated) is useless: the phone registers again when it next opens.
  if (!token || !credential) return null;
  return {
    id: row.id,
    name: row.name,
    apnsEnv: row.apnsEnv === 'sandbox' ? 'sandbox' : 'production',
    token,
    credential,
    language: (ALERT_LANGUAGES as readonly string[]).includes(String(row.language)) ? (row.language as AlertLanguage) : null,
    events: parseEvents(row.events),
    details: parseDetails(row.details),
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    lastSentAt: row.lastSentAt,
    lastStatus: row.lastStatus === 'ok' || row.lastStatus === 'error' ? row.lastStatus : null,
    lastError: row.lastError,
  };
}

export function listAlertDevices(): AlertDevice[] {
  return deviceStmts.all.all().flatMap(row => deviceFromRow(row) ?? []);
}

export function getAlertDevice(id: string): AlertDevice | null {
  const row = deviceStmts.get.get(id);
  return row ? deviceFromRow(row) : null;
}

export interface AlertDeviceRegistration {
  token: string;
  apnsEnv: 'production' | 'sandbox';
  credential: string;
  name: string;
  language?: AlertLanguage | null;
}

/**
 * A phone registering (or registering again after Apple changed its token or the relay reissued its credential).
 * A new phone starts on the default events; a known one keeps the events and the on/off switch the admin set.
 */
export function registerAlertDevice(input: AlertDeviceRegistration): { device: AlertDevice; created: boolean } {
  const id = deviceIdFor(input.token);
  const existing = deviceStmts.get.get(id);
  const params = {
    id,
    name: input.name.trim(),
    apnsEnv: input.apnsEnv,
    token: encrypt(input.token.toLowerCase()),
    credential: encrypt(input.credential),
    language: input.language ?? null,
  };
  if (existing) deviceStmts.refresh.run(params);
  else deviceStmts.insert.run({ ...params, events: JSON.stringify(DEFAULT_DEVICE_EVENTS), createdAt: new Date().toISOString() });
  return { device: getAlertDevice(id)!, created: !existing };
}

export function updateAlertDevice(
  id: string,
  patch: { name?: string; events?: AlertEventType[]; details?: Partial<AlertDetails>; enabled?: boolean },
): AlertDevice | null {
  const current = getAlertDevice(id);
  if (!current) return null;
  deviceStmts.update.run({
    id,
    name: (patch.name ?? current.name).trim(),
    events: JSON.stringify([...new Set(patch.events ?? current.events)]),
    details: JSON.stringify(mergeDetails(current.details, patch.details)),
    enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
  });
  return getAlertDevice(id);
}

export function deleteAlertDevice(id: string): boolean {
  forgetDewWarnings(id);
  return deviceStmts.remove.run(id).changes > 0;
}

export function recordDeviceResult(id: string, ok: boolean, error: string | null): void {
  deviceStmts.result.run({ id, at: new Date().toISOString(), status: ok ? 'ok' : 'error', error: ok ? null : error });
}

/** Whether anything (a channel or a phone) is set to receive this event. The evening check skips its work when not. */
export function hasAlertListener(type: AlertEventType): boolean {
  return listAlertChannels().some(c => c.enabled && c.events.includes(type))
    || listAlertDevices().some(d => d.enabled && d.events.includes(type));
}

// ─── Options and bookkeeping ────────────────────────────────────────────────

export function getAlertState<T>(key: string): T | null {
  const row = stmts.getState.get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setAlertState(key: string, value: unknown): void {
  stmts.setState.run(key, JSON.stringify(value));
}

/** Evening only (12:00-23:59): the check evaluates the local calendar date as the night, so a time after
 *  midnight would look at the wrong night. */
export const EVENING_HHMM = /^(1[2-9]|2[0-3]):[0-5]\d$/;

/** Stored options merged over the defaults, each field checked. */
export function getAlertConfig(): AlertConfig {
  const stored = getAlertState<Partial<AlertConfig>>('config') ?? {};
  const cn: Partial<AlertConfig['clearNight']> = stored.clearNight ?? {};
  const d = DEFAULT_ALERT_CONFIG;
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  return {
    language: (ALERT_LANGUAGES as readonly string[]).includes(String(stored.language))
      ? (stored.language as AlertConfig['language'])
      : d.language,
    clearNight: {
      checkTime: typeof cn.checkTime === 'string' && EVENING_HHMM.test(cn.checkTime) ? cn.checkTime : d.clearNight.checkTime,
      minClearHours: num(cn.minClearHours, 0.5, 14, d.clearNight.minClearHours),
      maxCloudCover: num(cn.maxCloudCover, 0, 100, d.clearNight.maxCloudCover),
    },
  };
}

export function setAlertConfig(patch: { language?: AlertConfig['language']; clearNight?: Partial<AlertConfig['clearNight']> }): AlertConfig {
  const current = getAlertConfig();
  setAlertState('config', {
    language: patch.language ?? current.language,
    clearNight: { ...current.clearNight, ...(patch.clearNight ?? {}) },
  });
  return getAlertConfig();
}
