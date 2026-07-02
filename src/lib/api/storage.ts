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

interface SystemStorage {
  disk: {
    total: number; used: number; free: number;
    usedPercent: number;
    totalFormatted: string; usedFormatted: string; freeFormatted: string;
  } | null;
  dataDir: {
    path: string;
    size: number;
    files: number;
    sizeFormatted: string;
    breakdown: Array<{ name: string; size: number; files: number; sizeFormatted: string }>;
  };
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

interface LibraryLocation {
  path: string;
  isDefault: boolean;
  available: boolean;
  libraryId: string;
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

