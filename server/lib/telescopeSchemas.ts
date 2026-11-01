// Request-body shapes for the telescope routes. They live here, not in the
// route file, so server/routes/openapi.ts can generate the published spec from
// the very schemas the handlers validate with. A field added here reaches the
// spec with no second edit (see tests/backend/openapiParity.test.ts).

import { z } from 'zod';
import { parseShareName, validateHostAddress } from './smb.shared.js';
import { TELESCOPE_KINDS } from './types/telescopeKind.js';
import { TRANSPORT_KINDS } from './telescopeTransports.js';
import { MAX_RIG_FILTERS, MAX_RIG_FILTER_LENGTH } from './telescopeRig.js';
import type { TelescopeProfile } from './telescopes.js';
import type { TelescopeTransport } from './telescopeTransports.js';
import type { TelescopeOpticalConfig } from './telescopeOpticalConfigs.js';

export const TelescopeKindSchema = z.enum(TELESCOPE_KINDS);

/**
 * Share fields are validated at the edge so a malformed value can never reach
 * the database. Test Connection alone was not enough: nothing stopped a user
 * from pasting a full smb:// URL and clicking Save without testing, leaving a
 * profile that could never connect.
 *
 * parseShareName carries the specific guidance (which half of a pasted URL
 * belongs in which field), so surface its message instead of a generic one.
 * Empty passes: FTP transports carry no share name at all.
 */
export const ShareNameSchema = z.string().optional().superRefine((val, ctx) => {
  if (val === undefined || val.trim() === '') return;
  try {
    parseShareName(val);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof Error ? err.message : 'Invalid share name',
    });
  }
});

/**
 * The mirror of ShareNameSchema for the address field, for the mirror-image
 * mistake: a host and share pasted together as "10.0.1.5/SeeStar/". That saved
 * without complaint and then failed every connection with a network error that
 * never mentioned the real problem.
 *
 * Empty passes for the same reason it does above: a local (USB) transport has
 * no address at all.
 */
export const HostnameSchema = z.string().optional().superRefine((val, ctx) => {
  if (val === undefined || val.trim() === '') return;
  try {
    validateHostAddress(val);
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: err instanceof Error ? err.message : 'Invalid hostname or IP address',
    });
  }
});

export const TelescopeProfileBodySchema = z.object({
  name: z.string().min(1).optional(),
  model: z.string().optional(),
  hostname: HostnameSchema,
  shareName: ShareNameSchema,
  username: z.string().optional(),
  password: z.string().optional(),
  kind: TelescopeKindSchema.optional(),
  color: z.string().optional(),
  archiveAllFiles: z.boolean().optional(),
  syncCalibrationFrames: z.boolean().optional(),
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
  pinnedTransportId: z.string().nullable().optional(),
  // Which telescopeOpticalConfigs row is "currently mounted", for the Framing
  // & Mosaic FOV preview — see src/lib/telescopeFov.ts's resolveFov. Only
  // meaningful for `other`/`asiair` kinds; validated to belong to this
  // profile in the PUT handler below.
  activeOpticalConfigId: z.string().nullable().optional(),
});

export const OpticalConfigBodySchema = z.object({
  name: z.string().min(1),
  focalLengthMm: z.number().positive(),
  sensorWidthMm: z.number().positive(),
  sensorHeightMm: z.number().positive(),
  pixelSizeUm: z.number().positive().nullable().optional(),
});

export const TestConnectionBodySchema = z.object({
  hostname: HostnameSchema,
  shareName: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  kind: TelescopeKindSchema.optional(),
  /** Which network transport to test. Omitted means SMB, which is what every
   *  client sent before FTP existed. 'local' is not testable here — a USB
   *  mount is verified by the drive picker instead. */
  connectionType: z.enum(TRANSPORT_KINDS).optional(),
  /** When testing an edit to an existing transport, the UI cannot resend the
   *  password (it only ever received the '••••••••' mask). Passing the profile
   *  and transport ids lets the test fall back to the stored, decrypted
   *  password so it exercises exactly what an import would use. Omitted for the
   *  brand-new / pre-save case, where the typed fields are all there is. */
  profileId: z.string().optional(),
  transportId: z.string().optional(),
});

export const ReassignBodySchema = z.object({
  toTelescopeId: z.string().min(1),
});

export const TransportKindSchema = z.enum(TRANSPORT_KINDS);

export const TransportBodySchema = z.object({
  kind: TransportKindSchema,
  priority: z.number().int().optional(),
  hostname: HostnameSchema,
  shareName: ShareNameSchema,
  username: z.string().optional(),
  password: z.string().optional(),
  localPath: z.string().optional(),
});

export const ProbeIdentityBodySchema = z.object({
  transport: TransportBodySchema,
  /** Used to seed `.nebulis.dat` if we end up creating it. The UI passes the
   *  user-selected model so the file is useful for forensics later. */
  model: z.string().optional(),
  /** When false the probe only reads: a telescope with identity tracking off must not get a file written to its storage. */
  trackDeviceIdentity: z.boolean().optional(),
});

export const RigBodySchema = z.object({
  sensorType: z.enum(['color', 'mono']).nullable(),
  filters: z.array(z.string().max(MAX_RIG_FILTER_LENGTH)).max(MAX_RIG_FILTERS),
});

// ─── Response shapes ─────────────────────────────────────────────────
// Only the published spec reads these. The route builds its objects from the
// lib types, so each schema below is held to its type in both directions: the
// `Missing` checks stop compiling when a field is added to the type and not
// here, and tests/backend/openapiParity.test.ts compares the keys of a live
// response with the published schema.

const nullableString = z.string().nullable();

export const TelescopeTransportResponseSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  kind: TransportKindSchema,
  priority: z.number().int().describe('Lower wins. 100 for SMB, 50 for local by default.'),
  hostname: z.string(),
  shareName: z.string(),
  username: z.string(),
  password: z.string().describe('Always masked in responses'),
  localPath: z.string(),
  lastSeenAt: z.number().nullable().describe('Unix ms of the last successful operation, or null'),
  createdAt: z.string(),
  decryptFailed: z.boolean().optional().describe('The stored password could not be decrypted; re-enter credentials'),
});

export const TelescopeOpticalConfigResponseSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  name: z.string(),
  focalLengthMm: z.number(),
  sensorWidthMm: z.number(),
  sensorHeightMm: z.number(),
  pixelSizeUm: z.number().nullable(),
  createdAt: z.string(),
});

export const TelescopeRigResponseSchema = z.object({
  sensorType: z.enum(['color', 'mono']).nullable(),
  filters: z.array(z.string()),
});

/** The profile as `POST` and `PUT /telescopes` return it. */
export const TelescopeProfileResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  hostname: z.string(),
  shareName: z.string(),
  username: z.string(),
  password: z.string().describe('Masked in responses'),
  createdAt: z.string(),
  kind: TelescopeKindSchema,
  color: z.string(),
  autoImportEnabled: z.boolean().describe('Whether the auto-import scheduler polls this telescope'),
  autoImportInterval: z.number().int().describe('Minutes between auto-imports for this telescope'),
  archivedAt: z.number().nullable().describe('Unix ms when the profile was archived, or null if active'),
  connectionType: TransportKindSchema.describe('"smb" = LAN share (SeeStar); "local" = direct filesystem path (USB mount); "ftp" = anonymous FTP over Wi-Fi (Dwarf)'),
  localPath: z.string().describe('Absolute path when connectionType is "local". Empty for SMB and FTP profiles.'),
  deviceId: nullableString.describe('Physical device UUID read from the device once connected; null until then'),
  importJpg: z.boolean(),
  importFits: z.boolean(),
  importThumbnails: z.boolean(),
  importSubFrames: z.boolean(),
  importVideos: z.boolean(),
  archiveAllFiles: z.boolean().describe("Keep files Nebulis has no use for, so this telescope's library folder is a complete copy of the device"),
  syncCalibrationFrames: z.boolean().describe('Copy the device calibration frames into the archive on every sync'),
  trackDeviceIdentity: z.boolean().describe('Read and write a device-identity marker so one telescope reached over two transports resolves to one device'),
  pinnedTransportId: nullableString.describe('Transport id to force, overriding the local > ftp > smb heuristic. Null means "Auto".'),
  activeOpticalConfigId: nullableString.describe('Currently mounted optical config. Null means "use the oldest config".'),
  pairing: z.looseObject({ status: z.string() }).nullable().optional().describe('USB drive pairing outcome. Present on create and update, null when no drive was involved.'),
});

/** The profile as `GET /telescopes` returns it, with the per-profile extras. */
export const TelescopeProfileListItemResponseSchema = TelescopeProfileResponseSchema.omit({ pairing: true }).extend({
  sessionCount: z.number().int(),
  transports: z.array(TelescopeTransportResponseSchema),
  activeTransportId: nullableString.describe('The transport the import pipeline would pick right now'),
  opticalConfigs: z.array(TelescopeOpticalConfigResponseSchema),
  rig: TelescopeRigResponseSchema,
  usedFilters: z.array(z.string()).describe('Filter names this telescope has actually been used with'),
  photoVersion: z.number().nullable().describe("Changes when the owner's picture of this telescope does. Fetch it from /telescopes/{id}/photo."),
});

type Missing<Type, Schema extends z.ZodType> = Exclude<keyof Type, keyof z.infer<Schema>>;
const profileFieldsDocumented: [Missing<TelescopeProfile, typeof TelescopeProfileResponseSchema>] extends [never] ? true : never = true;
const transportFieldsDocumented: [Missing<TelescopeTransport, typeof TelescopeTransportResponseSchema>] extends [never] ? true : never = true;
const opticalFieldsDocumented: [Missing<TelescopeOpticalConfig, typeof TelescopeOpticalConfigResponseSchema>] extends [never] ? true : never = true;
void [profileFieldsDocumented, transportFieldsDocumented, opticalFieldsDocumented];
