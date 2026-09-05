import type { TelescopeKind } from '../telescopePresets';
export type { TelescopeKind };
import { fetchJSON } from './client';

/** The string the API returns in place of a stored password. The UI shows it in
 *  the password field and sends it back unchanged when the user does not retype
 *  the password; the server reads it as "keep the stored value". */
export const MASKED_PASSWORD = '••••••••';

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
   *  beats FTP/SMB; mirrors the import pipeline's selectActiveTransport. */
  transportKind: ConnectionType;
}
export const getAllTelescopeStatus = () =>
  fetchJSON<TelescopeStatusEntry[]>('/telescopes/status/all');

// ─── Telescope profiles (multi-telescope support) ───────────────────────

/** SMB = LAN share (SeeStar). Local = filesystem path (USB mount).
 *  FTP = anonymous FTP over Wi-Fi, the only network interface a Dwarf has.
 *  Keep in sync with TRANSPORT_KINDS in server/lib/telescopeTransports.ts. */
export const CONNECTION_TYPES = ['smb', 'local', 'ftp'] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

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
  /** SMB share (SeeStar), FTP over Wi-Fi (Dwarf), or a local filesystem path
   *  (USB). Mirrors the active transport at creation time; the import pipeline
   *  reads transports for live truth. */
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
  /** Also keep files Nebulis has no use for, so this telescope's folder can be
   *  a complete copy of the device. Does not override the per-type toggles. */
  archiveAllFiles: boolean;
  /** When true (default), the importer reads/writes `.nebulis.dat` on the
   *  device's storage root so the same physical telescope reached over SMB
   *  and USB resolves to one logical device. Power users can disable it. */
  trackDeviceIdentity: boolean;
  /** transports[].id to force, overriding the automatic local > ftp > smb
   *  selection. Null means "Auto". */
  pinnedTransportId: string | null;
}

/** One way to reach a telescope. A profile can have several (e.g. one Seestar
 *  configured over both SMB and USB) — the import pipeline picks the active
 *  one at run time. */
export interface TelescopeTransport {
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
  looksLikeAsiair: boolean;
  /** Set when the ASIAIR tree sits under an `ASIAir/` folder rather than at the
   *  volume root, so a local transport can be pointed at the right directory. */
  asiairSubPath?: string;
  detectedDwarfModel?: 'dwarf-2' | 'dwarf-3' | 'dwarf-mini';
  alreadyKnownDeviceId: string | null;
  alreadyKnownProfileId: string | null;
  alreadyKnownProfileName: string | null;
}

interface DwarfMount {
  path: string;
  label: string;
  detectedModel?: DetectedDrive['detectedDwarfModel'];
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
    | 'deviceId' | 'transports' | 'activeTransportId' | 'pinnedTransportId'
    | 'importJpg' | 'importFits' | 'importThumbnails' | 'importSubFrames' | 'importVideos'
    | 'archiveAllFiles'
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
    archiveAllFiles?: boolean;
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

/** Probe a telescope's SMB share or FTP server with arbitrary credentials.
 *  Used by the Add/Edit modal to test before saving — does not read from the
 *  stored profile, so it works for both brand-new and unsaved-edit cases.
 *  `connectionType` defaults to 'smb' server-side when omitted. For FTP the
 *  response also carries the auto-detected storage root. */
export const testTelescopeConnection = (
  data: {
    kind: TelescopeKind;
    hostname: string;
    shareName: string;
    username: string;
    password: string;
    connectionType?: ConnectionType;
    /** When editing a saved transport, pass both ids so the server can fall
     *  back to the stored password if the field still holds the "••••••••"
     *  mask. Omit for the brand-new / pre-save case. */
    profileId?: string;
    transportId?: string;
  },
) =>
  fetchJSON<{ connected: boolean; objectCount?: number; error?: string; remoteRoot?: string }>(
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

/** Edit an existing transport row. Pass the masked password back unchanged to keep it. */
export const updateProfileTransport = (
  profileId: string,
  transportId: string,
  data: Partial<Omit<TelescopeTransport, 'id' | 'profileId' | 'lastSeenAt' | 'createdAt'>>,
) =>
  fetchJSON<TelescopeTransport>(
    `/telescopes/${encodeURIComponent(profileId)}/transports/${encodeURIComponent(transportId)}`,
    { method: 'PUT', body: JSON.stringify(data) },
  );

/** Remove a transport. The server refuses to delete a profile's last transport. */
export const deleteProfileTransport = (profileId: string, transportId: string) =>
  fetchJSON<{ deleted: boolean }>(
    `/telescopes/${encodeURIComponent(profileId)}/transports/${encodeURIComponent(transportId)}`,
    { method: 'DELETE' },
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
