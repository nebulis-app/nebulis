import { fetchJSON, BASE, authHeaders, errorMessage } from './client';

interface StorageObject {
  id: string;
  name: string;
  totalSize: number;
  fileCount: number;
  subFrameCount: number;
  subFrameSize: number;
  imageCount: number;
  fitsCount: number;
  oldestFile: string | null;
  newestFile: string | null;
}
interface StorageStats { objects: StorageObject[]; telescopeOnline: boolean; telescopeKind: string | null; }
export const getStorageStats = () => fetchJSON<StorageStats>('/storage');

interface DiskUsage {
  total: number; used: number; free: number;
  usedPercent: number;
  totalFormatted: string; usedFormatted: string; freeFormatted: string;
}
interface SystemStorage {
  disk: DiskUsage | null;
  dataDir: {
    path: string;
    size: number;
    files: number;
    sizeFormatted: string;
    breakdown: Array<{ name: string; size: number; files: number; sizeFormatted: string }>;
  };
  // Present only when the library has been relocated to a different physical
  // drive than the app data directory. Null otherwise (default location or same
  // volume, where it would duplicate the local-server figures).
  libraryDisk: (DiskUsage & { path: string }) | null;
}
export const getSystemStorage = () => fetchJSON<SystemStorage>('/storage/system');

interface LibraryObjectStat {
  objectId: string;
  name: string;
  size: number;
  sizeFormatted: string;
  fileCount: number;
}
export const getLibraryStorage = () => fetchJSON<{ objects: LibraryObjectStat[] }>('/storage/library');

// ─── Library location & migration ───────────────────────────────────────────

export interface VolumeInfo {
  path: string;
  label: string;
  totalBytes: number;
  freeBytes: number;
  writable: boolean;
  external: boolean;
}
/** Whether this browser runs on the same computer as the Nebulis server. */
export const getClientLocality = () =>
  fetchJSON<{ sameMachine: boolean; serverName: string }>('/storage/client-locality');

export const listVolumes = () => fetchJSON<{ volumes: VolumeInfo[] }>('/storage/volumes');

export interface DirectoryEntry { name: string; path: string; }
export const browseDirectory = (path: string) =>
  fetchJSON<{ path: string; directories: DirectoryEntry[] }>(`/storage/browse?path=${encodeURIComponent(path)}`);

/** Ask the server whether a dropped folder already exists on its own disk.
 *  Returns the scan-root path when a name + file-size fingerprint matches,
 *  or null when nothing matches (fall back to uploading). */
export const locateFolderOnServer = (
  anchorName: string,
  samples: Array<{ relativePath: string; size: number }>,
  signal?: AbortSignal,
) =>
  fetchJSON<{ path: string | null }>('/storage/locate-folder', {
    method: 'POST',
    body: JSON.stringify({ anchorName, samples }),
    signal,
  });

export interface NetworkLibraryConfig {
  host: string;
  share: string;
  domain: string;
  username: string;
  password: string;
  subpath: string;
}

export interface LibraryLocation {
  path: string;
  isDefault: boolean;
  available: boolean;
  libraryId: string;
  locationType: 'local' | 'network';
  /** The built-in location ({DATA_DIR}/library) — lets the UI offer a
   *  one-click "move back to default" without browsing for it. */
  defaultPath: string;
  /** Non-secret fields only — kept around in local mode too, to prefill the
   *  "Network Share" form with the last-used values. Never a password. */
  network: Omit<NetworkLibraryConfig, 'password'>;
  /** false on Linux/Docker — hide the "Network Share" option there. */
  networkLibrarySupported: boolean;
  /** true when the LIBRARY_DIR env var pins the location — hide "Change" / "Move"
   *  and show the path as fixed by the deployment. */
  pinned: boolean;
}

type MigrationPhase =
  | 'idle' | 'validating' | 'copying' | 'verifying' | 'finalizing' | 'complete' | 'error';

export interface MigrationStatus {
  phase: MigrationPhase;
  fromPath: string | null;
  toPath: string | null;
  bytesTotal: number;
  bytesCopied: number;
  filesTotal: number;
  filesCopied: number;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
  previousPath: string | null;
}

export const getLibraryLocation = () =>
  fetchJSON<{ location: LibraryLocation; migration: MigrationStatus }>('/storage/library-location');

export const startLibraryMigration = (targetPath: string) =>
  fetchJSON<{ migration: MigrationStatus }>('/storage/migrate', {
    method: 'POST',
    body: JSON.stringify({ targetPath }),
  });

export const startNetworkLibraryMigration = (network: NetworkLibraryConfig) =>
  fetchJSON<{ migration: MigrationStatus }>('/storage/migrate', {
    method: 'POST',
    body: JSON.stringify({ network }),
  });

/** Forget a relocated library location without copying any files. Use when the
 *  old drive/path is gone for good (e.g. a DB migrated from another machine).
 *  The library then resolves to the default location. */
export const resetLibraryLocation = () =>
  fetchJSON<{ ok: boolean; changed: boolean; path: string; previousPath: string }>(
    '/storage/library-location/reset',
    { method: 'POST' },
  );

export const testNetworkLibraryConnection = (network: NetworkLibraryConfig) =>
  fetchJSON<{ ok: boolean; reason?: string }>('/storage/library-location/network/test', {
    method: 'POST',
    body: JSON.stringify(network),
  });


// ─── Database backups (pre-upgrade snapshots + manual) ──────────────────────

export interface DatabaseBackupInfo {
  name: string;
  path: string;
  kind: 'upgrade' | 'manual';
  version: string | null;
  createdAt: number;
  sizeBytes: number;
}

export interface LastBackupAttempt {
  at: number;
  fromVersion: string | null;
  toVersion: string;
  status: 'created' | 'failed';
  error?: string;
  backupName?: string;
}

export interface DatabaseBackupsResponse {
  backups: DatabaseBackupInfo[];
  lastAttempt: LastBackupAttempt | null;
  dir: string;
  maxRetainedPerKind: number;
  currentVersion: string;
}

export const getDatabaseBackups = () =>
  fetchJSON<DatabaseBackupsResponse>('/storage/db-backups');

export const createDatabaseBackup = () =>
  fetchJSON<{ backup: DatabaseBackupInfo; pruned: number }>('/storage/db-backups', {
    method: 'POST',
  });

export const deleteDatabaseBackup = (name: string) =>
  fetchJSON<{ deleted: boolean; name: string }>(`/storage/db-backups/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });

/** Downloads a gzipped copy of the backup through the browser. */
export async function downloadDatabaseBackup(name: string): Promise<void> {
  const res = await fetch(
    `${BASE}/storage/db-backups/${encodeURIComponent(name)}/download`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    throw new Error(errorMessage(body, res.statusText));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.gz`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// ─── External archive ───────────────────────────────────────────────────────

export type ArchiveScope = 'all' | 'selected';

export interface ArchiveNetworkConfig {
  host: string;
  share: string;
  domain: string;
  username: string;
  /** Whether a password is stored on the server. The password itself is never sent
   *  to the client, so this is the only thing the form can know about it. */
  hasPassword: boolean;
  /** Folder inside the share. Empty means the share root. */
  subpath: string;
}

/** A network destination as the form sends it: the same fields, with a password
 *  instead of the flag. An empty or omitted password keeps the stored one. */
export interface ArchiveNetworkPatch {
  host?: string;
  share?: string;
  domain?: string;
  username?: string;
  subpath?: string;
  password?: string;
  clearPassword?: boolean;
}

export interface ArchiveConfig {
  /** The master switch. Off means the section is inert and the server refuses to
   *  write to or delete from the disk. */
  enabled: boolean;
  /** Destination root, for a local destination. */
  path: string;
  locationType: 'local' | 'network';
  network: ArchiveNetworkConfig;
  archiveId: string;
  scope: ArchiveScope;
  selectedObjects: string[];
  includeSubframes: boolean;
  /** Skip copying anything younger than this many days, measured from capture.
   *  Read only while `copyMinAgeEnabled` is on. */
  copyMinAgeDays: number;
  /** Whether the minimum-age filter above is armed. */
  copyMinAgeEnabled: boolean;
  scheduleEnabled: boolean;
  scheduleMode: ArchiveScheduleMode;
  /** The hour the daily mode runs at. */
  scheduleHour: number;
  /** The minute the daily mode runs at. */
  scheduleMinute: number;
  /** Hours between runs, for the interval mode. */
  scheduleIntervalHours: number;
  /** A five-field cron expression, for the custom mode. */
  scheduleCron: string;
  retentionDays: number;
  /** Whether pruning is armed. */
  retentionEnabled: boolean;
  retentionSubframesOnly: boolean;
  removeLocalAfter: boolean;
  lastRunAt: string;
  lastResult: string;
}

/** How the schedule decides when a run is due. `daily` and `interval` are the two
 *  simple choices; `custom` is a cron expression. */
export type ArchiveScheduleMode = 'daily' | 'interval' | 'custom';

/**
 * What the destination disk looks like right now.
 *
 * `invalid-path` means the stored path is not a usable destination at all (it
 * overlaps the library or the data folder), which is different from a disk that
 * is merely absent or holds someone else's archive.
 */
export type ArchiveDestinationState =
  | 'unconfigured'
  | 'invalid-path'
  /** A share that is configured and not mounted right now. Distinct from `absent`
   *  because `absent` is what the UI offers to adopt, and an unmounted share's mount
   *  directory is an ordinary empty folder. */
  | 'offline'
  | 'absent'
  | 'match'
  | 'foreign'
  | 'invalid'
  | 'unreadable';

export interface ArchiveDestination {
  state: ArchiveDestinationState;
  path: string;
  /** For `foreign`: the id found on the disk, so the UI can name what it would
   *  be taking over before asking the user to confirm. */
  foundArchiveId: string | null;
  locationType: 'local' | 'network';
  network: ArchiveNetworkConfig;
  /** False on Linux/Docker, where a share cannot be mounted in process. The picker
   *  hides the network tab there rather than offering something that cannot work. */
  networkSupported: boolean;
  /** The archive is on the same disk as the library or the data folder. */
  sameDiskAsLibrary: boolean;
}

export interface ArchiveStatus {
  config: ArchiveConfig;
  destination: ArchiveDestination;
}

export const getArchiveStatus = () => fetchJSON<ArchiveStatus>('/storage/archive');

/** What can be saved. `network` is a patch of its own so a password can be sent
 *  without ever being read back. */
export type ArchiveConfigPatch = Partial<
  Omit<ArchiveConfig, 'network' | 'archiveId' | 'lastRunAt' | 'lastResult'>
> & { network?: ArchiveNetworkPatch };

/** Save configuration. Touches no disk: adopting is a separate, explicit call. */
export const saveArchiveConfig = (patch: ArchiveConfigPatch) =>
  fetchJSON<ArchiveStatus>('/storage/archive', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

/**
 * Try a share with credentials that are not saved yet.
 *
 * The server answers with a reason rather than a bare failure, so a wrong password,
 * an unreachable server and a missing share are distinguishable. An empty password
 * means "use the one already stored", which is what makes re-testing a share you
 * configured earlier possible without retyping it.
 */
export const testArchiveDestination = (network: ArchiveNetworkPatch) =>
  fetchJSON<{ ok: boolean; reason: string | null }>('/storage/archive/destination/test', {
    method: 'POST',
    body: JSON.stringify({ network }),
  });

/**
 * The folders inside a share, so the subpath can be chosen.
 *
 * A POST that only reads, because it may carry a share the user has typed but not
 * saved. Without `network` it browses the saved destination; with it, that share.
 * Omitting `path` lists the share root.
 */
export const browseArchiveDestination = (options: { network?: ArchiveNetworkPatch; path?: string } = {}) =>
  fetchJSON<{ path: string; root: string; directories: DirectoryEntry[] }>('/storage/archive/destination/browse', {
    method: 'POST',
    body: JSON.stringify(options),
  });

/**
 * Claim a disk as this install's archive.
 *
 * `confirmArchiveId` must be the id `getArchiveStatus` reported for a `foreign`
 * disk. The server refuses without it, so taking over an existing archive is
 * always a confirmed action rather than a side effect of saving a path.
 */
export const adoptArchiveDestination = (confirmArchiveId?: string, createFolder = false) =>
  fetchJSON<ArchiveStatus>('/storage/archive/adopt', {
    method: 'POST',
    body: JSON.stringify({ ...(confirmArchiveId ? { confirmArchiveId } : {}), createFolder }),
  });

export interface ArchiveRunProgress {
  running: boolean;
  phase: 'idle' | 'scanning' | 'copying' | 'done' | 'failed';
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  copied: number;
  skipped: number;
  warnings: string[];
}

export interface ArchiveRunResult {
  /** False for a refusal (`reason` says which): nothing was attempted. */
  ran: boolean;
  reason?: 'already-running' | 'no-destination' | 'destination-unusable' | 'insufficient-space';
  copied: number;
  skipped: number;
  /** Selected, but left behind because they have not reached `copyMinAgeDays` yet. */
  tooYoungSkipped: number;
  /** Files of linked folders, which the archive leaves out on purpose. */
  linkedSkipped: number;
  /** Stopped by the user before the end of the selection. */
  cancelled: boolean;
  bytesCopied: number;
  failures: Array<{ archiveRelPath: string; error: string }>;
  warnings: string[];
  localRemoved: number;
  retentionRemoved: number;
}

/** How the most recent run ended. Null on the status route until one has finished. */
export interface ArchiveLastRun {
  trigger: 'scheduled' | 'manual';
  finishedAt: string;
  result: ArchiveRunResult;
}

export interface ArchiveRetentionPlanSummary {
  mode: 'whole-object' | 'subframes-only';
  filesTotal: number;
  warnings: string[];
}

export const getArchiveRunStatus = () =>
  fetchJSON<{ progress: ArchiveRunProgress; running: boolean; lastRun: ArchiveLastRun | null }>('/storage/archive/run/status');

/** Start an archive run now, rather than waiting for the schedule. Answers as soon as
 *  the run has started; poll `getArchiveRunStatus` for progress and for `lastRun`. */
export const runArchiveNow = () => fetchJSON<{ started: boolean }>('/storage/archive/run', { method: 'POST' });

/** Stop the run in progress at the next file. What was copied so far is kept. */
export const cancelArchiveRun = () => fetchJSON<{ cancelling: boolean }>('/storage/archive/run/cancel', { method: 'POST' });

/** What retention would remove. Read-only: this is the dry run. */
export const getArchiveRetentionPlan = () =>
  fetchJSON<{ plan: ArchiveRetentionPlanSummary }>('/storage/archive/retention');

/** Prune the archive. Destructive, so the caller confirms before calling. */
export const applyArchiveRetention = () =>
  fetchJSON<{ removed: number; bytesRemoved: number; failures: string[]; plan: ArchiveRetentionPlanSummary }>(
    '/storage/archive/retention/apply',
    { method: 'POST' },
  );

export interface ArchivedObjectSummary {
  folderName: string;
  /** Null when the local library no longer has this object. */
  objectId: string | null;
  firstArchivedAt: string;
  lastArchivedAt: string;
  filesTotal: number;
  subframes: number;
  bytes: number;
  /** Files on the archive disk that are not in the library: the restorable ones. */
  missingLocally: number;
}

export interface ArchivedFileEntry {
  relPath: string;
  isSubframe: boolean;
  bytes: number;
  presentLocally: boolean;
}

export interface RestoreResult {
  ran: boolean;
  restored: number;
  skipped: number;
  bytesRestored: number;
  /** Files left alone because they differ locally and overwriting was not confirmed. */
  conflicts: string[];
  failures: string[];
}

export const getArchivedObjects = () =>
  fetchJSON<{ objects: ArchivedObjectSummary[]; warnings: string[] }>('/storage/archive/contents');

export const getArchivedFiles = (folderName: string) =>
  fetchJSON<{ files: ArchivedFileEntry[]; warnings: string[] }>(
    `/storage/archive/contents?folder=${encodeURIComponent(folderName)}`,
  );

/**
 * Write archived files back into the library.
 *
 * `overwrite` is the explicit confirmation that lets a restore replace local files
 * whose contents differ. Without it the server reports them as conflicts and leaves
 * them alone, which is why the first call is made without it and only the retry after
 * a confirmation sets it.
 */
export const restoreArchivedFiles = (items: Array<{ folderName: string; relPath: string }>, overwrite = false) =>
  fetchJSON<RestoreResult>('/storage/archive/restore', {
    method: 'POST',
    body: JSON.stringify({ items, overwrite }),
  });

// ─── Library reorganize (flat → per-session layout) ─────────────────────────

export interface RenestObjectResult {
  objectId: string;
  moved: number;
  skipped: number;
  alreadyNested: boolean;
  error?: string;
}

export interface RenestSummary {
  objects: number;
  moved: number;
  failed: number;
  results: RenestObjectResult[];
}

export interface RenestStatus {
  running: boolean;
  startedAt: string | null;
  objectsTotal: number;
  objectsDone: number;
  currentObject: string | null;
  summary: RenestSummary | null;
  error: string | null;
}

export const getRenestStatus = () =>
  fetchJSON<{ renest: RenestStatus; flatObjects: number }>('/storage/renest/status');

/** Omit objectId to reorganize the whole library. */
export const startRenest = (objectId?: string) =>
  fetchJSON<{ summary?: RenestSummary; result?: RenestObjectResult }>('/storage/renest', {
    method: 'POST',
    body: JSON.stringify(objectId ? { objectId } : {}),
  });

export interface SubframeUsage {
  files: number;
  bytes: number;
  objects: number;
  staleRecords: number;
  topObjects: Array<{ objectId: string; files: number; bytes: number }>;
}

export const getCleanupUsage = () =>
  fetchJSON<{ subframes: SubframeUsage }>('/storage/cleanup');

export const purgeAllSubframes = () =>
  fetchJSON<{ deleted: number; freedBytes: number; objects: number; staleRemoved: number; unreadable: number }>('/storage/cleanup/subframes', {
    method: 'DELETE',
  });

export interface LibraryAnalysis {
  staleRecords: { count: number; objects: number };
  missingObjects: Array<{ objectId: string; folderName: string; fileRecords: number }>;
  missingObjectCount: number;
  layoutDrift: number;
  duplicateFiles: { count: number; objects: number; bytes: number };
  flatObjects: number;
  missingProcessed: { count: number; objects: number };
  /** Paths that could not be checked. While non-zero, repairs refuse to run. */
  unreadable: number;
  ranAt: string;
}

export type RepairCategory = 'staleRecords' | 'missingObjects' | 'layoutDrift' | 'missingProcessed' | 'duplicateFiles';

export const analyzeLibrary = () => fetchJSON<LibraryAnalysis>('/storage/analyze');

export const repairLibrary = (category: RepairCategory) =>
  fetchJSON<{ category: RepairCategory } & Record<string, number>>('/storage/analyze/fix', {
    method: 'POST',
    body: JSON.stringify({ category }),
  });
