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
import QRCode from 'qrcode';
import {
  startPairing,
  pollPairing,
  approvePairing,
  lookupPairing,
  startApprovedPairing,
  getApprovedPairingStatus,
} from '../lib/devicePairing.js';
import { getInstanceId } from '../lib/instanceId.js';
import { getLanIP, isLoopbackHost } from '../lib/lanAddress.js';

const router = Router();

/**
 * Resolve the URL a phone should use to reach this server. Starts from the URL
 * the browser is actually using (which by definition reached the server), and
 * only rewrites the host to the LAN IP when the browser is on the server box
 * itself (localhost) — a phone can't reach the admin's "localhost".
 */
function resolveConnectUrl(originRaw: unknown, hostHeader: unknown): string | null {
  const candidates = [originRaw, hostHeader].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  for (const candidate of candidates) {
    // host header has no scheme; assume http for the bare-host fallback.
    const withScheme = candidate.includes('://') ? candidate : `http://${candidate}`;
    let parsed: URL;
    try { parsed = new URL(withScheme); } catch { continue; }
    if (!isLoopbackHost(parsed.hostname)) {
      return `${parsed.protocol}//${parsed.host}`;
    }
    // Loopback: swap in the LAN IP, keep scheme + port.
    const lan = getLanIP();
    if (lan) {
      const port = parsed.port ? `:${parsed.port}` : '';
      return `${parsed.protocol}//${lan}${port}`;
    }
  }
  // No usable origin/host header — last resort.
  const lan = getLanIP();
  return lan ? `http://${lan}` : null;
}

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

/**
 * QR enrollment (authenticated). The signed-in web user generates a QR that a
 * phone scans to connect AND sign in to this server in one step. The QR encodes
 * the connect URL, the stable instanceId (so the phone can self-heal if the IP
 * later changes), and a short-lived, pre-approved deviceCode.
 */
router.post('/qr', async (req: Request, res: Response) => {
  if (!req.userId) {
    res.apiError(401, 'AUTH_REQUIRED', 'You must be signed in to connect a device.');
    return;
  }

  const url = resolveConnectUrl(req.body?.origin, req.headers.host);
  if (!url) {
    res.apiError(503, 'NO_LAN_ADDRESS',
      'Could not determine a network address for this server. Connect the server to your network and try again.');
    return;
  }

  const deviceName = typeof req.body?.deviceName === 'string' ? req.body.deviceName : 'Phone';
  const pairing = startApprovedPairing(req.userId, deviceName);

  // v: payload format version, so the scanner can reject formats it predates.
  const payload = JSON.stringify({
    service: 'nebulis',
    v: 1,
    url,
    instanceId: getInstanceId(),
    deviceCode: pairing.deviceCode,
  });

  let qrDataUrl: string;
  try {
    qrDataUrl = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 512,
    });
  } catch {
    res.apiError(500, 'QR_FAILED', 'Could not generate the QR code. Please try again.');
    return;
  }

  res.apiSuccess({
    qrDataUrl,
    url,
    deviceCode: pairing.deviceCode,
    expiresAt: pairing.expiresAt,
    pollIntervalSec: pairing.pollIntervalSec,
  });
});

// Web UI polls this to know when the scanning phone has finished connecting.
// Read-only: it never consumes the code, so it can't race the phone's token.
router.get('/qr/status', (req: Request, res: Response) => {
  if (!req.userId) {
    res.apiError(401, 'AUTH_REQUIRED', 'You must be signed in.');
    return;
  }
  const deviceCode = typeof req.query.deviceCode === 'string' ? req.query.deviceCode : '';
  if (!deviceCode) {
    res.apiError(400, 'MISSING_DEVICE_CODE', 'deviceCode query parameter is required');
    return;
  }
  res.apiSuccess(getApprovedPairingStatus(deviceCode, req.userId));
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
