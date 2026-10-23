/**
 * Reading and writing the archive configuration.
 *
 * Validation is deliberately asymmetric.
 *
 * **Strict on the way in.** `setArchiveConfig` throws `ArchiveConfigError` rather
 * than coercing, because coercion here is dangerous rather than forgiving:
 * `removeLocalAfter: 'false'` is truthy, and accepting it would delete subframes
 * the user asked to keep. Callers turn the throw into a 400.
 *
 * **Lenient on the way out.** `getArchiveConfig` never throws. The values live in
 * a SQLite column anyone with the file can edit, and a malformed one must degrade
 * to the safe default rather than take down the settings page or, worse, make the
 * scheduler misread a flag.
 *
 * Nothing here is destructive, but the defaults it reports decide what the
 * destructive paths are allowed to do, which is why the off-by-default assertions
 * are part of the suite rather than a comment.
 */

import path from 'path';

import db from '../db.js';
import { decrypt, encrypt } from '../crypto/secretBox.js';
import { sanitizePath, validatePathNoTraversal } from '../smb.shared.js';
import { parseCron } from './archiveCron.js';
import { isRecord } from '../typeGuards.js';

export type ArchiveScope = 'all' | 'selected';

/** Where the archive lives. `local` is a path on a filesystem the operating system
 *  has already mounted; `network` is an SMB/UNC share Nebulis connects to itself. */
export type ArchiveLocationType = 'local' | 'network';

/**
 * How the schedule decides when a run is due.
 *
 * `daily` fires at one time of day, `interval` every N hours, and `custom` follows a
 * cron expression. All three read the server's local time, which is what the archive
 * already used before the modes existed.
 */
export type ArchiveScheduleMode = 'daily' | 'interval' | 'custom';

export const ARCHIVE_SCHEDULE_MODES: readonly ArchiveScheduleMode[] = ['daily', 'interval', 'custom'];

/**
 * The non-secret description of a network destination.
 *
 * The password is deliberately absent. It is write-only through
 * `setArchiveConfig` and readable only through `getArchiveNetworkCredentials`,
 * which the connect step calls. Nothing that serialises a config can leak it by
 * accident, because there is no field to serialise.
 */
export interface ArchiveNetworkConfig {
  host: string;
  share: string;
  domain: string;
  username: string;
  /** Whether a password is stored, so the form can say so without holding it. */
  hasPassword: boolean;
  /** Folder inside the share. Empty means the share root. */
  subpath: string;
}

/** Everything the connect step needs, for the lifetime of one attempt. */
export interface ArchiveNetworkCredentials extends Omit<ArchiveNetworkConfig, 'hasPassword'> {
  password: string;
}

export interface ArchiveConfig {
  /** The master switch for the whole feature. Off means nothing is copied, adopted
   *  or pruned, whatever the other settings say. */
  enabled: boolean;
  /** Destination root, for a local destination. An empty path with
   *  `locationType: 'local'` is what "archiving is unconfigured" means. */
  path: string;
  locationType: ArchiveLocationType;
  network: ArchiveNetworkConfig;
  /** Marker id in the destination's `.nebulisarchive`. Empty means not adopted. */
  archiveId: string;
  scope: ArchiveScope;
  selectedObjects: string[];
  includeSubframes: boolean;
  /** Skip copying anything younger than this many days, measured from when it was
   *  captured. Read only while `copyMinAgeEnabled` is on. */
  copyMinAgeDays: number;
  /** Whether the age filter above is armed. With this off, everything selected is
   *  copied as soon as a run finds it, whatever `copyMinAgeDays` says, so a day
   *  count can be typed in before the switch is thrown, the same convention as
   *  `retentionEnabled` below. */
  copyMinAgeEnabled: boolean;
  scheduleEnabled: boolean;
  scheduleMode: ArchiveScheduleMode;
  /** Hour of day, 0-23, in the server's local time. Read by the 'daily' mode. */
  scheduleHour: number;
  /** Minutes past the hour, 0-59. Read by the 'daily' mode only: the interval mode
   *  is measured from the last run, so it has no minute of its own. */
  scheduleMinute: number;
  /** Hours between runs, read by the 'interval' mode. */
  scheduleIntervalHours: number;
  /** A five-field cron expression, read by the 'custom' mode. Empty means unset. */
  scheduleCron: string;
  /** Days after which the archive prunes itself. 0 means keep everything. */
  retentionDays: number;
  /** Whether pruning is armed. With this off, nothing is deleted even when a
   *  period is set, so a period can be typed in before the switch is thrown. */
  retentionEnabled: boolean;
  retentionSubframesOnly: boolean;
  /** Destructive: remove local subframes once the archived copy is verified. */
  removeLocalAfter: boolean;
  lastRunAt: string;
  lastResult: string;
}

/** A write-only view of the network fields, so a patch can set a password that no
 *  read path can hand back. */
export interface ArchiveNetworkPatch {
  host?: string;
  share?: string;
  domain?: string;
  username?: string;
  subpath?: string;
  /** Read-only, accepted so a config read from `getArchiveConfig()` can be handed
   *  straight back as a patch (the tests reset state that way). Ignored, because it
   *  is derived from the sealed column rather than stored. */
  hasPassword?: boolean;
  /** Omitted or empty keeps whatever is stored (Decision 4). There is no way to
   *  set an empty password on a share that had one, which is deliberate: that
   *  would silently downgrade a working connection to a guest one. */
  password?: string;
  /** Forget the stored password. Separate from `password: ''` so "keep" and
   *  "clear" cannot be confused. */
  clearPassword?: boolean;
}

export type ArchiveConfigPatch = Partial<Omit<ArchiveConfig, 'network'>> & {
  network?: ArchiveNetworkPatch;
};

/**
 * What an unconfigured install reports. Nothing archives, nothing is deleted.
 *
 * Exported so the UI and the tests agree with the database rather than each
 * restating the defaults: `getArchiveConfig()` on a fresh install is asserted to
 * equal this exactly.
 */
export const DEFAULT_ARCHIVE_CONFIG: ArchiveConfig = {
  enabled: false,
  path: '',
  locationType: 'local',
  network: { host: '', share: '', domain: '', username: '', hasPassword: false, subpath: '' },
  archiveId: '',
  scope: 'all',
  selectedObjects: [],
  includeSubframes: false,
  copyMinAgeDays: 0,
  copyMinAgeEnabled: false,
  scheduleEnabled: false,
  scheduleMode: 'daily',
  scheduleHour: 2,
  scheduleMinute: 0,
  scheduleIntervalHours: 24,
  scheduleCron: '',
  retentionDays: 0,
  retentionEnabled: false,
  retentionSubframesOnly: false,
  removeLocalAfter: false,
  lastRunAt: '',
  lastResult: '',
};

/** Thrown when a patch is not usable.
 *
 *  `field` is for callers that want to point at a control. The route returns
 *  `message` to the client, and every message here is written to name what is wrong
 *  (`scheduleCron` carries the cron validator's reason), so the field is not needed to
 *  make the error readable. */
export class ArchiveConfigError extends Error {
  readonly code = 'ARCHIVE_INVALID_CONFIG';
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveConfigError';
  }
}

/** Setting key to column name. The only place the two spellings meet, so a
 *  rename cannot silently miss one of them.
 *
 *  `network` is excluded because it is not a column: its fields have their own map
 *  below, and the password has its own column that no read path exposes. */
type ScalarSetting = Exclude<keyof ArchiveConfig, 'network'>;

const COLUMN_FOR: Record<ScalarSetting, string> = {
  enabled: 'archiveEnabled',
  path: 'archivePath',
  locationType: 'archiveLocationType',
  archiveId: 'archiveId',
  scope: 'archiveScope',
  selectedObjects: 'archiveSelectedObjects',
  includeSubframes: 'archiveIncludeSubframes',
  copyMinAgeDays: 'archiveCopyMinAgeDays',
  copyMinAgeEnabled: 'archiveCopyMinAgeEnabled',
  scheduleEnabled: 'archiveScheduleEnabled',
  scheduleMode: 'archiveScheduleMode',
  scheduleHour: 'archiveScheduleHour',
  scheduleMinute: 'archiveScheduleMinute',
  scheduleIntervalHours: 'archiveScheduleIntervalHours',
  scheduleCron: 'archiveScheduleCron',
  retentionDays: 'archiveRetentionDays',
  retentionEnabled: 'archiveRetentionEnabled',
  retentionSubframesOnly: 'archiveRetentionSubframesOnly',
  removeLocalAfter: 'archiveRemoveLocalAfter',
  lastRunAt: 'archiveLastRunAt',
  lastResult: 'archiveLastResult',
};

/** The network fields, minus `hasPassword`, which is derived from the sealed
 *  column rather than stored. */
const NETWORK_COLUMN_FOR: Record<Exclude<keyof ArchiveNetworkConfig, 'hasPassword'>, string> = {
  host: 'archiveNetworkHost',
  share: 'archiveNetworkShare',
  domain: 'archiveNetworkDomain',
  username: 'archiveNetworkUsername',
  subpath: 'archiveNetworkSubpath',
};

const PASSWORD_COLUMN = 'archiveNetworkPasswordSealed';

function assertString(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new ArchiveConfigError(field, `${field} must be a string`);
  }
}

function assertBoolean(field: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') {
    // Not coerced on purpose: the string 'false' is truthy, and these fields
    // gate writes and deletes.
    throw new ArchiveConfigError(field, `${field} must be true or false`);
  }
}

function assertIntegerInRange(field: string, value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ArchiveConfigError(field, `${field} must be a whole number between ${min} and ${max}`);
  }
}

function assertStringArray(field: string, value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || v.length === 0)) {
    throw new ArchiveConfigError(field, `${field} must be a list of object ids`);
  }
}

/** Whether a stored or supplied value is one of the three schedule modes. */
function isScheduleMode(value: unknown): value is ArchiveScheduleMode {
  return ARCHIVE_SCHEDULE_MODES.some(mode => mode === value);
}

function assertScheduleMode(value: unknown): asserts value is ArchiveScheduleMode {
  if (!isScheduleMode(value)) {
    throw new ArchiveConfigError('scheduleMode', 'scheduleMode must be "daily", "interval" or "custom"');
  }
}

/** Parse the stored selection, dropping anything that is not a usable id. */
function parseSelection(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

/** The single appSettings row a SELECT returns, as a record to read field by field,
 *  or undefined when there is no row. better-sqlite3 types `.get()` as `unknown`;
 *  the guard, not an assertion, is what makes it a record. */
function readSettingsRow(sql: string): Record<string, unknown> | undefined {
  const row: unknown = db.prepare(sql).get();
  return isRecord(row) ? row : undefined;
}

/** A TEXT column's value, or '' when absent or not a string. */
function stringField(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === 'string' ? value : '';
}

function isScalarSetting(key: string): key is ScalarSetting {
  return Object.prototype.hasOwnProperty.call(COLUMN_FOR, key);
}

function isNetworkColumnKey(key: string): key is keyof typeof NETWORK_COLUMN_FOR {
  return Object.prototype.hasOwnProperty.call(NETWORK_COLUMN_FOR, key);
}

function normalizeArchiveConfig(row: Record<string, unknown> | undefined): ArchiveConfig {
  if (!row) return { ...DEFAULT_ARCHIVE_CONFIG, selectedObjects: [] };

  const str = (key: string, fallback: string): string => {
    const value = row[key];
    return typeof value === 'string' ? value : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const value = row[key];
    if (value === 0 || value === 1) return value === 1;
    return typeof value === 'boolean' ? value : fallback;
  };
  const int = (key: string, fallback: number, min: number, max: number): number => {
    const value = row[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  };

  return {
    enabled: bool('archiveEnabled', false),
    path: str('archivePath', ''),
    // Anything outside the union reads back as the safe, narrower type, the same
    // way `scope` does below.
    locationType: row.archiveLocationType === 'network' ? 'network' : 'local',
    network: {
      host: str('archiveNetworkHost', ''),
      share: str('archiveNetworkShare', ''),
      domain: str('archiveNetworkDomain', ''),
      username: str('archiveNetworkUsername', ''),
      // Derived, never stored: a truthy string here is a sealed blob nobody outside
      // getArchiveNetworkCredentials() may read.
      hasPassword: str(PASSWORD_COLUMN, '') !== '',
      subpath: str('archiveNetworkSubpath', ''),
    },
    archiveId: str('archiveId', ''),
    // Anything outside the union reads back as the safe, narrower scope rather
    // than throwing or producing an impossible state.
    scope: row.archiveScope === 'selected' ? 'selected' : 'all',
    selectedObjects: parseSelection(row.archiveSelectedObjects),
    includeSubframes: bool('archiveIncludeSubframes', false),
    copyMinAgeDays: int('archiveCopyMinAgeDays', DEFAULT_ARCHIVE_CONFIG.copyMinAgeDays, 0, Number.MAX_SAFE_INTEGER),
    copyMinAgeEnabled: bool('archiveCopyMinAgeEnabled', false),
    scheduleEnabled: bool('archiveScheduleEnabled', false),
    // Anything outside the union reads back as 'daily', the mode that was the only
    // behaviour before these columns existed.
    scheduleMode: isScheduleMode(row.archiveScheduleMode) ? row.archiveScheduleMode : 'daily',
    scheduleHour: int('archiveScheduleHour', DEFAULT_ARCHIVE_CONFIG.scheduleHour, 0, 23),
    scheduleMinute: int('archiveScheduleMinute', DEFAULT_ARCHIVE_CONFIG.scheduleMinute, 0, 59),
    scheduleIntervalHours: int(
      'archiveScheduleIntervalHours',
      DEFAULT_ARCHIVE_CONFIG.scheduleIntervalHours,
      1,
      168,
    ),
    scheduleCron: str('archiveScheduleCron', ''),
    retentionDays: int('archiveRetentionDays', DEFAULT_ARCHIVE_CONFIG.retentionDays, 0, Number.MAX_SAFE_INTEGER),
    retentionEnabled: bool('archiveRetentionEnabled', false),
    retentionSubframesOnly: bool('archiveRetentionSubframesOnly', false),
    removeLocalAfter: bool('archiveRemoveLocalAfter', false),
    lastRunAt: str('archiveLastRunAt', ''),
    lastResult: str('archiveLastResult', ''),
  };
}

/** The current archive configuration. Never throws; malformed stored values fall
 *  back to their safe default. */
export function getArchiveConfig(): ArchiveConfig {
  const columns = [
    ...Object.values(COLUMN_FOR),
    ...Object.values(NETWORK_COLUMN_FOR),
    PASSWORD_COLUMN,
  ].join(', ');
  return normalizeArchiveConfig(readSettingsRow(`SELECT ${columns} FROM appSettings WHERE id = 1`));
}

/**
 * The network destination with its password, for the connect step and nothing else.
 *
 * Separate from `getArchiveConfig()` on purpose: the config is returned to the
 * settings UI and embedded in API responses, and the only way to be sure a password
 * never travels with it is for the config not to carry one. A blob that cannot be
 * decrypted (a database restored with a different `DATA_KEY`) degrades to an empty
 * password rather than throwing, the same convention as
 * `server/lib/libraryPath.ts`'s network config.
 */
export function getArchiveNetworkCredentials(): ArchiveNetworkCredentials {
  const columns = [...Object.values(NETWORK_COLUMN_FOR), PASSWORD_COLUMN].join(', ');
  const row = readSettingsRow(`SELECT ${columns} FROM appSettings WHERE id = 1`);
  const str = (key: string): string => stringField(row, key);

  let password = '';
  const sealed = str(PASSWORD_COLUMN);
  if (sealed !== '') {
    try {
      password = decrypt(sealed);
    } catch (err) {
      console.warn(
        `[archiveConfig] Could not decrypt the network archive password, treating it as absent: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    host: str('archiveNetworkHost'),
    share: str('archiveNetworkShare'),
    domain: str('archiveNetworkDomain'),
    username: str('archiveNetworkUsername'),
    subpath: str('archiveNetworkSubpath'),
    password,
  };
}

/**
 * The parts of the stored configuration that a patch has to be validated against
 * once applied, rather than against the fields the one call happens to mention.
 *
 * Two checks need this. A destination that *ends up* as a network one is checked at
 * the end of `setArchiveConfig`, and so is a schedule that ends up in 'custom' mode:
 * neither can be judged from the patch alone, because `{scheduleMode: 'custom'}` on
 * its own is only a problem if no expression was stored earlier.
 */
function storedConfigShape(): {
  locationType: ArchiveLocationType;
  host: string;
  share: string;
  scheduleMode: ArchiveScheduleMode;
  scheduleCron: string;
  retentionEnabled: boolean;
  retentionDays: number;
  copyMinAgeEnabled: boolean;
  copyMinAgeDays: number;
} {
  const row = readSettingsRow(
    `SELECT archiveLocationType, archiveNetworkHost, archiveNetworkShare, archiveScheduleMode,
            archiveScheduleCron, archiveRetentionEnabled, archiveRetentionDays,
            archiveCopyMinAgeEnabled, archiveCopyMinAgeDays
       FROM appSettings WHERE id = 1`,
  );
  const str = (key: string): string => stringField(row, key);
  const flag = (key: string): boolean => row?.[key] === 1 || row?.[key] === true;
  const days = typeof row?.archiveRetentionDays === 'number' ? row.archiveRetentionDays : 0;
  const minAgeDays = typeof row?.archiveCopyMinAgeDays === 'number' ? row.archiveCopyMinAgeDays : 0;
  return {
    locationType: str('archiveLocationType') === 'network' ? 'network' : 'local',
    host: str('archiveNetworkHost'),
    share: str('archiveNetworkShare'),
    scheduleMode: isScheduleMode(row?.archiveScheduleMode) ? row.archiveScheduleMode : 'daily',
    scheduleCron: str('archiveScheduleCron'),
    retentionEnabled: flag('archiveRetentionEnabled'),
    retentionDays: days,
    copyMinAgeEnabled: flag('archiveCopyMinAgeEnabled'),
    copyMinAgeDays: minAgeDays,
  };
}

/**
 * Refuse, at save time, the network fields the connect step would refuse later.
 *
 * Host, share, domain and username go through `sanitizePath`, which is what
 * `libraryNetwork.ts` calls before it builds a mount URL or a `net use` argument. A
 * value carrying a shell metacharacter or a newline has no business being stored,
 * and discovering that at connect time turns a form error into a failed mount.
 *
 * The subpath is checked differently on purpose: it is a path inside the share, so
 * separators are legitimate, and the rule that matters is that it cannot climb out.
 * `validatePathNoTraversal` is the same guard the library's mount uses, with the
 * explicit absolute check in front of it because that function reasons about paths
 * for the current platform only.
 *
 * The password is never checked this way. Passwords contain arbitrary characters,
 * and this would reject perfectly good ones.
 */
function assertNetworkField(key: keyof ArchiveNetworkPatch, value: string): void {
  if (key === 'subpath') {
    const sub = value.trim();
    if (sub === '') return; // the share root, allowed but never a default
    if (path.posix.isAbsolute(sub) || path.win32.isAbsolute(sub)) {
      throw new ArchiveConfigError('network.subpath', 'the folder inside the share must be a relative path');
    }
    try {
      validatePathNoTraversal(sub);
    } catch {
      throw new ArchiveConfigError('network.subpath', 'the folder inside the share cannot climb out of it');
    }
    return;
  }
  if (value === '') return;
  try {
    sanitizePath(value);
  } catch {
    throw new ArchiveConfigError(
      `network.${key}`,
      key !== 'host'
        ? `that ${key} contains characters that cannot be used`
        : /[\\/]/.test(value)
          ? 'the server address cannot contain a backslash or a slash; enter the address on its own, for example 192.168.1.12'
          : 'the server address contains characters that cannot be used; a name, an IP address, or either with a :port is what this field takes',
    );
  }
}

/**
 * Apply a partial configuration change.
 *
 * Every field is validated before any SQL runs, so a patch that is rejected
 * half-way through leaves the stored configuration exactly as it was. A caller
 * cannot end up with the destination saved and the retention period not.
 *
 * Also accepts an unvalidated record straight from a request body: every key is
 * checked against the known settings and every value by an assertion below, so
 * the static `ArchiveConfigPatch` type is a convenience for internal callers,
 * not the guarantee.
 */
export function setArchiveConfig(patch: ArchiveConfigPatch | Readonly<Record<string, unknown>>): void {
  const assignments: Array<{ column: string; value: string | number }> = [];
  const assign = (column: string, value: string | number): void => {
    assignments.push({ column, value });
  };

  // The stored shape, so the checks at the end are about the configuration this
  // patch *produces* rather than about the fields this one call happens to mention.
  const stored = storedConfigShape();
  let nextLocationType = stored.locationType;
  let nextHost = stored.host;
  let nextShare = stored.share;
  let nextScheduleMode = stored.scheduleMode;
  let nextScheduleCron = stored.scheduleCron;
  let nextRetentionEnabled = stored.retentionEnabled;
  let nextRetentionDays = stored.retentionDays;
  let nextCopyMinAgeEnabled = stored.copyMinAgeEnabled;
  let nextCopyMinAgeDays = stored.copyMinAgeDays;

  for (const key of Object.keys(patch)) {
    if (key === 'network') continue;
    if (!isScalarSetting(key)) {
      throw new ArchiveConfigError(key, `unknown archive setting "${key}"`);
    }
    const value = patch[key];
    // `undefined` means "not provided", not "set to undefined".
    if (value === undefined) continue;

    switch (key) {
      case 'path':
      case 'archiveId':
      case 'lastRunAt':
      case 'lastResult':
        assertString(key, value);
        assign(COLUMN_FOR[key], value);
        break;
      case 'locationType':
        if (value !== 'local' && value !== 'network') {
          throw new ArchiveConfigError('locationType', 'locationType must be "local" or "network"');
        }
        nextLocationType = value;
        assign(COLUMN_FOR[key], value);
        break;
      case 'scope':
        if (value !== 'all' && value !== 'selected') {
          throw new ArchiveConfigError('scope', 'scope must be "all" or "selected"');
        }
        assign(COLUMN_FOR[key], value);
        break;
      case 'selectedObjects':
        assertStringArray(key, value);
        assign(COLUMN_FOR[key], JSON.stringify(value));
        break;
      case 'scheduleMode':
        assertScheduleMode(value);
        nextScheduleMode = value;
        assign(COLUMN_FOR[key], value);
        break;
      case 'scheduleCron': {
        assertString(key, value);
        // Validated here, where the user can still be told which part is wrong,
        // rather than at the tick where the only option is to skip the run.
        const trimmed = value.trim();
        if (trimmed !== '') {
          const parsed = parseCron(trimmed);
          if (!parsed.ok) throw new ArchiveConfigError('scheduleCron', parsed.reason);
        }
        nextScheduleCron = trimmed;
        assign(COLUMN_FOR[key], trimmed);
        break;
      }
      case 'scheduleHour':
        assertIntegerInRange(key, value, 0, 23);
        assign(COLUMN_FOR[key], value);
        break;
      case 'scheduleMinute':
        assertIntegerInRange(key, value, 0, 59);
        assign(COLUMN_FOR[key], value);
        break;
      case 'scheduleIntervalHours':
        // A week is the ceiling: anything longer is a daily or custom schedule
        // written the hard way, and an unbounded number here hides a typo.
        assertIntegerInRange(key, value, 1, 168);
        assign(COLUMN_FOR[key], value);
        break;
      case 'retentionDays':
        assertIntegerInRange(key, value, 0, Number.MAX_SAFE_INTEGER);
        nextRetentionDays = value;
        assign(COLUMN_FOR[key], value);
        break;
      case 'copyMinAgeDays':
        assertIntegerInRange(key, value, 0, Number.MAX_SAFE_INTEGER);
        nextCopyMinAgeDays = value;
        assign(COLUMN_FOR[key], value);
        break;
      case 'enabled':
      case 'includeSubframes':
      case 'scheduleEnabled':
      case 'retentionEnabled':
      case 'retentionSubframesOnly':
      case 'removeLocalAfter':
      case 'copyMinAgeEnabled':
        assertBoolean(key, value);
        if (key === 'retentionEnabled') nextRetentionEnabled = value;
        if (key === 'copyMinAgeEnabled') nextCopyMinAgeEnabled = value;
        assign(COLUMN_FOR[key], value ? 1 : 0);
        break;
    }
  }

  const network = patch.network;
  if (network !== undefined) {
    // The patch arrives from a request body, so `network` is only typed, not known,
    // to be an object; isRecord is the real check (null, arrays and scalars refused).
    if (!isRecord(network)) {
      throw new ArchiveConfigError('network', 'network must be an object');
    }
    for (const key of Object.keys(network)) {
      const value: unknown = network[key];
      if (value === undefined) continue;

      if (key === 'password') {
        assertString('network.password', value);
        // Written, never read back. An empty string is not a way to clear it: see
        // ArchiveNetworkPatch.
        if (value !== '') assign(PASSWORD_COLUMN, encrypt(value));
        continue;
      }
      if (key === 'clearPassword') {
        if (typeof value !== 'boolean') {
          throw new ArchiveConfigError('network.clearPassword', 'network.clearPassword must be true or false');
        }
        if (value) assign(PASSWORD_COLUMN, '');
        continue;
      }
      // Derived from the sealed column, never written. Skipped rather than refused
      // so a config read can be handed back unchanged.
      if (key === 'hasPassword') continue;

      if (!isNetworkColumnKey(key)) {
        throw new ArchiveConfigError(`network.${key}`, `unknown network setting "${key}"`);
      }
      assertString(`network.${key}`, value);
      assertNetworkField(key, value);
      if (key === 'host') nextHost = value;
      if (key === 'share') nextShare = value;
      assign(NETWORK_COLUMN_FOR[key], value);
    }
  }

  // A destination that *ends up* as a network one needs a server and a share, and it
  // does not matter whether they arrived in this call or an earlier one. Without
  // this, `{locationType: 'network'}` on its own would store a destination that
  // cannot resolve.
  if (nextLocationType === 'network') {
    if (nextHost.trim() === '') {
      throw new ArchiveConfigError('network.host', 'a network destination needs a server address');
    }
    if (nextShare.trim() === '') {
      throw new ArchiveConfigError('network.share', 'a network destination needs a share name');
    }
  }

  // A schedule that ends up in custom mode needs an expression. Checked against the
  // result for the same reason as the destination above: switching the mode on its
  // own is only a problem when nothing usable was stored earlier.
  if (nextScheduleMode === 'custom' && nextScheduleCron === '') {
    throw new ArchiveConfigError('scheduleCron', 'a custom schedule needs a cron expression');
  }

  // Turning pruning on before choosing a period would arm a delete with nothing to
  // delete by. The period is what says "everything older than N days", so the order
  // the two arrive in does not matter, only that both are there at the end.
  if (nextRetentionEnabled && nextRetentionDays <= 0) {
    throw new ArchiveConfigError('retentionDays', 'turn on pruning after choosing how many days to keep');
  }

  // Same reasoning as retention above: a day count of 0 with the filter armed would
  // hold everything back forever, which is never what "wait N days" is meant to say.
  if (nextCopyMinAgeEnabled && nextCopyMinAgeDays <= 0) {
    throw new ArchiveConfigError('copyMinAgeDays', 'turn on the age filter after choosing how many days to wait');
  }

  if (assignments.length === 0) return;

  const sql = `UPDATE appSettings SET ${assignments.map(a => `${a.column} = ?`).join(', ')} WHERE id = 1`;
  db.prepare(sql).run(...assignments.map(a => a.value));
}
