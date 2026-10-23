import { fetchJSON } from './client';

/**
 * Alerts — where Nebulis sends what it notices on its own (an import finished,
 * a clear night ahead…). Mirrors server/routes/alerts.ts. Admin only.
 *
 * Channel URLs and secrets are write-only: the server returns a masked
 * `urlPreview` and `hasSecret`, and an update that leaves `url` / `secret`
 * out keeps the stored value.
 */
export const ALERT_CHANNEL_KINDS = ['ntfy', 'discord', 'slack', 'webhook'] as const;
export type AlertChannelKind = (typeof ALERT_CHANNEL_KINDS)[number];

export const ALERT_EVENTS = ['night.clear', 'night.dew', 'import.finished', 'import.failed', 'update.available'] as const;
export type AlertEventType = (typeof ALERT_EVENTS)[number];

export const ALERT_LANGUAGES = ['en', 'fr', 'de', 'es', 'nl'] as const;
export type AlertLanguage = (typeof ALERT_LANGUAGES)[number];

/** Optional lines of the clear-night alert, chosen separately for each channel and each phone. Both are off until chosen. */
export interface AlertDetails {
  dew: boolean;
  plan: boolean;
  /** For the dew warning: minutes before the dew is expected to send it. */
  dewLeadMinutes: number;
}

/** How far ahead of the dew a warning can be set to go, in minutes. A stored value outside these (set elsewhere) is still shown. */
export const DEW_LEAD_CHOICES = [30, 60, 120, 180] as const;

/** Nothing extra: how every channel and phone starts. */
export const NO_ALERT_DETAILS: AlertDetails = { dew: false, plan: false, dewLeadMinutes: 60 };

export interface AlertChannel {
  id: string;
  name: string;
  kind: AlertChannelKind;
  urlPreview: string;
  hasSecret: boolean;
  events: AlertEventType[];
  details?: AlertDetails;
  enabled: boolean;
  createdAt: string;
  lastSentAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
}

/** An iPhone that gets alerts as push notifications. Its Apple token and relay credential never reach the browser. */
export interface AlertDevice {
  id: string;
  name: string;
  apnsEnv: 'production' | 'sandbox';
  language: AlertLanguage | null;
  events: AlertEventType[];
  details?: AlertDetails;
  enabled: boolean;
  createdAt: string;
  lastSentAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
}

export interface AlertConfig {
  language: AlertLanguage;
  clearNight: { checkTime: string; minClearHours: number; maxCloudCover: number };
}

export interface ClearNightResult {
  siteName: string;
  night: string;
  timeZone: string;
  clearHours: number;
  darkHours: number;
  longestStart: string;
  longestEnd: string;
  maxCloudCover: number;
  seeing: number | null;
  moonIllumination: number;
  moonDownHours: number;
}

export interface ClearNightCheck {
  night: string;
  checkedAt: string;
  result: ClearNightResult | null;
  sent: boolean;
  reason: 'sent' | 'not_clear_enough' | 'no_forecast' | 'no_dark_window' | 'no_site' | 'preview';
}

/** When the evening clear-night check runs next. `now` means it is due and runs within the minute. */
export interface NextClearNightCheck {
  at: string;
  when: 'now' | 'today' | 'tomorrow';
  timeZone: string;
}

export interface AlertsOverview {
  channels: AlertChannel[];
  devices: AlertDevice[];
  config: AlertConfig;
  lastClearNightCheck: ClearNightCheck | null;
  nextClearNightCheck?: NextClearNightCheck;
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

export interface AlertTestResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  channel: AlertChannel;
}

export const getAlerts = () => fetchJSON<AlertsOverview>('/alerts');

export const createAlertChannel = (input: AlertChannelInput) =>
  fetchJSON<AlertChannel>('/alerts/channels', { method: 'POST', body: JSON.stringify(input) });

export const updateAlertChannel = (id: string, patch: Partial<AlertChannelInput>) =>
  fetchJSON<AlertChannel>(`/alerts/channels/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });

export const deleteAlertChannel = (id: string) =>
  fetchJSON<{ deleted: boolean }>(`/alerts/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const testAlertChannel = (id: string) =>
  fetchJSON<AlertTestResult>(`/alerts/channels/${encodeURIComponent(id)}/test`, { method: 'POST' });

export const updateAlertConfig = (patch: { language?: AlertLanguage; clearNight?: Partial<AlertConfig['clearNight']> }) =>
  fetchJSON<AlertConfig>('/alerts/config', { method: 'PUT', body: JSON.stringify(patch) });

/** What sending tonight's alert to the iPhones from the settings page did: how many got it, and any that did not, with the reason. */
export interface PhoneSampleResult {
  /** True when tonight has no dew risk, so the warning used example times to show its layout. */
  sample?: boolean;
  sent: number;
  failed: { name: string; error: string }[];
  phones: number;
  check: ClearNightCheck;
}

export const sendDewWarningToPhones = () =>
  fetchJSON<PhoneSampleResult>('/alerts/dew/send-to-phones', { method: 'POST' });

export const sendClearNightToPhones = () =>
  fetchJSON<PhoneSampleResult>('/alerts/clear-night/send-to-phones', { method: 'POST' });

export const previewClearNight = () =>
  fetchJSON<ClearNightCheck>('/alerts/clear-night/preview', { method: 'POST' });

export const updateAlertDevice = (id: string, patch: { name?: string; events?: AlertEventType[]; details?: Partial<AlertDetails>; enabled?: boolean }) =>
  fetchJSON<AlertDevice>(`/alerts/devices/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });

export const deleteAlertDevice = (id: string) =>
  fetchJSON<{ deleted: boolean }>(`/alerts/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** `removed` is true when Apple said the phone no longer takes notifications, so the server forgot it. */
export const testAlertDevice = (id: string) =>
  fetchJSON<{ ok: boolean; status: number | null; error: string | null; removed: boolean; device: AlertDevice | null }>(
    `/alerts/devices/${encodeURIComponent(id)}/test`, { method: 'POST' });
