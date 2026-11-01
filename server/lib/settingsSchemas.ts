/**
 * Shapes for the settings routes that are not the big Settings object itself:
 * personal API keys, the destructive database reset, nightly maintenance and
 * the debug-log capture. They live here so server/routes/openapi.ts can
 * generate the published spec from the schemas the routes validate with.
 */
import { z } from 'zod';
import type { UserApiKeySummary, UserApiKeyWithOwner } from './auth.js';
import type { enableDebugLogging, getDebugLogStatus } from './debugLogger.js';

export const SettingsApiKeyCreateBodySchema = z.object({
  name: z.string().max(50).optional(),
});

export const SettingsResetDatabaseBodySchema = z.object({
  confirmation: z.literal('delete'),
});

export const SettingsApiKeySummarySchema = z.object({
  id: z.string(),
  userId: z.string(),
  keyPrefix: z.string().describe('First characters of the key, safe to display'),
  name: z.string(),
  createdAt: z.number().int().describe('Unix ms'),
  lastUsedAt: z.number().int().nullable().describe('Unix ms'),
});

export const SettingsApiKeyOwnerSchema = SettingsApiKeySummarySchema.extend({
  ownerUsername: z.string().nullable().describe('Null when the owning account no longer exists'),
  ownerDisplayName: z.string().nullable(),
});

export const SettingsApiKeyCreatedSchema = z.object({
  id: z.string(),
  apiKey: z.string().describe('The full key, shown once and stored only as a hash'),
  keyPrefix: z.string(),
  name: z.string(),
});

export const SettingsApiKeyRevokedSchema = z.object({
  revoked: z.boolean(),
  id: z.string(),
});

export const SettingsResetResultSchema = z.object({ reset: z.boolean() });

export const SettingsNightlyStartedSchema = z.object({ started: z.boolean() });

export const SettingsDebugLogStateSchema = z.object({
  enabled: z.boolean(),
  enabledAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  logPath: z.string().nullable(),
});

export const SettingsDebugLogStatusSchema = SettingsDebugLogStateSchema.extend({
  minutesRemaining: z.number().int(),
  hasLog: z.boolean(),
});

// ─── Compile-time coverage checks ──────────────────────────────────────────

type Missing<Type, Schema extends z.ZodType> = Exclude<keyof Type, keyof z.infer<Schema>>;
const keySummaryFieldsDocumented: [Missing<UserApiKeySummary, typeof SettingsApiKeySummarySchema>] extends [never] ? true : never = true;
const keyOwnerFieldsDocumented: [Missing<UserApiKeyWithOwner, typeof SettingsApiKeyOwnerSchema>] extends [never] ? true : never = true;
const debugLogStateFieldsDocumented: [Missing<ReturnType<typeof enableDebugLogging>, typeof SettingsDebugLogStateSchema>] extends [never] ? true : never = true;
const debugLogStatusFieldsDocumented: [Missing<ReturnType<typeof getDebugLogStatus>, typeof SettingsDebugLogStatusSchema>] extends [never] ? true : never = true;
void [keySummaryFieldsDocumented, keyOwnerFieldsDocumented, debugLogStateFieldsDocumented, debugLogStatusFieldsDocumented];
