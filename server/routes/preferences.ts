import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import {
  getWatermarkPresets,
  setWatermarkPresets,
  getLastSeenVersion,
  setLastSeenVersion,
  getSupportAskSeenAt,
  setSupportAskSeen,
  getUiSettings,
  patchUiSettings,
  UiSettingsLimitError,
  LastSeenVersionBodySchema,
  UiSettingsPatchSchema,
  WatermarkPresetsBodySchema,
} from '../lib/userPreferences.js';

export const preferencesRouter = Router();

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

/** GET /preferences/support-ask — when this user dismissed the "Enjoying Nebulis?" ask, or null if they have not. */
preferencesRouter.get('/support-ask', (req, res) => {
  res.apiSuccess({ seenAt: getSupportAskSeenAt(resolveUserId(req)) });
});

/** PUT /preferences/support-ask — record that the ask was seen (closed, or the coffee link opened). Takes no body.
 *  Idempotent: the first dismissal keeps its date. */
preferencesRouter.put('/support-ask', (req, res) => {
  res.apiSuccess({ seenAt: setSupportAskSeen(resolveUserId(req)) });
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

/** GET /preferences/ui — the web client's saved UI settings, a flat key → string map ({} when none). */
preferencesRouter.get('/ui', (req, res) => {
  res.apiSuccess(getUiSettings(resolveUserId(req)));
});

/** PATCH /preferences/ui — merge settings into the saved map: a string sets a key, null removes it. Returns the
 *  merged map. Open to viewers: these are the caller's own UI choices, not library data. */
preferencesRouter.patch('/ui', (req, res) => {
  const parsed = UiSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Expected an object of string or null values');
    return;
  }
  try {
    res.apiSuccess(patchUiSettings(resolveUserId(req), parsed.data));
  } catch (err) {
    if (err instanceof UiSettingsLimitError) {
      res.apiError(422, 'VALIDATION_ERROR', err.message);
      return;
    }
    throw err;
  }
});
