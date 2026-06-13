/**
 * TV / device pairing endpoints.
 *
 * Public (called by TV before it has a token):
 *   POST /pair/start       → { userCode, userCodeFormatted, deviceCode, expiresAt, pollIntervalSec }
 *   GET  /pair/poll        → { status: 'pending' | 'expired' | 'rejected' | 'approved' (+ token, user) }
 *
 * Authenticated (called by user from /link page):
 *   GET  /pair/lookup      → { tvName, expiresAt } so the UI can confirm before approve
 *   POST /pair/approve     → links the code to the current user
 */
import { Router, Request, Response } from 'express';
import {
  startPairing,
  pollPairing,
  approvePairing,
  lookupPairing,
} from '../lib/devicePairing.js';

const router = Router();

router.post('/start', (req: Request, res: Response) => {
  const tvName = typeof req.body?.tvName === 'string' ? req.body.tvName : 'TV';
  const result = startPairing(tvName);
  // Don't echo back deviceCode in any user-visible field — the userCode is
  // what the human sees; deviceCode is only ever sent to the polling client.
  res.apiSuccess({
    userCode: result.userCode,
    userCodeFormatted: result.userCodeFormatted,
    deviceCode: result.deviceCode,
    expiresAt: result.expiresAt,
    pollIntervalSec: result.pollIntervalSec,
  });
});

router.get('/poll', (req: Request, res: Response) => {
  const deviceCode = typeof req.query.deviceCode === 'string' ? req.query.deviceCode : '';
  if (!deviceCode) {
    res.apiError(400, 'MISSING_DEVICE_CODE', 'deviceCode query parameter is required');
    return;
  }
  const result = pollPairing(deviceCode);
  res.apiSuccess(result);
});

router.get('/lookup', (req: Request, res: Response) => {
  if (!req.userId) {
    res.apiError(401, 'AUTH_REQUIRED', 'You must be signed in to link a device.');
    return;
  }
  const userCode = typeof req.query.userCode === 'string' ? req.query.userCode : '';
  const found = lookupPairing(userCode);
  if (!found) {
    res.apiError(404, 'CODE_INVALID', 'That code is invalid or has expired.');
    return;
  }
  res.apiSuccess(found);
});

router.post('/approve', (req: Request, res: Response) => {
  if (!req.userId) {
    res.apiError(401, 'AUTH_REQUIRED', 'You must be signed in to link a device.');
    return;
  }
  const userCode = typeof req.body?.userCode === 'string' ? req.body.userCode : '';
  const result = approvePairing(userCode, req.userId);
  if (!result.ok) {
    const codeMap: Record<string, [number, string, string]> = {
      invalid:      [400, 'CODE_INVALID', 'That code is invalid.'],
      not_found:    [404, 'CODE_NOT_FOUND', 'That code is invalid or has expired.'],
      expired:      [410, 'CODE_EXPIRED', 'That code has expired. Please get a new one from your TV.'],
      already_used: [409, 'CODE_USED', 'That code has already been used.'],
      race:         [409, 'CODE_USED', 'That code has already been used.'],
    };
    const [status, code, msg] = codeMap[result.reason ?? 'invalid'] ?? codeMap.invalid;
    res.apiError(status, code, msg);
    return;
  }
  res.apiSuccess({ tvName: result.tvName });
});

export const pairRouter = router;
