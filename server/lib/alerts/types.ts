/**
 * Alerts: shapes shared by the store, the delivery and the routes.
 *
 * An alert is an event Nebulis noticed on its own (an import finished, a clear
 * night is coming) sent to one or more channels the admin set up: a generic
 * JSON webhook, an ntfy topic, a Discord or a Slack incoming webhook.
 */

export const ALERT_CHANNEL_KINDS = ['webhook', 'ntfy', 'discord', 'slack'] as const;
export type AlertChannelKind = (typeof ALERT_CHANNEL_KINDS)[number];

/** Events a channel can subscribe to. `test` is not subscribable: it goes to
 *  the one channel being tested. */
export const ALERT_EVENTS = ['import.finished', 'import.failed', 'night.clear', 'night.dew', 'update.available'] as const;
export type AlertEventType = (typeof ALERT_EVENTS)[number];

export const ALERT_LANGUAGES = ['en', 'fr', 'de', 'es', 'nl'] as const;
export type AlertLanguage = (typeof ALERT_LANGUAGES)[number];

export interface AlertChannel {
  id: string;
  name: string;
  kind: AlertChannelKind;
  url: string;
  /** HMAC-SHA256 signing secret for the generic webhook; null when unset. */
  secret: string | null;
  events: AlertEventType[];
  /** Optional lines of the clear-night alert, chosen for this channel. */
  details: AlertDetails;
  enabled: boolean;
  createdAt: string;
  lastSentAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
}

/** An iPhone that gets alerts as push notifications, through the Nebulis push relay. */
export interface AlertDevice {
  /** Derived from the device token, so a phone registering again is the same row. */
  id: string;
  name: string;
  apnsEnv: 'production' | 'sandbox';
  /** Apple's device token, and the credential the relay gave for it. Never sent to a browser. */
  token: string;
  credential: string;
  /** Language of its messages; null follows the alert options. */
  language: AlertLanguage | null;
  events: AlertEventType[];
  /** Optional lines of the clear-night alert, chosen for this phone. */
  details: AlertDetails;
  enabled: boolean;
  createdAt: string;
  lastSentAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
}

/** What a newly registered phone is subscribed to: everything worth a buzz, but not update notices. */
export const DEFAULT_DEVICE_EVENTS: AlertEventType[] = ['night.clear', 'import.finished', 'import.failed'];

/** Event data, by type. Times are ISO strings. */
export interface ImportAlertData {
  source: 'telescope' | 'folder' | 'subframe';
  telescopeName: string | null;
  newFiles: number;
  objects: { objectId: string; name: string; isNew: boolean }[];
  sessions: { objectId: string; objectName: string; date: string }[];
  manual: boolean;
  error: string | null;
}

/** Whether the dark hours are likely to dew over: the temperature closing in on the dew point. */
export interface DewForecast {
  /** `none`: the air stays well above the dew point. `possible`: within about 3 °C. `likely`: within about 1.5 °C. */
  level: 'none' | 'possible' | 'likely';
  /** When the air first gets that close, for `possible` and `likely`. */
  from: string | null;
  /** The coldest hour of the dark window, in °C (the forecast's own unit). */
  lowTempC: number | null;
}

/** What is planned for tonight in the planner. */
export interface TonightPlan {
  /** Distinct objects in order of their first block, skipped blocks left out. */
  objects: string[];
  blocks: number;
}

export interface ClearNightAlertData {
  siteName: string;
  /** Observing night, YYYY-MM-DD (the evening's date). */
  night: string;
  timeZone: string;
  /** Hours of dark sky under the cloud limit. */
  clearHours: number;
  darkHours: number;
  /** Longest clear stretch. */
  longestStart: string;
  longestEnd: string;
  maxCloudCover: number;
  /** Mean 7Timer seeing (1 best – 5) over the clear hours, when known. */
  seeing: number | null;
  moonIllumination: number;
  /** Clear hours with the Moon below the horizon. */
  moonDownHours: number;
  moonRise: string | null;
  moonSet: string | null;
  /** Always worked out; whether the alert says it is the person's choice (`AlertDetails`). Absent on alerts made before this existed. */
  dew?: DewForecast | null;
  plan?: TonightPlan | null;
}

/** A dew warning: sent ahead of the hour the air is forecast to get close to its dew point. */
export interface DewAlertData {
  siteName: string;
  /** Observing night, YYYY-MM-DD (the evening's date). */
  night: string;
  timeZone: string;
  level: 'possible' | 'likely';
  /** The hour the dew is expected from. */
  from: string;
  /** The night's coldest hour in °C, or null when the forecast gave none. */
  lowTempC: number | null;
  /** How long before `from` this warning was set to go out, as chosen for the destination. */
  leadMinutes: number;
}

export interface UpdateAlertData {
  currentVersion: string;
  latestVersion: string;
  notesUrl: string | null;
}

export type AlertEvent =
  | { type: 'import.finished' | 'import.failed'; occurredAt: string; data: ImportAlertData }
  | { type: 'night.clear'; occurredAt: string; data: ClearNightAlertData }
  | { type: 'night.dew'; occurredAt: string; data: DewAlertData }
  | { type: 'update.available'; occurredAt: string; data: UpdateAlertData }
  | { type: 'test'; occurredAt: string; data: Record<string, never> };

/** Extra lines a person can add to the clear-night alert, chosen per channel and per phone. Both are off until chosen. */
export interface AlertDetails {
  /** Dew risk and the night's low temperature. */
  dew: boolean;
  /** What is planned for tonight, and a tap that opens the planner. */
  plan: boolean;
  /** For the dew warning: how many minutes before the dew is expected to send it. */
  dewLeadMinutes: number;
}

/** The dew warning goes out an hour ahead unless asked otherwise, and never closer than 15 minutes or further than 6 hours. */
export const DEW_LEAD_DEFAULT_MINUTES = 60;
export const DEW_LEAD_MIN_MINUTES = 15;
export const DEW_LEAD_MAX_MINUTES = 360;
export const NO_ALERT_DETAILS: AlertDetails = { dew: false, plan: false, dewLeadMinutes: DEW_LEAD_DEFAULT_MINUTES };

export interface AlertConfig {
  language: AlertLanguage;
  clearNight: {
    /** Local time (HH:MM, active site's timezone) the evening check runs. */
    checkTime: string;
    /** Minimum clear dark hours for the alert to go out. */
    minClearHours: number;
    /** Cloud cover (%) at or below which an hour counts as clear. */
    maxCloudCover: number;
  };
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  language: 'en',
  clearNight: { checkTime: '17:00', minClearHours: 3, maxCloudCover: 30 },
};
