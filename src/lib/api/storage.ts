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
