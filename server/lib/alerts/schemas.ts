/**
 * Request and response shapes for the alert routes. They live here, not in the
 * route file, so server/routes/openapi.ts can generate the published spec from
 * the same schemas the handlers validate with (see telescopeSchemas.ts).
 *
 * The `Missing` checks at the bottom stop compiling when a field is added to a
 * domain type and not to the response schema. `token` and `credential` on a
 * phone, and `url` and `secret` on a channel, are deliberately absent: they are
 * write-only and never appear in a response.
 */
import { z } from 'zod';
import {
  ALERT_CHANNEL_KINDS,
  ALERT_EVENTS,
  ALERT_LANGUAGES,
  DEW_LEAD_MAX_MINUTES,
  DEW_LEAD_MIN_MINUTES,
  EVENING_HHMM,
  type AlertChannel,
  type AlertConfig,
  type AlertDetails,
  type AlertDevice,
  type ClearNightAlertData,
  type DewForecast,
  type TonightPlan,
} from './types.js';
import type { ClearNightCheck, NextClearNightCheck } from './clearNight.js';
import type { DeliveryResult } from './delivery.js';

/** A channel URL is a credential, so only http(s) is accepted. */
const HttpUrl = z.string().trim().max(2000).refine(v => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'Enter an http:// or https:// URL');

/** The optional lines of the clear-night alert; a switch left out keeps its stored value. */
export const AlertDetailsPatchSchema = z.object({
  dew: z.boolean().optional().describe('Include the dew risk and the night low temperature'),
  plan: z.boolean().optional().describe('Include what is planned for tonight'),
  dewLeadMinutes: z.number().int().min(DEW_LEAD_MIN_MINUTES).max(DEW_LEAD_MAX_MINUTES).optional()
    .describe('Minutes before the expected dew to send the dew warning'),
});

export const AlertChannelBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(ALERT_CHANNEL_KINDS),
  url: HttpUrl,
  secret: z.string().max(200).nullable().optional()
    .describe('HMAC signing secret for a webhook; null clears it, omitting it keeps the stored value'),
  events: z.array(z.enum(ALERT_EVENTS)).max(ALERT_EVENTS.length),
  details: AlertDetailsPatchSchema.optional(),
  enabled: z.boolean().optional(),
});

export const AlertChannelPatchSchema = AlertChannelBodySchema.partial();

export const AlertDeviceRegistrationSchema = z.object({
  token: z.string().regex(/^[0-9a-fA-F]{64,200}$/, 'Not an Apple device token'),
  env: z.enum(['production', 'sandbox']),
  credential: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(100),
  language: z.enum(ALERT_LANGUAGES).nullable().optional(),
});

export const AlertDevicePatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  events: z.array(z.enum(ALERT_EVENTS)).max(ALERT_EVENTS.length).optional(),
  details: AlertDetailsPatchSchema.optional(),
  enabled: z.boolean().optional(),
});

export const AlertConfigBodySchema = z.object({
  language: z.enum(ALERT_LANGUAGES).optional()
    .describe('Language of the alert messages; a phone may override it'),
  clearNight: z.object({
    checkTime: z.string().regex(EVENING_HHMM).optional()
      .describe('Local evening time (HH:MM, 12:00 to 23:59) the clear-night check runs'),
    minClearHours: z.number().min(0.5).max(14).optional(),
    maxCloudCover: z.number().int().min(0).max(100).optional(),
  }).optional(),
});

// ─── Responses ─────────────────────────────────────────────────────────────

export const AlertDetailsSchema = z.object({
  dew: z.boolean(),
  plan: z.boolean(),
  dewLeadMinutes: z.number().int(),
});

export const AlertChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(ALERT_CHANNEL_KINDS),
  events: z.array(z.enum(ALERT_EVENTS)),
  details: AlertDetailsSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
  lastSentAt: z.string().nullable(),
  lastStatus: z.enum(['ok', 'error']).nullable(),
  lastError: z.string().nullable(),
  urlPreview: z.string().describe('Masked URL: host plus the last four characters, enough to recognise the channel'),
  hasSecret: z.boolean(),
});

export const AlertDeviceSchema = z.object({
  id: z.string().describe('Derived from the device token, so registering again is the same row'),
  name: z.string(),
  apnsEnv: z.enum(['production', 'sandbox']),
  language: z.enum(ALERT_LANGUAGES).nullable(),
  events: z.array(z.enum(ALERT_EVENTS)),
  details: AlertDetailsSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
  lastSentAt: z.string().nullable(),
  lastStatus: z.enum(['ok', 'error']).nullable(),
  lastError: z.string().nullable(),
});

export const AlertConfigSchema = z.object({
  language: z.enum(ALERT_LANGUAGES),
  clearNight: z.object({
    checkTime: z.string(),
    minClearHours: z.number(),
    maxCloudCover: z.number().int(),
  }),
});

export const AlertDeliveryResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable().describe('HTTP status from the receiver, or null when it was unreachable'),
  error: z.string().nullable(),
});

export const AlertChannelTestResultSchema = AlertDeliveryResultSchema.extend({
  channel: AlertChannelSchema,
});

export const AlertDeviceTestResultSchema = AlertDeliveryResultSchema.extend({
  removed: z.boolean().describe('The relay said Apple no longer accepts this phone, so the row was removed'),
  device: AlertDeviceSchema.nullable(),
});

export const AlertDewForecastSchema = z.object({
  level: z.enum(['none', 'possible', 'likely']),
  from: z.string().nullable().describe('When the air first gets within reach of the dew point, for possible and likely'),
  lowTempC: z.number().nullable().describe('Coldest dark hour, in the forecast unit'),
});

export const AlertTonightPlanSchema = z.object({
  objects: z.array(z.string()),
  blocks: z.number().int(),
});

export const AlertClearNightDataSchema = z.object({
  siteName: z.string(),
  night: z.string().describe('Observing night, YYYY-MM-DD'),
  timeZone: z.string(),
  clearHours: z.number().describe('Hours of dark sky under the cloud limit'),
  darkHours: z.number(),
  longestStart: z.string(),
  longestEnd: z.string(),
  maxCloudCover: z.number().int(),
  seeing: z.number().nullable().describe('Mean 7Timer seeing over the clear hours, 1 best to 5'),
  moonIllumination: z.number().int(),
  moonDownHours: z.number(),
  moonRise: z.string().nullable(),
  moonSet: z.string().nullable(),
  dew: AlertDewForecastSchema.nullable().optional(),
  plan: AlertTonightPlanSchema.nullable().optional(),
});

export const AlertClearNightCheckSchema = z.object({
  night: z.string(),
  checkedAt: z.string(),
  result: AlertClearNightDataSchema.nullable(),
  sent: z.boolean(),
  reason: z.enum(['sent', 'not_clear_enough', 'no_forecast', 'no_dark_window', 'no_site', 'preview']),
});

export const AlertNextClearNightCheckSchema = z.object({
  at: z.string().describe('When the check runs (or ran, for a preview), as an instant'),
  when: z.enum(['now', 'today', 'tomorrow']),
});

export const AlertOverviewSchema = z.object({
  channels: z.array(AlertChannelSchema),
  devices: z.array(AlertDeviceSchema),
  config: AlertConfigSchema,
  events: z.array(z.enum(ALERT_EVENTS)),
  lastClearNightCheck: AlertClearNightCheckSchema.nullable(),
  nextClearNightCheck: AlertNextClearNightCheckSchema.extend({ timeZone: z.string() }),
});

export const AlertPushInfoSchema = z.object({
  relayUrl: z.string(),
  defaultEvents: z.array(z.enum(ALERT_EVENTS)),
  events: z.array(z.enum(ALERT_EVENTS)),
});

export const AlertPhoneFailureSchema = z.object({
  name: z.string(),
  error: z.string(),
});

export const AlertPhonesResultSchema = z.object({
  sent: z.number().int(),
  failed: z.array(AlertPhoneFailureSchema),
  phones: z.number().int(),
  check: AlertClearNightCheckSchema,
});

export const AlertDewPhonesResultSchema = AlertPhonesResultSchema.extend({
  sample: z.boolean().describe('True when the real forecast had no dew risk, so example times were sent'),
});

export const AlertDeletedSchema = z.object({ deleted: z.literal(true) });

// ─── The response views the route presents ─────────────────────────────────

/** A channel as a browser sees it: no URL and no secret. */
export type AlertChannelView = Omit<AlertChannel, 'url' | 'secret'> & {
  urlPreview: string;
  hasSecret: boolean;
};

/** A phone as a browser sees it: never its Apple token or relay credential. */
export type AlertDeviceView = Omit<AlertDevice, 'token' | 'credential'>;

// ─── Compile-time coverage checks ──────────────────────────────────────────

type Missing<Type, Schema extends z.ZodType> = Exclude<keyof Type, keyof z.infer<Schema>>;
const channelFieldsDocumented: [Missing<AlertChannelView, typeof AlertChannelSchema>] extends [never] ? true : never = true;
const deviceFieldsDocumented: [Missing<AlertDeviceView, typeof AlertDeviceSchema>] extends [never] ? true : never = true;
const configFieldsDocumented: [Missing<AlertConfig, typeof AlertConfigSchema>] extends [never] ? true : never = true;
const detailsFieldsDocumented: [Missing<AlertDetails, typeof AlertDetailsSchema>] extends [never] ? true : never = true;
const dewFieldsDocumented: [Missing<DewForecast, typeof AlertDewForecastSchema>] extends [never] ? true : never = true;
const planFieldsDocumented: [Missing<TonightPlan, typeof AlertTonightPlanSchema>] extends [never] ? true : never = true;
const clearNightFieldsDocumented: [Missing<ClearNightAlertData, typeof AlertClearNightDataSchema>] extends [never] ? true : never = true;
const checkFieldsDocumented: [Missing<ClearNightCheck, typeof AlertClearNightCheckSchema>] extends [never] ? true : never = true;
const nextCheckFieldsDocumented: [Missing<NextClearNightCheck, typeof AlertNextClearNightCheckSchema>] extends [never] ? true : never = true;
const deliveryFieldsDocumented: [Missing<DeliveryResult, typeof AlertDeliveryResultSchema>] extends [never] ? true : never = true;
void [
  channelFieldsDocumented, deviceFieldsDocumented, configFieldsDocumented, detailsFieldsDocumented, dewFieldsDocumented,
  planFieldsDocumented, clearNightFieldsDocumented, checkFieldsDocumented, nextCheckFieldsDocumented, deliveryFieldsDocumented,
];
