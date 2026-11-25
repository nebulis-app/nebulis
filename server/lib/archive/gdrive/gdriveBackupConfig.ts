/**
 * The Google Drive backup's settings.
 *
 * Drive is not a third kind of archive disk. It is a second destination that runs
 * alongside the disk archive, because the two answer different needs: the disk
 * archive is the place captures go to free this computer (it prunes, removes local
 * subframes and restores), and the Drive backup is an off-site copy that only ever
 * adds. So it has its own switch, its own schedule and its own record, and a disk
 * archive and a Drive backup can both be on, and both run at once.
 *
 * What it shares with the disk archive is the selection rules (which files make up
 * the library and the gallery), not the settings: everything here lives in its own
 * `archiveGdrive*` columns (see archiveColumns.ts).
 *
 * The OAuth client secret and the refresh token are sealed in their own columns and
 * read only by `getGdriveBackupSecrets`, which the Drive auth module calls. No route
 * ever returns them, the same rule as the network share's password.
 */

import db from '../../db.js';
import { decrypt, encrypt } from '../../crypto/secretBox.js';
import { isRecord } from '../../typeGuards.js';
import { parseCron } from '../archiveCron.js';
import { ARCHIVE_SCHEDULE_MODES, ArchiveConfigError, DEFAULT_ARCHIVE_CONFIG, type ArchiveConfig, type ArchiveScheduleMode } from '../archiveConfig.js';

export interface GdriveBackupConfig {
  /** The master switch. Off means nothing is uploaded or adopted, whatever else is set. */
  enabled: boolean;
  /** The OAuth client the user created in Google Cloud ("TVs and Limited Input
   *  devices" type), which the device-code sign-in needs. */
  clientId: string;
  hasClientSecret: boolean;
  /** Whether a refresh token is stored, i.e. the account has been signed in. */
  connected: boolean;
  /** The signed-in account's address, for display only. */
  account: string;
  /** The backup folder's Drive id. Empty means none has been prepared yet. Not a
   *  secret: it is useless without the sign-in. */
  folderId: string;
  /** The folder's name when it was prepared, for display only. Drive identifies
   *  folders by id, so a folder the user moved or renamed is still found. */
  folderPath: string;
  /** The id in the folder's `.nebulisarchive` marker. Empty means not adopted. */
  archiveId: string;
  includeSubframes: boolean;
  /** Skip anything captured less than this many days ago, while the switch is on. */
  copyMinAgeEnabled: boolean;
  copyMinAgeDays: number;
  scheduleEnabled: boolean;
  scheduleMode: ArchiveScheduleMode;
  scheduleHour: number;
  scheduleMinute: number;
  scheduleIntervalHours: number;
  scheduleCron: string;
  /** When the last complete run started. A cancelled run leaves it alone, so the schedule still counts as due. */
  lastRunAt: string;
  /** The last attempt's one-line result, complete or not. */
  lastResult: string;
  /** When the attempt behind `lastResult` started. */
  lastAttemptAt: string;
}

/** Everything the Drive auth module needs. Never serialised to a client. */
export interface GdriveBackupSecrets {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId: string;
}

/** What a settings save may carry. `connected` and `account` are written only by the
 *  sign-in flow (`setGdriveConnection`), and `hasClientSecret` is derived; all three
 *  are skipped rather than refused, so a config read can be handed back unchanged. */
export type GdriveBackupPatch = Partial<Omit<GdriveBackupConfig, 'hasClientSecret' | 'connected' | 'account'>> & {
  /** Sealed on write. Empty leaves the stored secret alone. */
  clientSecret?: string;
  clearClientSecret?: boolean;
  hasClientSecret?: boolean;
  connected?: boolean;
  account?: string;
};

export const DEFAULT_GDRIVE_BACKUP_CONFIG: GdriveBackupConfig = {
  enabled: false,
  clientId: '',
  hasClientSecret: false,
  connected: false,
  account: '',
  folderId: '',
  folderPath: '',
  archiveId: '',
  includeSubframes: false,
  copyMinAgeEnabled: false,
  copyMinAgeDays: 0,
  scheduleEnabled: false,
  scheduleMode: 'daily',
  scheduleHour: 3,
  scheduleMinute: 0,
  scheduleIntervalHours: 24,
  scheduleCron: '',
  lastRunAt: '',
  lastResult: '',
  lastAttemptAt: '',
};

const CLIENT_SECRET_COLUMN = 'archiveGdriveClientSecretSealed';
const REFRESH_TOKEN_COLUMN = 'archiveGdriveRefreshTokenSealed';
const ACCOUNT_COLUMN = 'archiveGdriveAccount';

type Stored = Exclude<keyof GdriveBackupConfig, 'hasClientSecret' | 'connected' | 'account'>;

const COLUMN_FOR: Record<Stored, string> = {
  enabled: 'archiveGdriveEnabled',
  clientId: 'archiveGdriveClientId',
  folderId: 'archiveGdriveFolderId',
  folderPath: 'archiveGdriveFolderPath',
  archiveId: 'archiveGdriveArchiveId',
  includeSubframes: 'archiveGdriveIncludeSubframes',
  copyMinAgeEnabled: 'archiveGdriveCopyMinAgeEnabled',
  copyMinAgeDays: 'archiveGdriveCopyMinAgeDays',
  scheduleEnabled: 'archiveGdriveScheduleEnabled',
  scheduleMode: 'archiveGdriveScheduleMode',
  scheduleHour: 'archiveGdriveScheduleHour',
  scheduleMinute: 'archiveGdriveScheduleMinute',
  scheduleIntervalHours: 'archiveGdriveScheduleIntervalHours',
  scheduleCron: 'archiveGdriveScheduleCron',
  lastRunAt: 'archiveGdriveLastRunAt',
  lastResult: 'archiveGdriveLastResult',
  lastAttemptAt: 'archiveGdriveLastAttemptAt',
};

const ALL_COLUMNS = [...Object.values(COLUMN_FOR), CLIENT_SECRET_COLUMN, REFRESH_TOKEN_COLUMN, ACCOUNT_COLUMN];

/** Google's OAuth client ids all end this way; anything else is a paste of the wrong field. */
const CLIENT_ID_RE = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;

/** Drive file ids are URL-safe base64-ish tokens. Anything else did not come from Drive. */
export const GDRIVE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

function readRow(): Record<string, unknown> | undefined {
  const row: unknown = db.prepare(`SELECT ${ALL_COLUMNS.join(', ')} FROM appSettings WHERE id = 1`).get();
  return isRecord(row) ? row : undefined;
}

function str(row: Record<string, unknown> | undefined, column: string): string {
  const value = row?.[column];
  return typeof value === 'string' ? value : '';
}

function int(row: Record<string, unknown> | undefined, column: string, fallback: number, min: number, max: number): number {
  const value = row?.[column];
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function bool(row: Record<string, unknown> | undefined, column: string): boolean {
  return row?.[column] === 1;
}

function unseal(sealed: string, what: string): string {
  if (sealed === '') return '';
  try {
    return decrypt(sealed);
  } catch (err) {
    console.warn(`[gdriveBackup] Could not decrypt the ${what}, treating it as absent: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

export function getGdriveBackupConfig(): GdriveBackupConfig {
  const row = readRow();
  const d = DEFAULT_GDRIVE_BACKUP_CONFIG;
  const mode = str(row, COLUMN_FOR.scheduleMode);
  return {
    enabled: bool(row, COLUMN_FOR.enabled),
    clientId: str(row, COLUMN_FOR.clientId),
    hasClientSecret: str(row, CLIENT_SECRET_COLUMN) !== '',
    connected: str(row, REFRESH_TOKEN_COLUMN) !== '',
    account: str(row, ACCOUNT_COLUMN),
    folderId: str(row, COLUMN_FOR.folderId),
    folderPath: str(row, COLUMN_FOR.folderPath),
    archiveId: str(row, COLUMN_FOR.archiveId),
    includeSubframes: bool(row, COLUMN_FOR.includeSubframes),
    copyMinAgeEnabled: bool(row, COLUMN_FOR.copyMinAgeEnabled),
    copyMinAgeDays: int(row, COLUMN_FOR.copyMinAgeDays, 0, 0, Number.MAX_SAFE_INTEGER),
    scheduleEnabled: bool(row, COLUMN_FOR.scheduleEnabled),
    scheduleMode: (ARCHIVE_SCHEDULE_MODES as readonly string[]).includes(mode) ? (mode as ArchiveScheduleMode) : d.scheduleMode,
    scheduleHour: int(row, COLUMN_FOR.scheduleHour, d.scheduleHour, 0, 23),
    scheduleMinute: int(row, COLUMN_FOR.scheduleMinute, d.scheduleMinute, 0, 59),
    scheduleIntervalHours: int(row, COLUMN_FOR.scheduleIntervalHours, d.scheduleIntervalHours, 1, 168),
    scheduleCron: str(row, COLUMN_FOR.scheduleCron),
    lastRunAt: str(row, COLUMN_FOR.lastRunAt),
    lastResult: str(row, COLUMN_FOR.lastResult),
    lastAttemptAt: str(row, COLUMN_FOR.lastAttemptAt),
  };
}

/** The connection with its secrets, for the Drive auth module and nothing else. */
export function getGdriveBackupSecrets(): GdriveBackupSecrets {
  const row = readRow();
  return {
    clientId: str(row, COLUMN_FOR.clientId),
    clientSecret: unseal(str(row, CLIENT_SECRET_COLUMN), 'Google Drive client secret'),
    refreshToken: unseal(str(row, REFRESH_TOKEN_COLUMN), 'Google Drive sign-in'),
    folderId: str(row, COLUMN_FOR.folderId),
  };
}

/** Store the outcome of a Drive sign-in. Only the auth module calls this. */
export function setGdriveConnection(refreshToken: string, account: string): void {
  db.prepare(`UPDATE appSettings SET ${REFRESH_TOKEN_COLUMN} = ?, ${ACCOUNT_COLUMN} = ? WHERE id = 1`).run(
    refreshToken === '' ? '' : encrypt(refreshToken),
    account,
  );
}

/** Forget the sign-in, not the client or the folder: signing in again with the same
 *  account finds the same folder, and another account simply cannot see it. */
export function clearGdriveConnection(): void {
  setGdriveConnection('', '');
}

/**
 * The selection settings in the shape the disk archive's file selection reads.
 *
 * The Drive backup copies the same library and gallery the disk archive would, so it
 * goes through the same `selectArchiveFiles`, handed only the fields that function
 * consults. The whole library is always in scope.
 */
export function gdriveSelectionConfig(config: GdriveBackupConfig): ArchiveConfig {
  return {
    ...DEFAULT_ARCHIVE_CONFIG,
    scope: 'all',
    selectedObjects: [],
    includeSubframes: config.includeSubframes,
    copyMinAgeEnabled: config.copyMinAgeEnabled,
    copyMinAgeDays: config.copyMinAgeDays,
  };
}

function assertString(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new ArchiveConfigError(field, `${field} must be a string`);
}

function assertBoolean(field: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new ArchiveConfigError(field, `${field} must be true or false`);
}

function assertInteger(field: string, value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ArchiveConfigError(field, `${field} must be a whole number from ${min} to ${max}`);
  }
}

function isStoredKey(key: string): key is Stored {
  return Object.prototype.hasOwnProperty.call(COLUMN_FOR, key);
}

/**
 * Apply a settings patch, validated as a whole before anything is written.
 *
 * Changing the client id signs out and forgets the folder and the adoption: a token
 * issued to one client cannot be used with another, and a different Google Cloud
 * project may well mean a different account. Changing the folder forgets the
 * adoption. Either way the backup is switched off until it is adopted again.
 *
 * Keys are applied in order, so a later key wins over what an earlier one implied
 * (`{ folderId, enabled: true }` would still end enabled; the routes never send that).
 */
export function setGdriveBackupConfig(patch: GdriveBackupPatch | Readonly<Record<string, unknown>>): void {
  const stored = getGdriveBackupConfig();
  const assignments = new Map<string, string | number>();
  const assign = (column: string, value: string | number): void => {
    assignments.set(column, value);
  };
  let nextCopyMinAgeEnabled = stored.copyMinAgeEnabled;
  let nextCopyMinAgeDays = stored.copyMinAgeDays;

  for (const key of Object.keys(patch)) {
    const value: unknown = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    // Derived or written only by the sign-in: skipped, so a read can be handed back.
    if (key === 'hasClientSecret' || key === 'connected' || key === 'account') continue;
    if (key === 'clientSecret') {
      assertString('clientSecret', value);
      if (value.trim() !== '') assign(CLIENT_SECRET_COLUMN, encrypt(value.trim()));
      continue;
    }
    if (key === 'clearClientSecret') {
      assertBoolean('clearClientSecret', value);
      if (value) assign(CLIENT_SECRET_COLUMN, '');
      continue;
    }
    if (!isStoredKey(key)) throw new ArchiveConfigError(key, `unknown Google Drive backup setting "${key}"`);

    switch (key) {
      case 'clientId': {
        assertString(key, value);
        const id = value.trim();
        if (id !== '' && !CLIENT_ID_RE.test(id)) {
          throw new ArchiveConfigError('clientId', 'that is not a Google OAuth client id (it ends in .apps.googleusercontent.com)');
        }
        assign(COLUMN_FOR.clientId, id);
        if (id !== stored.clientId) {
          assign(REFRESH_TOKEN_COLUMN, '');
          assign(ACCOUNT_COLUMN, '');
          assign(COLUMN_FOR.folderId, '');
          assign(COLUMN_FOR.folderPath, '');
          assign(COLUMN_FOR.archiveId, '');
          assign(COLUMN_FOR.enabled, 0);
        }
        break;
      }
      case 'folderId':
        assertString(key, value);
        if (value !== '' && !GDRIVE_ID_RE.test(value)) throw new ArchiveConfigError('folderId', 'that is not a Google Drive folder id');
        // My Drive itself would mix the backup into everything else in the Drive.
        if (value === 'root') throw new ArchiveConfigError('folderId', 'use a folder inside My Drive, not My Drive itself');
        assign(COLUMN_FOR.folderId, value);
        // Another folder is another backup: it has to be adopted before anything is
        // written to it, so the backup is off until it is.
        if (value !== stored.folderId) {
          assign(COLUMN_FOR.archiveId, '');
          assign(COLUMN_FOR.enabled, 0);
        }
        break;
      case 'folderPath':
        assertString(key, value);
        if (value.length > 1000 || [...value].some(c => c.charCodeAt(0) < 0x20)) {
          throw new ArchiveConfigError('folderPath', 'the Google Drive folder name is not usable');
        }
        assign(COLUMN_FOR.folderPath, value);
        break;
      case 'archiveId':
      case 'lastRunAt':
      case 'lastResult':
      case 'lastAttemptAt':
        assertString(key, value);
        assign(COLUMN_FOR[key], value);
        break;
      case 'scheduleMode':
        if (!(ARCHIVE_SCHEDULE_MODES as readonly unknown[]).includes(value)) {
          throw new ArchiveConfigError('scheduleMode', 'scheduleMode must be "daily", "interval" or "custom"');
        }
        assign(COLUMN_FOR.scheduleMode, value as string);
        break;
      case 'scheduleCron': {
        assertString(key, value);
        const trimmed = value.trim();
        if (trimmed !== '') {
          const parsed = parseCron(trimmed);
          if (!parsed.ok) throw new ArchiveConfigError('scheduleCron', parsed.reason);
        }
        assign(COLUMN_FOR.scheduleCron, trimmed);
        break;
      }
      case 'scheduleHour':
        assertInteger(key, value, 0, 23);
        assign(COLUMN_FOR[key], value);
        break;
      case 'scheduleMinute':
        assertInteger(key, value, 0, 59);
        assign(COLUMN_FOR[key], value);
        break;
      case 'scheduleIntervalHours':
        assertInteger(key, value, 1, 168);
        assign(COLUMN_FOR[key], value);
        break;
      case 'copyMinAgeDays':
        assertInteger(key, value, 0, Number.MAX_SAFE_INTEGER);
        nextCopyMinAgeDays = value;
        assign(COLUMN_FOR[key], value);
        break;
      case 'enabled':
      case 'includeSubframes':
      case 'copyMinAgeEnabled':
      case 'scheduleEnabled':
        assertBoolean(key, value);
        if (key === 'copyMinAgeEnabled') nextCopyMinAgeEnabled = value;
        assign(COLUMN_FOR[key], value ? 1 : 0);
        break;
    }
  }

  // The same rule as the disk archive: an armed wait of zero days is a contradiction.
  if (nextCopyMinAgeEnabled && nextCopyMinAgeDays < 1) {
    throw new ArchiveConfigError('copyMinAgeDays', 'set a wait of at least one day, or turn the wait off');
  }

  if (assignments.size === 0) return;
  const columns = [...assignments.keys()];
  db.prepare(`UPDATE appSettings SET ${columns.map(c => `${c} = ?`).join(', ')} WHERE id = 1`).run(...assignments.values());
}
