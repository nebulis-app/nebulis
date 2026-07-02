import type { TelescopeKind } from '../telescopePresets';
export type { TelescopeKind };
import { fetchJSON } from './client';

interface TelescopeStatus {
  configured: boolean;
  hostname: string;
  online: boolean;
  latencyMs: number | null;
  checkedAt: string | null;
}
export const getTelescopeStatus = () => fetchJSON<TelescopeStatus>('/telescopes/status');

interface TelescopeStatusEntry {
  id: string;
  name: string;
  color: string;
  kind: TelescopeKind;
  hostname: string;
  configured: boolean;
  online: boolean;
  latencyMs: number | null;
  checkedAt: string | null;
  /** Which transport this probe is targeting right now. Local mount present
   *  beats SMB; mirrors the import pipeline's selectActiveTransport. */
  transportKind: 'smb' | 'local';
}
export const getAllTelescopeStatus = () =>
  fetchJSON<TelescopeStatusEntry[]>('/telescopes/status/all');

// ─── Telescope profiles (multi-telescope support) ───────────────────────

/** SMB = LAN share (SeeStar). Local = filesystem path (Dwarf USB mount). */
type ConnectionType = 'smb' | 'local';

export interface TelescopeProfile {
  id: string;
  name: string;
  model: string;
  hostname: string;
  shareName: string;
  username: string;
  password: string;          // masked as "••••••••" on responses
  createdAt: string;
  kind: TelescopeKind;
  color: string;             // hex, e.g. '#3b82f6'
  autoImportEnabled: boolean;
  autoImportInterval: number;
  archivedAt: number | null;
  sessionCount?: number;
  /** SMB share (SeeStar) or local filesystem path (Dwarf USB). Mirrors the
   *  active transport at creation time; the import pipeline reads transports
   *  for live truth. */
  connectionType: ConnectionType;
  /** Absolute filesystem path when connectionType === 'local'. */
  localPath: string;
  /** UUID identifying the physical device, read from `.nebulis.dat` on first
   *  successful connection. Null until paired. */
  deviceId: string | null;
  /** All transports for this profile (one profile, N transports). Populated
   *  by GET /telescopes. */
  transports: TelescopeTransport[];
  /** ID of the transport the import pipeline would use right now (local
   *  mount wins over SMB). Null when no transport is reachable. */
  activeTransportId: string | null;
  /** Per-telescope file-type filters. The import pipeline reads these (not
   *  the legacy global appSettings.import* fields) to decide what to pull
   *  off a given device. */
  importJpg: boolean;
  importFits: boolean;
  importThumbnails: boolean;
  importSubFrames: boolean;
  importVideos: boolean;
  /** When true (default), the importer reads/writes `.nebulis.dat` on the
   *  device's storage root so the same physical telescope reached over SMB
   *  and USB resolves to one logical device. Power users can disable it. */
  trackDeviceIdentity: boolean;
}

/** One way to reach a telescope. A profile can have several (e.g. one Seestar
 *  configured over both SMB and USB) — the import pipeline picks the active
 *  one at run time. */
interface TelescopeTransport {
  id: string;
  profileId: string;
  kind: ConnectionType;
  priority: number;
  hostname: string;
  shareName: string;
  username: string;
  password: string;          // masked as "••••••••" on responses
  localPath: string;
  lastSeenAt: number | null;
  createdAt: string;
}

export interface DetectedDrive {
  mountPath: string;
  volumeName: string;
  looksLikeSeestar: boolean;
  looksLikeDwarf: boolean;
  detectedDwarfModel?: 'dwarf-2' | 'dwarf-3' | 'dwarf-mini';
  alreadyKnownDeviceId: string | null;
  alreadyKnownProfileId: string | null;
  alreadyKnownProfileName: string | null;
}

interface DwarfMount {
  path: string;
  label: string;
  detectedModel?: 'dwarf-2' | 'dwarf-3';
}

/** Detected Dwarf USB volumes currently mounted on the server host. */
export const listDwarfMounts = () =>
  fetchJSON<{ mounts: DwarfMount[] }>('/telescopes/dwarf-mounts');

// connectionType and localPath are optional on create — server defaults them to
// 'smb' and '' respectively when omitted, which is what every SeeStar caller
// (OnboardingModal, legacy code) wants. deviceId and transports are
// server-controlled: deviceId is stamped from `.nebulis.dat` on first
// connect, transports is populated by the response. The per-telescope import
// toggles also fall back to server defaults (JPG + thumbnails on, others off)
// so callers can stay terse.
type TelescopeCreateInput =
  Omit<
    TelescopeProfile,
    | 'id' | 'createdAt' | 'archivedAt' | 'connectionType' | 'localPath'
    | 'deviceId' | 'transports' | 'activeTransportId'
    | 'importJpg' | 'importFits' | 'importThumbnails' | 'importSubFrames' | 'importVideos'
    | 'trackDeviceIdentity'
  >
  & {
    connectionType?: ConnectionType;
    localPath?: string;
    importJpg?: boolean;
    importFits?: boolean;
    importThumbnails?: boolean;
    importSubFrames?: boolean;
    importVideos?: boolean;
    trackDeviceIdentity?: boolean;
  };
interface TelescopeUpdateInput extends Partial<Omit<TelescopeProfile, 'id' | 'createdAt'>> {}

/** List all telescope profiles. Returned passwords are masked. */
export const listTelescopes = () =>
  fetchJSON<TelescopeProfile[]>('/telescopes');

/** Create a new telescope profile. `archivedAt` is server-controlled and
 *  always starts NULL — callers don't supply it. */
export const createTelescope = (
  data: TelescopeCreateInput,
) =>
  fetchJSON<TelescopeProfile>('/telescopes', {
    method: 'POST',
    body: JSON.stringify(data),
  });

/** Update an existing profile. Pass the masked password back unchanged to keep it. */
export const updateTelescope = (
  id: string,
  data: TelescopeUpdateInput,
) =>
  fetchJSON<TelescopeProfile>(`/telescopes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

export const deleteTelescope = (id: string) =>
  fetchJSON<{ deleted: boolean }>(`/telescopes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

/** Mark a profile as archived. Server refuses to archive the last active one. */
export const archiveTelescope = (id: string) =>
  fetchJSON<{ archived: boolean }>(`/telescopes/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
  });

/** Restore an archived profile. */
export const unarchiveTelescope = (id: string) =>
  fetchJSON<{ unarchived: boolean }>(`/telescopes/${encodeURIComponent(id)}/unarchive`, {
    method: 'POST',
  });

/** Move every session from this telescope onto another. Used when replacing
 *  hardware so historical observations re-sync against the new scope. */
export const reassignTelescopeSessions = (fromId: string, toTelescopeId: string) =>
  fetchJSON<{ sessionsUpdated: number; objectsUpdated: number }>(
    `/telescopes/${encodeURIComponent(fromId)}/reassign-all`,
    { method: 'POST', body: JSON.stringify({ toTelescopeId }) },
  );

/** Probe a telescope's SMB share with arbitrary credentials. Used by the
 *  Add/Edit modal to test before saving — does not read from the stored
 *  profile, so it works for both brand-new and unsaved-edit cases. */
export const testTelescopeConnection = (
  data: { kind: TelescopeKind; hostname: string; shareName: string; username: string; password: string },
) =>
  fetchJSON<{ connected: boolean; objectCount?: number; error?: string }>(
    '/telescopes/test-connection',
    { method: 'POST', body: JSON.stringify(data) },
  );

/** Detected mounted drives (Seestar or Dwarf), each annotated with whether
 *  the volume is already paired to a known profile. */
export const listDetectedDrives = () =>
  fetchJSON<{ drives: DetectedDrive[] }>('/telescopes/drives');

interface ProbeIdentityInput {
  transport: {
    kind: ConnectionType;
    hostname?: string;
    shareName?: string;
    username?: string;
    password?: string;
    localPath?: string;
  };
  model?: string;
}

interface ProbeIdentityResult {
  deviceId: string;
  alreadyKnownProfileId: string | null;
  alreadyKnownProfileName: string | null;
  wrote: boolean;
  readonly: boolean;
}

/** Probe a candidate transport for `.nebulis.dat`. Used by the AddTelescope
 *  flow to detect "this device is already paired" before profile creation. */
export const probeTransportIdentity = (data: ProbeIdentityInput) =>
  fetchJSON<ProbeIdentityResult>('/telescopes/probe-identity', {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const addProfileTransport = (
  profileId: string,
  data: Partial<Omit<TelescopeTransport, 'id' | 'profileId' | 'lastSeenAt' | 'createdAt'>>,
) =>
  fetchJSON<TelescopeTransport>(
    `/telescopes/${encodeURIComponent(profileId)}/transports`,
    { method: 'POST', body: JSON.stringify(data) },
  );

/** Reassign a session (objectId + date) to a different telescope. */
export const reassignSessionTelescope = (
  objectId: string,
  date: string,
  telescopeId: string,
) =>
  fetchJSON<{ updated: boolean; telescopeId: string }>(
    `/library/objects/${encodeURIComponent(objectId)}/sessions/${encodeURIComponent(date)}/telescope`,
    { method: 'PUT', body: JSON.stringify({ telescopeId }) },
  );
