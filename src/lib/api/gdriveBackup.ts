import { fetchJSON } from './client';
import type { ArchiveRunProgress, ArchiveScheduleMode } from './storage';

/**
 * The Google Drive backup: a destination of its own, next to the disk archive, with
 * its own switch, schedule and runs. See server/routes/storageGdrive.ts.
 */

export interface GdriveBackupConfig {
  enabled: boolean;
  clientId: string;
  hasClientSecret: boolean;
  connected: boolean;
  account: string;
  folderId: string;
  folderPath: string;
  archiveId: string;
  includeSubframes: boolean;
  copyMinAgeEnabled: boolean;
  copyMinAgeDays: number;
  scheduleEnabled: boolean;
  scheduleMode: ArchiveScheduleMode;
  scheduleHour: number;
  scheduleMinute: number;
  scheduleIntervalHours: number;
  scheduleCron: string;
  /** ISO start of the last complete run. A cancelled run leaves it, so the schedule stays due. */
  lastRunAt: string;
  /** The last attempt's one-line result, complete or not. */
  lastResult: string;
  /** ISO start of the attempt behind `lastResult`. */
  lastAttemptAt: string;
}

/** What a settings save may carry. The switch has its own routes. */
export type GdriveBackupPatch = Partial<
  Pick<
    GdriveBackupConfig,
    | 'clientId'
    | 'folderId'
    | 'folderPath'
    | 'includeSubframes'
    | 'copyMinAgeEnabled'
    | 'copyMinAgeDays'
    | 'scheduleEnabled'
    | 'scheduleMode'
    | 'scheduleHour'
    | 'scheduleMinute'
    | 'scheduleIntervalHours'
    | 'scheduleCron'
  >
> & { clientSecret?: string; clearClientSecret?: boolean };

export interface GdriveDestination {
  /** `absent`: the folder has no marker yet (turning the backup on adopts it).
   *  `offline`: not signed in, no folder, or the folder cannot be found. */
  state: 'offline' | 'absent' | 'match' | 'foreign' | 'invalid' | 'unreadable';
  path: string;
  foundArchiveId: string | null;
}

export interface GdriveBackupLastRun {
  trigger: 'scheduled' | 'manual';
  startedAt: string;
  finishedAt: string;
  result: {
    ran: boolean;
    reason?: string;
    copied: number;
    skipped: number;
    cancelled: boolean;
    failures: Array<{ archiveRelPath: string; error: string }>;
    warnings: string[];
    summary: string;
  };
}

export interface GdriveBackupStatus {
  config: GdriveBackupConfig;
  destination: GdriveDestination;
  progress?: ArchiveRunProgress;
  running?: boolean;
  lastRun?: GdriveBackupLastRun | null;
  schedule?: GdriveBackupSchedule;
}

export interface GdriveBackupSchedule {
  /** IANA zone the schedule runs in. */
  timeZone: string;
  /** `site`: the observing site's zone. `server`: the site has none, so the server's (often UTC). */
  timeZoneSource: 'site' | 'server';
  /** ISO; null when the schedule is off. */
  nextRunAt: string | null;
}

export interface GdriveSignInStatus {
  state: 'idle' | 'pending' | 'connected' | 'denied' | 'expired' | 'error';
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: number;
  account?: string;
  error?: string;
}

export interface GdriveFolder {
  id: string;
  name: string;
}

const BASE_PATH = '/storage/gdrive-backup';

export const getGdriveBackup = () => fetchJSON<GdriveBackupStatus>(BASE_PATH);

export const saveGdriveBackup = (patch: GdriveBackupPatch) =>
  fetchJSON<GdriveBackupStatus>(BASE_PATH, { method: 'PUT', body: JSON.stringify(patch) });

/** Adopt the folder and switch the backup on. `confirmArchiveId` takes over a folder
 *  another install was using. */
export const enableGdriveBackup = (confirmArchiveId?: string) =>
  fetchJSON<GdriveBackupStatus>(`${BASE_PATH}/enable`, {
    method: 'POST',
    body: JSON.stringify(confirmArchiveId ? { confirmArchiveId } : {}),
  });

export const disableGdriveBackup = () => fetchJSON<GdriveBackupStatus>(`${BASE_PATH}/disable`, { method: 'POST' });

export const getGdriveSignInStatus = () => fetchJSON<GdriveSignInStatus>(`${BASE_PATH}/sign-in`);

/** Store the OAuth client (both fields optional) and start a sign-in. */
export const startGdriveSignIn = (client: { clientId?: string; clientSecret?: string }) =>
  fetchJSON<GdriveSignInStatus>(`${BASE_PATH}/connect`, { method: 'POST', body: JSON.stringify(client) });

export const cancelGdriveSignIn = () => fetchJSON<GdriveSignInStatus>(`${BASE_PATH}/sign-in/cancel`, { method: 'POST' });

/** Sign out and revoke the token. The files in Drive stay. */
export const disconnectGdrive = () => fetchJSON<GdriveSignInStatus>(`${BASE_PATH}/disconnect`, { method: 'POST' });

/** The backup folder after sign-in: the saved one, or a Nebulis folder at the top of
 *  My Drive, created when missing. */
export const prepareGdriveBackupFolder = () =>
  fetchJSON<{ folder: GdriveFolder; created: boolean }>(`${BASE_PATH}/folder`, { method: 'POST' });

export const runGdriveBackupNow = () => fetchJSON<{ started: true }>(`${BASE_PATH}/run`, { method: 'POST' });

export const cancelGdriveBackupRun = () => fetchJSON<{ cancelling: true }>(`${BASE_PATH}/run/cancel`, { method: 'POST' });
