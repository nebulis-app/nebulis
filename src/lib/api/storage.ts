import { fetchJSON } from './client';

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

export const testNetworkLibraryConnection = (network: NetworkLibraryConfig) =>
  fetchJSON<{ ok: boolean; reason?: string }>('/storage/library-location/network/test', {
    method: 'POST',
    body: JSON.stringify(network),
  });

