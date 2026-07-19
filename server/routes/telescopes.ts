import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import fs from 'fs/promises';
import type { TelescopeProfile } from '../lib/telescopes.js';
import {
  getAllProfiles,
  getProfileById,
  createProfile,
  updateProfile,
  deleteProfile,
  archiveProfile,
  unarchiveProfile,
  bulkReassignTelescope,
  getProfileByDeviceId,
} from '../lib/telescopes.js';
import db from '../lib/db.js';
import { smbListDir } from '../lib/smb.js';
import { tcpProbe, getSmbOpHealth } from '../lib/smbReachability.js';
import { getWalkerConfig, isDwarfKind } from '../lib/walkers/index.js';
import { log } from '../lib/logger.js';
import { isObjectFolder } from '../lib/telescopeFiles.js';
import type { TelescopeKind } from '../lib/telescopes.js';
import { TELESCOPE_KINDS } from '../lib/types/telescopeKind.js';
import { detectDwarfMounts } from '../lib/dwarfMounts.js';
import { detectDrives } from '../lib/driveEnumeration.js';
import {
  getTransportsForProfile,
  getTransportById,
  addTransport,
  updateTransport,
  deleteTransport,
  selectActiveTransport,
  TRANSPORT_KINDS,
  type TelescopeTransport,
  type TransportKind,
} from '../lib/telescopeTransports.js';
import { readIdentity, writeIdentityIfMissing } from '../lib/deviceIdentity.js';

const router = Router();

const TelescopeKindSchema = z.enum(TELESCOPE_KINDS);

const TelescopeProfileBodySchema = z.object({
  name: z.string().min(1).optional(),
  model: z.string().optional(),
  hostname: z.string().optional(),
  shareName: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  kind: TelescopeKindSchema.optional(),
  color: z.string().optional(),
  autoImportEnabled: z.boolean().optional(),
  autoImportInterval: z.number().int().min(0).optional(),
  connectionType: z.enum(TRANSPORT_KINDS).optional(),
  localPath: z.string().optional(),
  importJpg: z.boolean().optional(),
  importFits: z.boolean().optional(),
  importThumbnails: z.boolean().optional(),
  importSubFrames: z.boolean().optional(),
  importVideos: z.boolean().optional(),
  trackDeviceIdentity: z.boolean().optional(),
});

const TestConnectionBodySchema = z.object({
  hostname: z.string().optional(),
  shareName: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  kind: TelescopeKindSchema.optional(),
});

const ReassignBodySchema = z.object({
  toTelescopeId: z.string().min(1),
});

const TransportKindSchema = z.enum(TRANSPORT_KINDS);

const TransportBodySchema = z.object({
  kind: TransportKindSchema,
  priority: z.number().int().optional(),
  hostname: z.string().optional(),
  shareName: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  localPath: z.string().optional(),
});

const ProbeIdentityBodySchema = z.object({
  transport: TransportBodySchema,
  /** Used to seed `.nebulis.dat` if we end up creating it. The UI passes the
   *  user-selected model so the file is useful for forensics later. */
  model: z.string().optional(),
});

/** Mask passwords in transport responses; keep the encrypted-on-disk shape
 *  out of the API surface. The presence of a password is signalled via the
 *  same '••••••••' sentinel used for profiles. */
function presentTransport(t: TelescopeTransport): Omit<TelescopeTransport, 'password'> & { password: string } {
  return { ...t, password: t.password ? '••••••••' : '' };
}

// Cached query — `librarySessions.telescopeId` was added in Phase 1.
const sessionCountStmt = db.prepare<[], { telescopeId: string; n: number }>(
  `SELECT telescopeId, COUNT(*) as n FROM librarySessions
     WHERE telescopeId IS NOT NULL GROUP BY telescopeId`,
);

function sessionCountsByTelescope(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of sessionCountStmt.all()) counts.set(row.telescopeId, row.n);
  return counts;
}

// Enumerate Dwarf USB volumes currently mounted on the server host.
// Used by the AddTelescopeModal when the user picks a Dwarf telescope kind:
// the UI shows the detected mounts as a dropdown so they don't have to type
// the path manually. Empty array is a legitimate response — it means no Dwarf
// is plugged in right now (or the user is on a server they don't physically
// own, e.g. cloud-hosted Nebulis with no USB attached).
router.get('/dwarf-mounts', async (_req: Request, res: Response) => {
  const mounts = await detectDwarfMounts();
  res.apiSuccess({ mounts });
});

// List all telescope profiles, each with the inline transports[] needed to
// render the per-profile transports list in HardwareSection.
router.get('/', (_req: Request, res: Response) => {
  const counts = sessionCountsByTelescope();
  const profiles = getAllProfiles().map(p => ({
    ...p,
    password: p.password ? '••••••••' : '',
    sessionCount: counts.get(p.id) ?? 0,
    transports: getTransportsForProfile(p.id).map(presentTransport),
    // Server-side resolution of which transport the import pipeline would
    // pick right now. Lets the UI highlight the active pill without
    // reimplementing the mount-presence check client-side.
    activeTransportId: selectActiveTransport(p.id)?.id ?? null,
  }));
  res.apiSuccess(profiles);
});

// Enumerate connected drives (any platform). The UI hits this from the
// AddTelescope scan flow; each entry tells the caller whether the volume
// looks like a Seestar or Dwarf and whether it's already paired to an
// existing profile (so we can show an "Already added as <name>" pill).
router.get('/drives', async (_req: Request, res: Response) => {
  const drives = await detectDrives();
  res.apiSuccess({ drives });
});

// Probe a candidate transport for `.nebulis.dat`. Used by the add-telescope
// flow before profile creation: if the device already has a deviceId and a
// matching profile exists, the UI offers to attach this transport to that
// profile instead of creating a duplicate. When no identity is present and
// the transport is writable, the call seeds a fresh `.nebulis.dat`.
router.post('/probe-identity', requireAdmin, async (req: Request, res: Response) => {
  const parsed = ProbeIdentityBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const t = parsed.data.transport;
  // Build a transport-shaped object the deviceIdentity module can use. We
  // don't persist this; it's transient state for the probe.
  const probe: TelescopeTransport = {
    id: 'probe',
    profileId: 'probe',
    kind: t.kind,
    priority: t.priority ?? (t.kind === 'local' ? 50 : 100),
    hostname: t.hostname ?? '',
    shareName: t.shareName ?? 'EMMC Images',
    username: t.username ?? 'guest',
    password: t.password ?? '',
    localPath: t.localPath ?? '',
    lastSeenAt: null,
    createdAt: new Date().toISOString(),
  };
  try {
    const existing = await readIdentity(probe);
    if (existing) {
      const owner = getProfileByDeviceId(existing.deviceId);
      res.apiSuccess({
        deviceId: existing.deviceId,
        alreadyKnownProfileId: owner?.id ?? null,
        alreadyKnownProfileName: owner?.name ?? null,
        wrote: false,
        readonly: false,
      });
      return;
    }
    const result = await writeIdentityIfMissing(probe, { model: parsed.data.model ?? 'unknown' });
    res.apiSuccess({
      deviceId: result.identity.deviceId,
      alreadyKnownProfileId: null,
      alreadyKnownProfileName: null,
      wrote: result.wrote,
      readonly: result.readonly,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Probe failed';
    res.apiError(502, 'PROBE_FAILED', message);
  }
});

// List transports for a profile.
router.get('/:id/transports', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!getProfileById(id)) {
    res.apiError(404, 'NOT_FOUND', 'Telescope profile not found');
    return;
  }
  res.apiSuccess(getTransportsForProfile(id).map(presentTransport));
});

// Add a transport to a profile.
router.post('/:id/transports', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const profile = getProfileById(id);
  if (!profile) {
    res.apiError(404, 'NOT_FOUND', 'Telescope profile not found');
    return;
  }
  const parsed = TransportBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  if (isDwarfKind(profile.kind) && parsed.data.kind === 'smb') {
    res.apiError(422, 'VALIDATION_ERROR', 'Dwarf telescopes use USB storage, not network (SMB) connections.');
    return;
  }
  const transport = addTransport(id, parsed.data);
  res.apiSuccess(presentTransport(transport));
});

// Update a transport in place.
router.put('/:id/transports/:tid', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const tid = String(req.params.tid);
  const profile = getProfileById(id);
  const existing = getTransportById(tid);
  if (!existing || existing.profileId !== id) {
    res.apiError(404, 'NOT_FOUND', 'Transport not found');
    return;
  }
  const parsed = TransportBodySchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  if (profile && isDwarfKind(profile.kind) && parsed.data.kind === 'smb') {
    res.apiError(422, 'VALIDATION_ERROR', 'Dwarf telescopes use USB storage, not network (SMB) connections.');
    return;
  }
  const updates = { ...parsed.data };
  // Mirror the profile's password-masking convention: the UI sends back
  // '••••••••' for unchanged passwords. Drop those so we don't encrypt the
  // sentinel string into the row.
  if (updates.password === '••••••••') delete updates.password;
  const updated = updateTransport(tid, updates);
  if (!updated) {
    res.apiError(404, 'NOT_FOUND', 'Transport not found');
    return;
  }
  res.apiSuccess(presentTransport(updated));
});

// Remove a transport from a profile. Refuses to delete the last remaining
// transport — every profile must have somewhere the import pipeline can reach.
router.delete('/:id/transports/:tid', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const tid = String(req.params.tid);
  const transports = getTransportsForProfile(id);
  if (!transports.some(t => t.id === tid)) {
    res.apiError(404, 'NOT_FOUND', 'Transport not found');
    return;
  }
  if (transports.length <= 1) {
    res.apiError(400, 'LAST_TRANSPORT',
      'Cannot delete the last transport on a telescope. Add another first, or archive the telescope.');
    return;
  }
  deleteTransport(tid);
  res.apiSuccess({ deleted: true });
});

// Create new telescope profile
router.post('/', requireAdmin, (req: Request, res: Response) => {
  const parsed = TelescopeProfileBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const profile = createProfile(parsed.data);
  res.apiSuccess({ ...profile, password: profile.password ? '••••••••' : '' });
});

// Update a telescope profile
router.put('/:id', requireAdmin, (req: Request, res: Response) => {
  const parsed = TelescopeProfileBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const updates = { ...parsed.data };
  if (updates.password === '••••••••') delete updates.password;
  const updated = updateProfile(String(req.params.id), updates);
  if (updated) {
    res.apiSuccess({ ...updated, password: updated.password ? '••••••••' : '' });
  } else {
    res.apiError(404, 'NOT_FOUND', 'Telescope profile not found');
  }
});

// Delete a telescope profile
router.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const profile = getProfileById(id);
  const deleted = deleteProfile(id);
  if (deleted) {
    res.apiSuccess({ deleted: true });
  } else {
    res.apiError(400, 'DELETE_FAILED', 'Cannot delete the only telescope profile');
  }
});

// Archive a telescope profile — keeps it for historical session attribution
// but excludes it from auto-import and active pickers. Idempotent on already-
// archived profiles, refused when this is the last unarchived profile.
router.post('/:id/archive', requireAdmin, (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  const result = archiveProfile(id);
  if (result === 'not_found') {
    res.apiError(404, 'NOT_FOUND', 'Telescope profile not found');
    return;
  }
  res.apiSuccess({ archived: true });
});

// Unarchive — restore an archived profile to active status. Idempotent.
router.post('/:id/unarchive', requireAdmin, (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  const ok = unarchiveProfile(id);
  if (!ok) {
    res.apiError(404, 'NOT_FOUND', 'Telescope profile not found');
    return;
  }
  res.apiSuccess({ unarchived: true });
});

// Bulk reassign every session from this telescope to another. Used when
// replacing hardware so historical observations re-sync against the new
// scope. Same-id is a 400. Target must exist.
router.post('/:id/reassign-all', requireAdmin, (req: Request, res: Response) => {
  const parsed = ReassignBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const fromId = typeof req.params.id === 'string' ? req.params.id : '';
  const { toTelescopeId: toId } = parsed.data;
  if (fromId === toId) {
    res.apiError(400, 'SAME_TARGET', 'Source and destination telescopes must differ');
    return;
  }
  if (!getProfileById(fromId)) {
    res.apiError(404, 'SOURCE_NOT_FOUND', 'Source telescope not found');
    return;
  }
  if (!getProfileById(toId)) {
    res.apiError(404, 'TARGET_NOT_FOUND', 'Target telescope not found');
    return;
  }
  const result = bulkReassignTelescope(fromId, toId);
  res.apiSuccess(result);
});

// ─── Online status ───────────────────────────────────────────────────

interface StatusCache {
  online: boolean;
  latencyMs: number | null;
  checkedAt: number;
  consecutiveFailures: number;
}

// Per-hostname cache so probes for different telescopes don't trample each
// other (the old single-slot cache reset whenever the active scope changed).
const statusCacheByHost = new Map<string, StatusCache>();
const STATUS_TTL        = 30_000; // re-probe interval when healthy
const FAILURE_RETRY_MS  =  5_000; // re-probe sooner after a failure
const OFFLINE_THRESHOLD =      3; // consecutive failures before flipping offline

function applyHysteresis(succeeded: boolean, latencyMs: number | null, cached: StatusCache | undefined): StatusCache {
  const prevFailures = cached?.consecutiveFailures ?? 0;
  const consecutiveFailures = succeeded ? 0 : prevFailures + 1;
  // Stay online until we've seen OFFLINE_THRESHOLD consecutive failures.
  // A scope that has never been seen online goes offline immediately on failure.
  const wasOnline = cached?.online ?? false;
  const online = succeeded || (wasOnline && consecutiveFailures < OFFLINE_THRESHOLD);
  return { online, latencyMs, checkedAt: Date.now(), consecutiveFailures };
}

// How long a recorded real-op failure keeps overriding a TCP-reachable host.
// Long enough that a host that answers on 445 but can't actually serve its
// share stays flagged, short enough that it recovers once a real op succeeds
// (which overwrites the health) or the failure ages out.
const OP_HEALTH_FRESH_MS = 5 * 60_000;

/** Fold the last real-SMB-op outcome into a TCP-derived status. TCP-445 only
 *  proves the host answers; if the most recent real op against it failed
 *  recently, the share isn't actually usable, so it should not read as online.
 *  Never upgrades an offline TCP result — only downgrades a would-be-online one. */
function foldSmbOpHealth(status: StatusCache, hostname: string): StatusCache {
  if (!status.online) return status;
  const health = getSmbOpHealth(hostname);
  if (!health || health.ok) return status;
  if (Date.now() - health.checkedAt > OP_HEALTH_FRESH_MS) return status;
  return { ...status, online: false };
}

async function probeWithCache(hostname: string): Promise<StatusCache> {
  const cached = statusCacheByHost.get(hostname);
  const ttl = cached && cached.consecutiveFailures > 0 ? FAILURE_RETRY_MS : STATUS_TTL;
  if (cached && Date.now() - cached.checkedAt < ttl) return foldSmbOpHealth(cached, hostname);
  const latencyMs = await tcpProbe(hostname);
  const fresh = applyHysteresis(latencyMs !== null, latencyMs, cached);
  statusCacheByHost.set(hostname, fresh);
  return foldSmbOpHealth(fresh, hostname);
}

/**
 * "Is this USB drive currently mounted?" probe for connectionType=local
 * telescopes (Dwarf USB). A successful `fs.stat` on the configured `localPath`
 * means the volume is plugged in and readable. Latency is the stat duration —
 * not as meaningful as a TCP RTT, but useful as a signal that the disk is
 * responsive vs spinning up.
 */
async function probeLocalPath(localPath: string): Promise<StatusCache> {
  const cacheKey = `local:${localPath}`;
  const cached = statusCacheByHost.get(cacheKey);
  const ttl = cached && cached.consecutiveFailures > 0 ? FAILURE_RETRY_MS : STATUS_TTL;
  if (cached && Date.now() - cached.checkedAt < ttl) return cached;
  const start = Date.now();
  let succeeded = false;
  let latencyMs: number | null = null;
  try {
    const st = await fs.stat(localPath);
    succeeded = st.isDirectory();
    if (succeeded) latencyMs = Date.now() - start;
  } catch {
    succeeded = false;
  }
  const fresh = applyHysteresis(succeeded, latencyMs, cached);
  statusCacheByHost.set(cacheKey, fresh);
  return fresh;
}

/** Probe a profile using whichever transport it's configured for. */
async function probeProfile(profile: TelescopeProfile): Promise<StatusCache> {
  if (profile.connectionType === 'local') {
    const localPath = profile.localPath?.trim();
    if (!localPath) {
      return { online: false, latencyMs: null, checkedAt: Date.now(), consecutiveFailures: 0 };
    }
    return probeLocalPath(localPath);
  }
  const hostname = profile.hostname?.trim();
  if (!hostname) {
    return { online: false, latencyMs: null, checkedAt: Date.now(), consecutiveFailures: 0 };
  }
  return probeWithCache(hostname);
}

// GET /api/v1/telescopes/status — any-telescope summary used by legacy callers
// (StorageDashboard, ObservationDetail). Returns online:true if any ACTIVE
// (non-archived) scope is reachable. Archived profiles are skipped to match
// /status/all behaviour.
router.get('/status', async (_req: Request, res: Response) => {
  const profiles = getAllProfiles().filter(p => p.archivedAt === null);
  if (profiles.length === 0) {
    res.apiSuccess({ configured: false, hostname: '', online: false, latencyMs: null, checkedAt: null });
    return;
  }
  // Probe every configured profile via its own transport (SMB hostname or
  // local-fs path). A USB-only Dwarf has no hostname but is still online
  // when its mount point is present — the old code returned offline for it.
  const configurable = profiles.filter(p =>
    p.connectionType === 'local' ? p.localPath?.trim() : p.hostname?.trim(),
  );
  const probes = await Promise.all(configurable.map(probeProfile));
  const anyOnline = probes.some(s => s.online);
  const best = probes.find(s => s.online) ?? probes[0];
  res.apiSuccess({
    configured: configurable.length > 0,
    hostname: profiles[0]?.hostname?.trim() || '',
    online: anyOnline,
    latencyMs: best?.latencyMs ?? null,
    checkedAt: best ? new Date(best.checkedAt).toISOString() : null,
  });
});

// GET /api/v1/telescopes/status/all — every ACTIVE telescope, probed in parallel.
// Archived profiles are excluded so the header status pill ("1/3 online") only
// counts scopes the user actually expects to see online. To list archived ones
// the settings page hits GET /telescopes which doesn't filter.
router.get('/status/all', async (_req: Request, res: Response) => {
  const profiles = getAllProfiles().filter(p => p.archivedAt === null);
  const probes = await Promise.all(profiles.map(async p => {
    // Under multi-transport, probe whichever transport the import pipeline
    // would actually use. selectActiveTransport returns the USB transport
    // when the mount is present, else the configured SMB one. When that
    // returns null, fall back to the legacy mirror columns so older clients
    // and untransported profiles still report sensibly.
    const active = selectActiveTransport(p.id);
    const transportKind: TransportKind = active?.kind ?? p.connectionType;
    const hostname = active?.hostname?.trim() ?? p.hostname?.trim() ?? '';
    const localPath = active?.localPath?.trim() ?? p.localPath?.trim() ?? '';
    const configured = transportKind === 'local' ? !!localPath : !!hostname;
    if (!configured) {
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        kind: p.kind,
        hostname,
        configured: false,
        online: false,
        latencyMs: null,
        checkedAt: null as string | null,
        transportKind,
      };
    }
    const status = await probeProfile({
      ...p,
      connectionType: transportKind,
      hostname,
      localPath,
    });
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      kind: p.kind,
      hostname: hostname || localPath,
      configured: true,
      online: status.online,
      latencyMs: status.latencyMs,
      checkedAt: new Date(status.checkedAt).toISOString(),
      transportKind,
    };
  }));
  res.apiSuccess(probes);
});

// Test an arbitrary connection — used by the Add/Edit modal so the user can
// verify credentials *before* saving. Takes connection params directly rather
// than reading from the active/stored profile, so it works equally well for
// brand-new profiles and for unsaved edits to existing ones.
router.post('/test-connection', requireAdmin, async (req: Request, res: Response) => {
  const parsed = TestConnectionBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.apiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const hostname = parsed.data.hostname?.trim() ?? '';
  const shareName = parsed.data.shareName?.trim() ?? '';
  const username = parsed.data.username?.trim() ?? '';
  const password = parsed.data.password ?? '';
  const kind: TelescopeKind = parsed.data.kind ?? 'other';

  if (!hostname) {
    res.apiSuccess({ connected: false, error: 'Hostname is required' });
    return;
  }
  if (!shareName) {
    res.apiSuccess({ connected: false, error: 'Share name is required' });
    return;
  }

  const walker = getWalkerConfig(kind);
  log.info({ hostname, shareName, username: username || 'guest', kind }, '[smb] test-connection attempt');
  try {
    const entries = await smbListDir(walker.basePath, {
      hostname, shareName, username: username || 'guest', password,
    });
    const objectCount = entries.filter(e => e.type === 'dir' && isObjectFolder(e.name)).length;
    log.info({ hostname, shareName, objectCount }, '[smb] test-connection ok');
    res.apiSuccess({ connected: true, objectCount });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    log.warn({ hostname, shareName, error: message }, '[smb] test-connection failed: %s', message);
    res.apiSuccess({ connected: false, error: message });
  }
});

export { router as telescopesRouter };
