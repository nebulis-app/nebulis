import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import {
  getWatermarkPresets,
  setWatermarkPresets,
  getLastSeenVersion,
  setLastSeenVersion,
  WatermarkPresetSchema,
} from '../lib/userPreferences.js';

export const preferencesRouter = Router();

const WatermarkPresetsBodySchema = z.array(WatermarkPresetSchema);

const LastSeenVersionBodySchema = z.object({
  version: z.string().min(1).max(64),
});

// Fall back to 'default' when auth is disabled (no-user / API-key mode)
function resolveUserId(req: { userId?: string }): string {
  return req.userId ?? 'default';
}

/** GET /preferences/watermarks — return saved presets for the current user */
preferencesRouter.get('/watermarks', (req, res) => {
  const userId = resolveUserId(req);
  res.apiSuccess(getWatermarkPresets(userId));
});

/** PUT /preferences/watermarks — overwrite the full presets array */
preferencesRouter.put('/watermarks', requireAdmin, (req, res) => {
  const parsed = WatermarkPresetsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Expected an array of watermark presets');
    return;
  }
  const userId = resolveUserId(req);
  const presets = parsed.data;
  setWatermarkPresets(userId, presets);
  res.apiSuccess(presets);
});

/** GET /preferences/last-seen-version — the app version this user last
 *  acknowledged in the What's New popup. Null when they've never seen it. */
preferencesRouter.get('/last-seen-version', (req, res) => {
  const userId = resolveUserId(req);
  res.apiSuccess({ lastSeenVersion: getLastSeenVersion(userId) });
});

/** PUT /preferences/last-seen-version — mark this version as seen. Called
 *  when the user clicks "Got it" on the What's New modal. "Remind me later"
 *  does not hit this endpoint so the modal will reappear on next login. */
preferencesRouter.put('/last-seen-version', (req, res) => {
  const parsed = LastSeenVersionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid version');
    return;
  }
  const userId = resolveUserId(req);
  setLastSeenVersion(userId, parsed.data.version);
  res.apiSuccess({ lastSeenVersion: parsed.data.version });
});
