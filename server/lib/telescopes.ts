/**
 * Multi-telescope profile manager + app settings — SQLite backed.
 * Telescope profiles stored in `telescopeProfiles` table (columnar).
 * App settings stored in `appSettings` table (columnar).
 */
import { randomUUID } from 'crypto';
import db from './db.js';
import { SKY_MAP_BANDS, SKY_MAP_CELLS } from './skyMapConfig.js';
import { type TelescopeKind, TELESCOPE_KINDS } from './types/telescopeKind.js';
import { encrypt, decrypt } from './crypto/secretBox.js';
import {
  addTransport,
  getTransportsForProfile,
  selectActiveTransport,
  updateTransport,
  isTransportKind,
  type TransportKind,
} from './telescopeTransports.js';

export type { TelescopeKind, TransportKind };

export interface TelescopeProfile {
  id: string;
  name: string;
  model: string;       // e.g. "SeeStar S50", "SeeStar S30"
  hostname: string;
  shareName: string;
  username: string;
  password: string;
  createdAt: string;
  kind: TelescopeKind;
  color: string;
  autoImportEnabled: boolean;
  autoImportInterval: number;
  archivedAt: number | null;
  /** SMB = LAN share (SeeStar). Local = direct filesystem path (Dwarf USB).
   *  Defaults to 'smb' so existing rows keep working without migration. */
  connectionType: TransportKind;
  /** Absolute filesystem path to the device's storage root when
   *  connectionType === 'local'. Empty string for SMB profiles. */
  localPath: string;
  /** UUID identifying the physical device, read from `.nebulis.dat` on the
   *  device's storage root. Null until the first successful connection
   *  stamps it. Used to merge profiles that point at the same hardware
   *  reached over different transports (e.g. SMB + USB). */
  deviceId: string | null;
  /** Per-telescope file-type filters. Drive what the import pipeline pulls
   *  off the device. Replaces the old global `appSettings.import*` fields so
   *  a Seestar with a big eMMC can import everything while a Dwarf on a
   *  smaller disk skips subframes. */
  importJpg: boolean;
  importFits: boolean;
  importThumbnails: boolean;
  importSubFrames: boolean;
  importVideos: boolean;
  /** When true (default), the import pipeline reads/writes `.nebulis.dat`
   *  on this device's storage root so the same physical telescope reached
   *  over SMB and USB resolves to one logical device. Disable for firmware
   *  that rejects unknown files at the share root, or when the user simply
   *  prefers we not write to the device. */
  trackDeviceIdentity: boolean;
}

interface FullSettings {
  telescopes: TelescopeProfile[];
  apiKey: string;
}

// Raw DB row for a telescope profile. `isActive` is stored as INTEGER 0/1
// and transformed into a boolean by rowToProfile below.
interface TelescopeProfileRow {
  id: string;
  name: string;
  model: string;
  hostname: string;
  shareName: string;
  username: string;
  password: string;
  isActive: number;
  createdAt: string;
  kind: string;
  color: string;
  autoImportEnabled: number;
  autoImportInterval: number;
  archivedAt: number | null;
  connectionType: string;
  localPath: string;
  deviceId: string | null;
  importJpg: number;
  importFits: number;
  importThumbnails: number;
  importSubFrames: number;
  importVideos: number;
  trackDeviceIdentity: number;
}

const COLOR_BY_KIND: Record<TelescopeKind, string> = {
  'seestar-s50': '#3b82f6',
  'seestar-s30': '#10b981',
  'dwarf-3':     '#f59e0b',
  'dwarf-2':     '#ef4444',
  'dwarf-mini':  '#f97316',
  'other':       '#8b5cf6',
};

function asKind(value: string | undefined | null): TelescopeKind {
  return TELESCOPE_KINDS.includes(value as TelescopeKind) ? (value as TelescopeKind) : 'other';
}

function kindFromModel(model: string): TelescopeKind {
  switch (model) {
    case 'SeeStar S50': return 'seestar-s50';
    case 'SeeStar S30': return 'seestar-s30';
    case 'Dwarf 3':     return 'dwarf-3';
    case 'Dwarf II':    return 'dwarf-2';
    case 'Dwarf Mini':  return 'dwarf-mini';
    default:            return 'other';
  }
}

// Typed prepared statements — row shapes enforced by telescopeProfiles schema
// (SQL trust boundary).
const profileStmts = {
  getAll: db.prepare<[], TelescopeProfileRow>('SELECT * FROM telescopeProfiles ORDER BY createdAt ASC'),
  getById: db.prepare<[string], TelescopeProfileRow>('SELECT * FROM telescopeProfiles WHERE id = ?'),
  insert: db.prepare(
    `INSERT INTO telescopeProfiles (id, name, model, hostname, shareName, username, password, isActive, createdAt, kind, color, autoImportEnabled, autoImportInterval, connectionType, localPath, importJpg, importFits, importThumbnails, importSubFrames, importVideos, trackDeviceIdentity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  update: db.prepare(
    `UPDATE telescopeProfiles SET name = ?, model = ?, hostname = ?, shareName = ?, username = ?, password = ?, kind = ?, color = ?, autoImportEnabled = ?, autoImportInterval = ?, connectionType = ?, localPath = ?, importJpg = ?, importFits = ?, importThumbnails = ?, importSubFrames = ?, importVideos = ?, trackDeviceIdentity = ? WHERE id = ?`
  ),
  delete: db.prepare('DELETE FROM telescopeProfiles WHERE id = ?'),
  count: db.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM telescopeProfiles'),
  countActive: db.prepare<[], { c: number }>(
    'SELECT COUNT(*) as c FROM telescopeProfiles WHERE archivedAt IS NULL'
  ),
  setArchived: db.prepare('UPDATE telescopeProfiles SET archivedAt = ? WHERE id = ?'),
  setDeviceId: db.prepare('UPDATE telescopeProfiles SET deviceId = ? WHERE id = ?'),
  findByDeviceId: db.prepare<[string], TelescopeProfileRow>(
    'SELECT * FROM telescopeProfiles WHERE deviceId = ?',
  ),
  bulkReassignSessions: db.prepare(
    'UPDATE librarySessions SET telescopeId = ? WHERE telescopeId = ?'
  ),
  bulkReassignObjects: db.prepare(
    'UPDATE libraryObjects SET primaryTelescopeId = ? WHERE primaryTelescopeId = ?'
  ),
};

const appSettingsStmts = {
  get: db.prepare<[], AppSettingsRow>('SELECT * FROM appSettings WHERE id = 1'),
  update: db.prepare(`UPDATE appSettings SET
    apiKey = ?,
    latitude = ?, longitude = ?, locationName = ?, timezone = ?,
    minAlt = ?, horizonProfile = ?,
    syncEnabled = ?, syncJpg = ?, syncFits = ?, syncThumbnails = ?,
    syncSubFrames = ?, syncVideos = ?,
    autoImport = ?, autoImportInterval = ?,
    importJpg = ?, importFits = ?, importThumbnails = ?,
    importSubFrames = ?, importVideos = ?,
    onboardingCompleted = ?,
    prefetchCatalogAssets = ?,
    planetariumShowInfo = ?,
    galleryImageSource = ?,
    slideshowRotateCCW = ?,
    preferredCatalog = ?,
    groupObservingNights = ?,
    temperatureUnit = ?,
    windSpeedUnit = ?,
    visibleSkyMap = ?,
    updateChannel = ?,
    autoUpdateEnabled = ?,
    plannerPrefetchEnabled = ?,
    plannerPrefetchTime = ?,
    plannerPrefetchLastRun = ?,
    nightlyCatalogPackCheckEnabled = ?,
    nightlyHousekeepingEnabled = ?,
    nightlyForecastPrefetchEnabled = ?,
    nightlyHousekeepingLastRun = ?,
    nightlyForecastLastRun = ?
    WHERE id = 1`),
  getApiKey: db.prepare<[], { apiKey: string }>('SELECT apiKey FROM appSettings WHERE id = 1'),
  setApiKey: db.prepare('UPDATE appSettings SET apiKey = ? WHERE id = 1'),
};

function rowToProfile(row: TelescopeProfileRow): TelescopeProfile {
  const ct: TransportKind = isTransportKind(row.connectionType) ? row.connectionType : 'smb';
  // decrypt() throws on bad ciphertext (e.g. DB restored from a backup with a
  // different DATA_KEY). A single bad row used to take down the whole telescope
  // list with a 500; downgrade to an empty password so the user can fix it
  // from the UI instead.
  let decryptedPassword = '';
  if (row.password) {
    try {
      decryptedPassword = decrypt(row.password);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Invalid encrypted blob: expected 3 dot-separated parts') {
        // Plaintext password stored before encryption was introduced — use as-is.
        decryptedPassword = row.password;
      } else {
        console.warn(`[telescopes] Failed to decrypt password for profile ${row.id}: ${msg}`);
      }
    }
  }
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    hostname: row.hostname,
    shareName: row.shareName,
    username: row.username,
    password: decryptedPassword,
    createdAt: row.createdAt,
    kind: asKind(row.kind),
    color: row.color || COLOR_BY_KIND[asKind(row.kind)],
    autoImportEnabled: Boolean(row.autoImportEnabled),
    autoImportInterval: row.autoImportInterval ?? 60,
    archivedAt: row.archivedAt ?? null,
    connectionType: ct,
    localPath: row.localPath ?? '',
    deviceId: row.deviceId ?? null,
    importJpg: Boolean(row.importJpg),
    importFits: Boolean(row.importFits),
    importThumbnails: Boolean(row.importThumbnails),
    importSubFrames: Boolean(row.importSubFrames),
    importVideos: Boolean(row.importVideos),
    // Legacy rows pre-migration have NULL here; default to true so existing
    // installs keep the tracking they had until the user opts out.
    trackDeviceIdentity: row.trackDeviceIdentity === null || row.trackDeviceIdentity === undefined
      ? true
      : Boolean(row.trackDeviceIdentity),
  };
}

interface AppSettingsRow {
  id: number;
  apiKey: string;
  latitude: number | null;
  longitude: number | null;
  locationName: string;
  timezone: string;
  minAlt: number;
  horizonProfile: string; // JSON array stored as TEXT
  syncEnabled: number;
  syncJpg: number;
  syncFits: number;
  syncThumbnails: number;
  syncSubFrames: number;
  syncVideos: number;
  autoImportInterval: number;
  importJpg: number;
  importFits: number;
  importThumbnails: number;
  importSubFrames: number;
  importVideos: number;
  onboardingCompleted: number;
  prefetchCatalogAssets: number;
  planetariumShowInfo: number;
  galleryImageSource: string;
  slideshowRotateCCW: number;
  preferredCatalog: string; // 'default' | 'caldwell'
  groupObservingNights: number;
  temperatureUnit: string;
  windSpeedUnit: string;
  visibleSkyMap: string; // JSON array of 288 booleans (36 azimuth slices × 8 elevation bands)
  updateChannel: string; // 'stable' | 'beta'
  autoUpdateEnabled: number;
  plannerPrefetchEnabled: number;
  plannerPrefetchTime: string;
  plannerPrefetchLastRun: number | null;
  nightlyCatalogPackCheckEnabled: number;
  nightlyHousekeepingEnabled: number;
  nightlyForecastPrefetchEnabled: number;
  nightlyHousekeepingLastRun: number | null;
  nightlyForecastLastRun: number | null;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

function rowToSettings(row: AppSettingsRow): Record<string, unknown> {
  const rawHp: unknown = JSON.parse(row.horizonProfile || '[]');
  const horizonProfile =
    Array.isArray(rawHp) && rawHp.length === 36 && rawHp.every(isFiniteNumber)
      ? rawHp
      : Array(36).fill(0);
  // visibleSkyMap: 288-element boolean array, or empty (= no map set, sky
  // treated as fully visible by the visibility check on the client).
  const rawMap: unknown = JSON.parse(row.visibleSkyMap || '[]');
  const visibleSkyMap =
    Array.isArray(rawMap) && rawMap.length === SKY_MAP_CELLS && rawMap.every(isBoolean)
      ? rawMap
      : [];
  return {
    apiKey: row.apiKey,
    latitude: row.latitude,
    longitude: row.longitude,
    locationName: row.locationName || '',
    timezone: row.timezone,
    minAlt: row.minAlt,
    horizonProfile,
    syncEnabled: Boolean(row.syncEnabled),
    syncJpg: Boolean(row.syncJpg),
    syncFits: Boolean(row.syncFits),
    syncThumbnails: Boolean(row.syncThumbnails),
    syncSubFrames: Boolean(row.syncSubFrames),
    syncVideos: Boolean(row.syncVideos),
    autoImportInterval: row.autoImportInterval,
    importJpg: Boolean(row.importJpg),
    importFits: Boolean(row.importFits),
    importThumbnails: Boolean(row.importThumbnails),
    importSubFrames: Boolean(row.importSubFrames),
    importVideos: Boolean(row.importVideos),
    onboardingCompleted: Boolean(row.onboardingCompleted),
    prefetchCatalogAssets: Boolean(row.prefetchCatalogAssets),
    planetariumShowInfo: Boolean(row.planetariumShowInfo),
    galleryImageSource: row.galleryImageSource || 'sky-survey',
    slideshowRotateCCW: Boolean(row.slideshowRotateCCW),
    preferredCatalog: row.preferredCatalog === 'caldwell' ? 'caldwell' : 'default',
    // See server/lib/telescopeFiles.ts for what this gates.
    groupObservingNights: Boolean(row.groupObservingNights ?? 1),
    temperatureUnit: row.temperatureUnit || 'fahrenheit',
    windSpeedUnit: row.windSpeedUnit || 'mph',
    visibleSkyMap,
    // Advertised so native clients can gate the finer-grid editor; clients that
    // ignore it keep working at their built-in resolution.
    skyMapBands: SKY_MAP_BANDS,
    updateChannel: row.updateChannel === 'beta' ? 'beta' : 'stable',
    autoUpdateEnabled: Boolean(row.autoUpdateEnabled),
    plannerPrefetchEnabled: Boolean(row.plannerPrefetchEnabled ?? 1),
    plannerPrefetchTime: row.plannerPrefetchTime || '03:00',
    plannerPrefetchLastRun: row.plannerPrefetchLastRun ?? null,
    nightlyCatalogPackCheckEnabled: Boolean(row.nightlyCatalogPackCheckEnabled ?? 1),
    nightlyHousekeepingEnabled: Boolean(row.nightlyHousekeepingEnabled ?? 1),
    nightlyForecastPrefetchEnabled: Boolean(row.nightlyForecastPrefetchEnabled ?? 1),
    nightlyHousekeepingLastRun: row.nightlyHousekeepingLastRun ?? null,
    nightlyForecastLastRun: row.nightlyForecastLastRun ?? null,
  };
}

function saveSettingsRow(data: Record<string, unknown>): void {
  // Narrow `unknown` fields via constructor-style coercions instead of casting.
  const boolToInt = (v: unknown, def: number) => v === true ? 1 : v === false ? 0 : def;
  const str = (v: unknown, def: string) => typeof v === 'string' ? v : def;
  const num = (v: unknown, def: number) => typeof v === 'number' ? v : def;
  const numOrNull = (v: unknown) => typeof v === 'number' ? v : null;
  appSettingsStmts.update.run(
    str(data.apiKey, ''),
    numOrNull(data.latitude),
    numOrNull(data.longitude),
    str(data.locationName, ''),
    str(data.timezone, ''),
    num(data.minAlt, 20),
    JSON.stringify(data.horizonProfile || []),
    boolToInt(data.syncEnabled, 1), boolToInt(data.syncJpg, 1),
    boolToInt(data.syncFits, 1), boolToInt(data.syncThumbnails, 1),
    boolToInt(data.syncSubFrames, 0), boolToInt(data.syncVideos, 0),
    boolToInt(data.autoImport, 0), num(data.autoImportInterval, 60),
    boolToInt(data.importJpg, 1), boolToInt(data.importFits, 1),
    boolToInt(data.importThumbnails, 0), boolToInt(data.importSubFrames, 0),
    boolToInt(data.importVideos, 0),
    boolToInt(data.onboardingCompleted, 0),
    boolToInt(data.prefetchCatalogAssets, 0),
    boolToInt(data.planetariumShowInfo, 1),
    str(data.galleryImageSource, 'sky-survey'),
    boolToInt(data.slideshowRotateCCW, 0),
    data.preferredCatalog === 'caldwell' ? 'caldwell' : 'default',
    boolToInt(data.groupObservingNights, 1),
    str(data.temperatureUnit, 'fahrenheit'),
    str(data.windSpeedUnit, 'mph'),
    JSON.stringify(
      Array.isArray(data.visibleSkyMap) && data.visibleSkyMap.length === SKY_MAP_CELLS
        ? data.visibleSkyMap.map(v => v === true)
        : [],
    ),
    data.updateChannel === 'beta' ? 'beta' : 'stable',
    boolToInt(data.autoUpdateEnabled, 0),
    boolToInt(data.plannerPrefetchEnabled, 1),
    str(data.plannerPrefetchTime, '03:00'),
    numOrNull(data.plannerPrefetchLastRun),
    boolToInt(data.nightlyCatalogPackCheckEnabled, 1),
    boolToInt(data.nightlyHousekeepingEnabled, 1),
    boolToInt(data.nightlyForecastPrefetchEnabled, 1),
    numOrNull(data.nightlyHousekeepingLastRun),
    numOrNull(data.nightlyForecastLastRun),
  );
}

export function getAllProfiles(): TelescopeProfile[] {
  return profileStmts.getAll.all().map(rowToProfile);
}

export function getProfileById(id: string): TelescopeProfile | null {
  const row = profileStmts.getById.get(id);
  return row ? rowToProfile(row) : null;
}

/** A profile is "addressable" if it has at least one transport with either a
 *  hostname (SMB) or a localPath (USB) configured. Falls back to the legacy
 *  mirror columns when a profile has no transport rows yet (only possible
 *  during the transition; createProfile seeds a row on every fresh insert). */
function isAddressable(p: TelescopeProfile): boolean {
  const transports = getTransportsForProfile(p.id);
  if (transports.length > 0) {
    return transports.some(t =>
      t.kind === 'local' ? !!t.localPath : !!t.hostname,
    );
  }
  return p.connectionType === 'local' ? !!p.localPath : !!p.hostname;
}

/** Profiles that the auto-import *scheduler* should poll. Archived profiles
 *  are excluded — retiring a scope should not silently keep polling it. Also
 *  filters out profiles where the user has switched auto-import off, since
 *  that toggle exists precisely to opt out of the scheduler. */
export function getAutoImportProfiles(): TelescopeProfile[] {
  return getAllProfiles().filter(p =>
    p.autoImportEnabled && p.archivedAt === null && isAddressable(p),
  );
}

/** Profiles a *manual* "Import Now" sweep should hit. Same set as the
 *  auto-import pool minus the auto-import toggle, since clicking Import Now
 *  is an explicit user intent to sync everything reachable. Archived
 *  profiles still get skipped — restoring them is a one-click action and we
 *  don't want a hidden archive to silently pull files. */
export function getManualImportProfiles(): TelescopeProfile[] {
  return getAllProfiles().filter(p =>
    p.archivedAt === null && isAddressable(p),
  );
}

/** Profiles that should appear in pickers for "active" operations (creating
 *  new sessions, reassignment targets, etc.). Excludes archived profiles. */
export function getActiveProfiles(): TelescopeProfile[] {
  return getAllProfiles().filter(p => p.archivedAt === null);
}

export function getFullSettings(): FullSettings {
  const profiles = getAllProfiles();
  const row = appSettingsStmts.get.get();
  return {
    telescopes: profiles,
    apiKey: row?.apiKey || '',
  };
}

export function createProfile(data: Partial<TelescopeProfile>): TelescopeProfile {
  const count = profileStmts.count.get()?.c ?? 0;
  const model = data.model || 'SeeStar S50';
  const kind = data.kind ? asKind(data.kind) : kindFromModel(model);
  // Default Dwarf kinds to local-fs connection (Dwarf devices expose USB mass
  // storage, not SMB); everything else stays on SMB.
  const defaultConnectionType: TransportKind =
    kind === 'dwarf-2' || kind === 'dwarf-3' || kind === 'dwarf-mini' ? 'local' : 'smb';
  const profile: TelescopeProfile = {
    id: randomUUID(),
    name: data.name || `SeeStar ${count + 1}`,
    model,
    hostname: data.hostname || '',
    shareName: data.shareName || 'EMMC Images',
    username: data.username || 'guest',
    password: data.password || '',
    createdAt: new Date().toISOString(),
    kind,
    color: data.color || COLOR_BY_KIND[kind],
    autoImportEnabled: data.autoImportEnabled ?? true,
    autoImportInterval: data.autoImportInterval ?? 60,
    archivedAt: null,
    connectionType: data.connectionType ?? defaultConnectionType,
    localPath: data.localPath ?? '',
    deviceId: null,
    importJpg: data.importJpg ?? true,
    importFits: data.importFits ?? true,
    importThumbnails: data.importThumbnails ?? false,
    importSubFrames: data.importSubFrames ?? false,
    importVideos: data.importVideos ?? false,
    trackDeviceIdentity: data.trackDeviceIdentity ?? true,
  };

  profileStmts.insert.run(
    profile.id, profile.name, profile.model, profile.hostname,
    profile.shareName, profile.username,
    profile.password ? encrypt(profile.password) : '',
    0, profile.createdAt,
    profile.kind, profile.color, profile.autoImportEnabled ? 1 : 0,
    profile.autoImportInterval,
    profile.connectionType, profile.localPath,
    profile.importJpg ? 1 : 0,
    profile.importFits ? 1 : 0,
    profile.importThumbnails ? 1 : 0,
    profile.importSubFrames ? 1 : 0,
    profile.importVideos ? 1 : 0,
    profile.trackDeviceIdentity ? 1 : 0,
  );

  // Seed a matching transport row so the new model (profile + N transports) is
  // consistent from creation. The legacy columns above stay as a mirror of
  // the active transport; the import pipeline now resolves via the transport
  // table, falling back to the legacy columns only if no transport exists.
  addTransport(profile.id, {
    kind: profile.connectionType,
    hostname: profile.hostname,
    shareName: profile.shareName,
    username: profile.username,
    password: profile.password,
    localPath: profile.localPath,
  });

  return profile;
}

export function updateProfile(id: string, data: Partial<TelescopeProfile>): TelescopeProfile | null {
  const existing = profileStmts.getById.get(id);
  if (!existing) return null;

  const updated: TelescopeProfile = {
    ...rowToProfile(existing),
    ...data,
    id: existing.id,
    createdAt: existing.createdAt,
  };

  profileStmts.update.run(
    updated.name, updated.model, updated.hostname, updated.shareName,
    updated.username,
    updated.password ? encrypt(updated.password) : '',
    asKind(updated.kind), updated.color || COLOR_BY_KIND[asKind(updated.kind)],
    updated.autoImportEnabled ? 1 : 0,
    updated.autoImportInterval ?? 60,
    updated.connectionType === 'local' ? 'local' : 'smb',
    updated.localPath ?? '',
    updated.importJpg ? 1 : 0,
    updated.importFits ? 1 : 0,
    updated.importThumbnails ? 1 : 0,
    updated.importSubFrames ? 1 : 0,
    updated.importVideos ? 1 : 0,
    updated.trackDeviceIdentity ? 1 : 0,
    id
  );

  // Keep the transports table in sync with the legacy mirror columns. Without
  // this, editing IP/share/credentials via the modal updates the profile but
  // the transport row stays stale — and the import pipeline reads from the
  // transports table, so the edits silently wouldn't take effect.
  //
  // Strategy: for each kind ('smb' and 'local') the user has connection data
  // for, find the matching transport rows and patch them. If a kind has no
  // transport row yet, only create one when its fields are populated *and*
  // it matches the saved `connectionType` — otherwise we'd spawn empty rows
  // every time someone edits a Seestar that only uses one transport.
  const transports = getTransportsForProfile(id);
  const smbTransports = transports.filter(t => t.kind === 'smb');
  const localTransports = transports.filter(t => t.kind === 'local');

  if (updated.hostname || updated.shareName || updated.username || updated.password) {
    for (const t of smbTransports) {
      updateTransport(t.id, {
        hostname: updated.hostname,
        shareName: updated.shareName,
        username: updated.username,
        password: updated.password,
      });
    }
    if (smbTransports.length === 0 && updated.connectionType === 'smb') {
      addTransport(id, {
        kind: 'smb',
        hostname: updated.hostname,
        shareName: updated.shareName,
        username: updated.username,
        password: updated.password,
      });
    }
  }
  if (updated.localPath) {
    for (const t of localTransports) {
      updateTransport(t.id, { localPath: updated.localPath });
    }
    if (localTransports.length === 0 && updated.connectionType === 'local') {
      addTransport(id, { kind: 'local', localPath: updated.localPath });
    }
  }

  const refreshed = profileStmts.getById.get(id);
  return refreshed ? rowToProfile(refreshed) : null;
}

export function deleteProfile(id: string): boolean {
  const existing = profileStmts.getById.get(id);
  if (!existing) return false;

  if (getAllProfiles().length <= 1) return false;

  profileStmts.delete.run(id);
  return true;
}

export type ArchiveResult = 'ok' | 'not_found';

/**
 * Mark a profile as archived. Refuses to archive the last unarchived profile
 * — at least one active scope must remain so the import / discovery paths
 * have somewhere to point. Sessions previously attributed to the archived
 * profile keep their `telescopeId` so historical attribution survives.
 */
export function archiveProfile(id: string): ArchiveResult {
  const existing = profileStmts.getById.get(id);
  if (!existing) return 'not_found';
  if (existing.archivedAt !== null) return 'ok'; // already archived — idempotent
  profileStmts.setArchived.run(Date.now(), id);
  return 'ok';
}

/** Restore an archived profile. Idempotent. */
export function unarchiveProfile(id: string): boolean {
  const existing = profileStmts.getById.get(id);
  if (!existing) return false;
  profileStmts.setArchived.run(null, id);
  return true;
}

/** Stamp the deviceId on a profile. Called the first time we successfully
 *  read or write `.nebulis.dat` on any of the profile's transports. */
export function setProfileDeviceId(id: string, deviceId: string): boolean {
  const existing = profileStmts.getById.get(id);
  if (!existing) return false;
  profileStmts.setDeviceId.run(deviceId, id);
  return true;
}

/** Look up the profile (if any) that owns a given deviceId. Used by the
 *  add-telescope flow to surface the merge prompt when a user is about to
 *  create a second profile for hardware we already know. */
export function getProfileByDeviceId(deviceId: string): TelescopeProfile | null {
  const row = profileStmts.findByDeviceId.get(deviceId);
  return row ? rowToProfile(row) : null;
}

/** Pick the telescope that single-target legacy routes should hit when they
 *  don't carry an explicit profile id (e.g. the StorageDashboard's SMB list,
 *  the /telescope/test endpoint). Prefers Seestar-shaped scopes since those
 *  surfaces are labelled "SeeStar Telescope". Returns the profile with its
 *  legacy connection fields overridden by the currently-active transport so
 *  the SMB layer reads the right hostname even if the user added a USB
 *  transport via the new endpoint. */
export function pickDefaultTarget(): TelescopeProfile | null {
  const profiles = getActiveProfiles();
  if (profiles.length === 0) return null;
  const seestar = profiles.find(p => p.kind === 'seestar-s50' || p.kind === 'seestar-s30');
  const base = seestar ?? profiles[0];
  const t = selectActiveTransport(base.id);
  if (!t) return base;
  return {
    ...base,
    connectionType: t.kind,
    hostname: t.hostname,
    shareName: t.shareName,
    username: t.username,
    password: t.password,
    localPath: t.localPath,
  };
}

export interface BulkReassignResult {
  sessionsUpdated: number;
  objectsUpdated: number;
}

/**
 * Move every session attributed to `fromId` over to `toId`. Updates
 * `librarySessions.telescopeId` *and* `libraryObjects.primaryTelescopeId`
 * (which the gallery uses for the per-object accent color) inside a single
 * transaction so the UI never sees a half-migrated state.
 *
 * Caller is responsible for ensuring both ids exist. Same-id is a no-op.
 */
export function bulkReassignTelescope(fromId: string, toId: string): BulkReassignResult {
  if (fromId === toId) return { sessionsUpdated: 0, objectsUpdated: 0 };
  const tx = db.transaction((from: string, to: string) => {
    const sessions = profileStmts.bulkReassignSessions.run(to, from);
    const objects = profileStmts.bulkReassignObjects.run(to, from);
    return {
      sessionsUpdated: Number(sessions.changes ?? 0),
      objectsUpdated: Number(objects.changes ?? 0),
    };
  });
  return tx(fromId, toId);
}

// ─── App Settings helpers (columnar SQL) ────────────────────────────────────

export function getSettingsData(): Record<string, unknown> {
  const row = appSettingsStmts.get.get();
  // The appSettings table is seeded with a singleton INSERT OR IGNORE at
  // db.ts load time, so a missing row here signals a schema bug worth crashing on.
  if (!row) throw new Error('[telescopes] appSettings row missing');
  return rowToSettings(row);
}

export function updateSettingsData(updates: Record<string, unknown>): void {
  const row = appSettingsStmts.get.get();
  if (!row) throw new Error('[telescopes] appSettings row missing');
  const current = rowToSettings(row);
  saveSettingsRow({ ...current, ...updates });
}

export function getApiKey(): string {
  const row = appSettingsStmts.getApiKey.get();
  return row?.apiKey ?? '';
}

export function setApiKey(key: string): void {
  appSettingsStmts.setApiKey.run(key);
}
