/**
 * Signing Nebulis in to Google Drive.
 *
 * **Why the device-code flow.** Nebulis is usually a server on a home network or in
 * Docker, reached at an address Google has never heard of. The usual web OAuth flow
 * needs a redirect URI registered in advance, which a self-hosted app cannot know.
 * The device flow ("TVs and Limited Input devices" in Google Cloud) needs none: the
 * server asks Google for a short code, the user types it at google.com/device on any
 * device, and the server polls until Google answers. It is the flow Google documents
 * for exactly this situation, and `drive.file` is one of the scopes it allows.
 *
 * **Why `drive.file`.** It grants access to files this app created and nothing else.
 * Nebulis never needs to read the rest of someone's Drive, so it does not ask to.
 *
 * **What is stored.** The client id in clear, the client secret and the refresh token
 * sealed with secretBox (see `archiveConfig.ts`). The short-lived access token lives
 * in memory only.
 *
 * Each install brings its own OAuth client. A shared client baked into the image
 * would put every Nebulis user under one Google quota and one consent screen that
 * the project would have to get verified, and its "secret" would be public anyway.
 */

import { clearGdriveConnection, getGdriveBackupConfig, getGdriveBackupSecrets, setGdriveConnection } from './gdriveBackupConfig.js';
import { isRecord } from '../../typeGuards.js';
import { DriveClient } from './driveClient.js';

export const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

let fetchImpl: typeof fetch = (...args) => fetch(...args);

/** Test seam: route every Google call through a fake. */
export function setGdriveFetchForTests(f: typeof fetch | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
  accessToken = null;
}

/** Test seam: how long the poller waits between polls, in place of Google's interval. */
let pollDelayOverrideMs: number | null = null;
export function setGdrivePollDelayForTests(ms: number | null): void {
  pollDelayOverrideMs = ms;
}

// ─── Access tokens ──────────────────────────────────────────────────────────

let accessToken: { token: string; expiresAt: number; refreshToken: string } | null = null;

/** Thrown when Google refuses the stored sign-in (revoked, expired, wrong client). */
export class GdriveAuthError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'GdriveAuthError';
  }
}

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  let body: unknown = {};
  try {
    body = await res.json();
  } catch {
    // An empty or non-JSON body; the status says enough.
  }
  return { status: res.status, body: isRecord(body) ? body : {} };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A valid access token, refreshed from the stored refresh token when the cached one
 *  is missing or about to expire. */
export async function getGdriveAccessToken(): Promise<string> {
  const secrets = getGdriveBackupSecrets();
  if (secrets.refreshToken === '') throw new GdriveAuthError('Google Drive is not signed in.', 'not-connected');
  if (accessToken && accessToken.refreshToken === secrets.refreshToken && accessToken.expiresAt - 60_000 > Date.now()) {
    return accessToken.token;
  }

  const { status, body } = await postForm(TOKEN_URL, {
    client_id: secrets.clientId,
    client_secret: secrets.clientSecret,
    refresh_token: secrets.refreshToken,
    grant_type: 'refresh_token',
  });
  const token = str(body.access_token);
  if (status !== 200 || token === '') {
    const error = str(body.error);
    // `invalid_grant` is Google saying the sign-in is gone for good (revoked, password
    // changed, or a testing-mode consent that expired after 7 days). Keeping the token
    // would only make every later call fail the same way.
    if (error === 'invalid_grant') {
      clearGdriveConnection();
      throw new GdriveAuthError('Google Drive access was revoked or has expired. Sign in again in Settings.', 'revoked');
    }
    throw new GdriveAuthError(str(body.error_description) || error || `Google answered ${status}`, error || 'refresh-failed');
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  accessToken = { token, expiresAt: Date.now() + expiresIn * 1000, refreshToken: secrets.refreshToken };
  return token;
}

/** A Drive client for the stored sign-in, or null when there is none. */
export function getGdriveClient(): DriveClient | null {
  if (getGdriveBackupSecrets().refreshToken === '') return null;
  return new DriveClient({
    getAccessToken: getGdriveAccessToken,
    invalidateAccessToken: () => {
      accessToken = null;
    },
    fetch: fetchImpl,
  });
}

// ─── Device-code sign-in ────────────────────────────────────────────────────

export type GdriveSignInState = 'idle' | 'pending' | 'connected' | 'denied' | 'expired' | 'error';

export interface GdriveSignInStatus {
  state: GdriveSignInState;
  /** What the user types at `verificationUrl`. Only while pending. */
  userCode?: string;
  verificationUrl?: string;
  /** Unix ms after which the code is no longer accepted. */
  expiresAt?: number;
  account?: string;
  error?: string;
}

let signIn: GdriveSignInStatus = { state: 'idle' };
/** Bumped by every start and cancel, so a poller from an earlier attempt stops
 *  instead of finishing a sign-in nobody is waiting for. */
let generation = 0;

export function getGdriveSignInStatus(): GdriveSignInStatus {
  // A finished sign-in is reported from what is stored, so a restart (which forgets
  // the in-memory state) still shows "connected", and a sign-out shows "idle".
  if (signIn.state !== 'pending') {
    const { connected, account } = getGdriveBackupConfig();
    if (connected) return { state: 'connected', ...(account ? { account } : {}) };
    if (signIn.state === 'connected') return { state: 'idle' };
  }
  return { ...signIn };
}

export class GdriveSignInError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'GdriveSignInError';
  }
}

/**
 * Ask Google for a device code and start polling for the user's answer.
 *
 * Resolves as soon as the code is known, so the route can show it; the poll carries
 * on in the background and lands in `getGdriveSignInStatus`.
 */
export async function startGdriveSignIn(): Promise<GdriveSignInStatus> {
  const secrets = getGdriveBackupSecrets();
  if (secrets.clientId === '') throw new GdriveSignInError('Enter your Google OAuth client id first.', 'no-client');
  if (secrets.clientSecret === '') throw new GdriveSignInError('Enter your Google OAuth client secret first.', 'no-client');

  const myGeneration = ++generation;
  const { status, body } = await postForm(DEVICE_CODE_URL, { client_id: secrets.clientId, scope: GDRIVE_SCOPE });
  const deviceCode = str(body.device_code);
  const userCode = str(body.user_code);
  const verificationUrl = str(body.verification_url) || str(body.verification_uri);
  if (status !== 200 || deviceCode === '' || userCode === '') {
    const reason = str(body.error_description) || str(body.error) || `Google answered ${status}`;
    // The usual mistake: a "Web application" or "Desktop" client, which the device
    // flow does not accept.
    const hint = str(body.error) === 'invalid_client' || str(body.error) === 'unauthorized_client'
      ? ' Check that the OAuth client is of type "TVs and Limited Input devices".'
      : '';
    throw new GdriveSignInError(`Google refused to start the sign-in: ${reason}.${hint}`, 'device-code-failed');
  }

  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 1800;
  const interval = typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5;
  signIn = {
    state: 'pending',
    userCode,
    verificationUrl: verificationUrl || 'https://www.google.com/device',
    expiresAt: Date.now() + expiresIn * 1000,
  };

  void pollForToken(myGeneration, deviceCode, interval, secrets.clientId, secrets.clientSecret);
  return { ...signIn };
}

/** Stop waiting for the user. Nothing is stored. */
export function cancelGdriveSignIn(): void {
  generation++;
  if (signIn.state === 'pending') signIn = { state: 'idle' };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function pollForToken(myGeneration: number, deviceCode: string, intervalSec: number, clientId: string, clientSecret: string): Promise<void> {
  let interval = intervalSec;
  const expiresAt = signIn.expiresAt ?? Date.now() + 1800_000;
  while (myGeneration === generation) {
    await sleep(pollDelayOverrideMs ?? interval * 1000);
    if (myGeneration !== generation) return;
    if (Date.now() > expiresAt) {
      signIn = { state: 'expired', error: 'The code expired before it was entered. Start again.' };
      return;
    }

    let result: { status: number; body: Record<string, unknown> };
    try {
      result = await postForm(TOKEN_URL, {
        client_id: clientId,
        client_secret: clientSecret,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT,
      });
    } catch {
      continue; // A network blip: keep polling until the code expires.
    }
    if (myGeneration !== generation) return;

    const { status, body } = result;
    const error = str(body.error);
    if (status === 200 && str(body.refresh_token) !== '') {
      await finishSignIn(str(body.refresh_token), str(body.access_token), typeof body.expires_in === 'number' ? body.expires_in : 3600);
      return;
    }
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (error === 'access_denied') {
      signIn = { state: 'denied', error: 'Access was declined on the Google consent screen.' };
      return;
    }
    if (error === 'expired_token') {
      signIn = { state: 'expired', error: 'The code expired before it was entered. Start again.' };
      return;
    }
    signIn = { state: 'error', error: str(body.error_description) || error || `Google answered ${status}` };
    return;
  }
}

async function finishSignIn(refreshToken: string, token: string, expiresIn: number): Promise<void> {
  // Stored before asking who the account is, so a failure of that cosmetic call
  // cannot lose a sign-in the user just completed.
  setGdriveConnection(refreshToken, '');
  if (token !== '') accessToken = { token, expiresAt: Date.now() + expiresIn * 1000, refreshToken };
  let account = '';
  try {
    account = (await getGdriveClient()?.about())?.email ?? '';
  } catch {
    // Display only.
  }
  setGdriveConnection(refreshToken, account);
  signIn = { state: 'connected', ...(account ? { account } : {}) };
}

/** Sign out: revoke the token with Google (best effort) and forget it. */
export async function disconnectGdrive(): Promise<void> {
  cancelGdriveSignIn();
  const { refreshToken } = getGdriveBackupSecrets();
  if (refreshToken !== '') {
    try {
      await postForm(REVOKE_URL, { token: refreshToken });
    } catch {
      // Revoking is a courtesy; forgetting the token locally is what matters.
    }
  }
  clearGdriveConnection();
  accessToken = null;
  signIn = { state: 'idle' };
}
