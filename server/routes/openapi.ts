import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  ItemCreateSchema, ItemPatchSchema, KitSchema, KitPatchSchema, CheckSchema,
  GearItemResponseSchema, GearKitResponseSchema,
} from '../lib/gearSchemas.js';
import {
  EntryCreateSchema, EntryPatchSchema,
  JournalEntryResponseSchema, JournalAttachmentResponseSchema,
} from '../lib/journalSchemas.js';
import { ImportBodySchema } from '../lib/library/importSchemas.js';
import { geometryEditSchema } from '../lib/annotate/geometryEditSchema.js';
import { imageEditRequestSchema } from '../lib/library/imageEditSchema.js';
import { UPDATE_CHANNELS } from '../lib/appUpdate/manifest.js';
import {
  GALLERY_IMAGE_SOURCES,
  PREFERRED_CATALOGS,
  OBJECT_PAGE_LAYOUTS,
  TEMPERATURE_UNITS,
  WIND_SPEED_UNITS,
} from '../lib/types/appSettings.js';
import { WISHLIST_PRIORITIES } from '../lib/wishlist.js';
import { FILE_CATEGORIES } from '../lib/telescopeFiles.js';
import { CATALOG_TIERS, CREDIT_SOURCES } from '../lib/catalogPack/manifest.js';
import { SYSTEM_LOG_CATEGORIES, SYSTEM_LOG_LEVELS } from '../lib/systemLog.js';
import { SKY_MAP_AZ_SLICES, SKY_MAP_BANDS, SKY_MAP_CELLS } from '../lib/skyMapConfig.js';
import {
  TelescopeProfileBodySchema,
  TransportBodySchema,
  OpticalConfigBodySchema,
  RigBodySchema,
  ReassignBodySchema,
  TestConnectionBodySchema,
  ProbeIdentityBodySchema,
  TelescopeProfileResponseSchema,
  TelescopeProfileListItemResponseSchema,
  TelescopeTransportResponseSchema,
  TelescopeOpticalConfigResponseSchema,
  TelescopeRigResponseSchema,
} from '../lib/telescopeSchemas.js';
import {
  AlertChannelBodySchema,
  AlertChannelPatchSchema,
  AlertChannelSchema,
  AlertChannelTestResultSchema,
  AlertClearNightCheckSchema,
  AlertClearNightDataSchema,
  AlertConfigBodySchema,
  AlertConfigSchema,
  AlertDeletedSchema,
  AlertDeliveryResultSchema,
  AlertDetailsSchema,
  AlertDevicePatchSchema,
  AlertDeviceRegistrationSchema,
  AlertDeviceSchema,
  AlertDeviceTestResultSchema,
  AlertDewForecastSchema,
  AlertDewPhonesResultSchema,
  AlertNextClearNightCheckSchema,
  AlertOverviewSchema,
  AlertPhoneFailureSchema,
  AlertPhonesResultSchema,
  AlertPushInfoSchema,
  AlertTonightPlanSchema,
} from '../lib/alerts/schemas.js';
import {
  ActiveSiteBodySchema,
  BortleLookupSchema,
  ObservingSiteSchema,
  SiteBodySchema,
  SiteDeletedSchema,
  SiteDeletedWithIdSchema,
  SitePhotoCaptionBodySchema,
  SitePhotoSchema,
  SiteUpdateSchema,
} from '../lib/observingSiteSchemas.js';
import {
  AuthCreateUserBodySchema,
  AuthLoginBodySchema,
  AuthPasswordBodySchema,
  AuthProfileBodySchema,
  AuthRegisterBodySchema,
  AuthRoleBodySchema,
  AuthStatusSchema,
  AuthTokenSchema,
  AuthUpdatedSchema,
  AuthUserSchema,
} from '../lib/authSchemas.js';
import {
  SettingsApiKeyCreateBodySchema,
  SettingsApiKeyCreatedSchema,
  SettingsApiKeyOwnerSchema,
  SettingsApiKeyRevokedSchema,
  SettingsApiKeySummarySchema,
  SettingsDebugLogStateSchema,
  SettingsDebugLogStatusSchema,
  SettingsNightlyStartedSchema,
  SettingsResetDatabaseBodySchema,
  SettingsResetResultSchema,
} from '../lib/settingsSchemas.js';
import {
  NoteBodySchema,
  NoteUpdateBodySchema,
  ObjectNoteBodySchema,
  ObjectNoteSchema,
  ObservationNoteSchema,
} from '../lib/noteSchemas.js';
import {
  LastSeenVersionBodySchema,
  WatermarkPresetsBodySchema,
  WatermarkPresetSchema,
} from '../lib/userPreferences.js';

const router = Router();

// ─── Shared schema fragments ─────────────────────────────────────────

const nullable = (schema: Record<string, unknown>) => ({ ...schema, nullable: true });
const strEx    = (example: string) => ({ type: 'string', example });
const isoDate  = { type: 'string', format: 'date-time', example: '2024-01-15T22:30:00.000Z' };
const isoDateD = { type: 'string', format: 'date', example: '2024-01-15' };

// Request and response schemas for routes that validate with Zod are generated
// from those schemas, never retyped here. A field added to a schema reaches the
// published spec with no second edit.
const jsonSchemaOf = (schema: z.ZodType, io: 'input' | 'output' = 'output') => {
  const generated: Record<string, unknown> = { ...z.toJSONSchema(schema, { io, unrepresentable: 'any' }) };
  delete generated.$schema;
  return generated;
};
const jsonBody = (schemaName: string, required = true) => ({
  required,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});
const jsonResponse = (description: string, schemaName: string, isArray = false) => ({
  description,
  content: {
    'application/json': {
      schema: isArray
        ? { type: 'array', items: { $ref: `#/components/schemas/${schemaName}` } }
        : { $ref: `#/components/schemas/${schemaName}` },
    },
  },
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const subIdParam = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const deleted = { description: 'Deletion confirmed' };
const notFound = { description: 'Telescope profile not found' };

export const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Nebulis API',
    version: '1.1.0',
    description: [
      'REST API for the Nebulis dashboard: browse and manage astronomical images',
      'from ZWO SeeStar smart telescopes, plan observing sessions, and manage your',
      'target wishlist.',
      '',
      '**Base URL:** `/api/v1`',
      '',
      '**Authentication:** All endpoints are open when no API key is configured.',
      'Set an API key in Settings and then pass it as `X-API-Key: <key>` or',
      '`Authorization: Bearer <key>` on every request.',
      '',
      '**Response envelope:** Every response is wrapped in:',
      '```json',
      '{ "ok": true, "data": <payload>, "meta": { ... } }',
      '```',
      'Errors return `{ "ok": false, "error": { "code": "...", "message": "..." } }`.',
    ].join('\n'),
    contact: { name: 'Nebulis', url: 'https://nebulis.app' },
  },
  servers: [{ url: '/api/v1', description: 'API v1' }],

  // ─── Security ──────────────────────────────────────────────────────
  security: [],   // most endpoints are open; override per-route if needed

  components: {
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'Pass the generated API key in this header.',
      },
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'Alternative: pass API key as Bearer token.',
      },
    },

    // ─── Reusable parameters ────────────────────────────────────────
    parameters: {
      page:     { name: 'page',  in: 'query', schema: { type: 'integer', default: 1 } },
      limit:    { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
      format:   { name: 'format', in: 'query', schema: { type: 'string', enum: ['base64'] }, description: 'Return image as base64 JSON instead of raw binary' },
      objectId: { name: 'objectId', in: 'path', required: true, schema: { type: 'string' }, description: 'Catalog ID, e.g. M42 or NGC7000' },
    },

    // ─── Schemas ────────────────────────────────────────────────────
    schemas: {

      // Envelope
      ApiResponse: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok:    { type: 'boolean' },
          data:  { description: 'Response payload: type varies per endpoint' },
          meta:  { type: 'object', description: 'Pagination, cache age, and other metadata' },
          error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
        },
      },

      // SMB library objects
      AstroObject: {
        type: 'object',
        properties: {
          id:           strEx('M42'),
          catalogId:    strEx('M42'),
          name:         strEx('Orion Nebula'),
          type:         strEx('Emission/Reflection Nebula'),
          constellation: strEx('Orion'),
          description:  { type: 'string' },
          magnitude:    nullable({ type: 'number', example: 4.0 }),
          ra:           nullable(strEx('05h 35m 17.3s')),
          dec:          nullable(strEx('-05° 23′ 28″')),
          thumbnailUrl: { type: 'string' },
          sessionsUrl:  { type: 'string' },
        },
      },

      Session: {
        type: 'object',
        properties: {
          id:           strEx('2024_01_15_session'),
          objectId:     strEx('M42'),
          date:         nullable({ ...isoDateD }),
          thumbnailUrl: { type: 'string' },
          filesUrl:     { type: 'string' },
        },
      },

      SessionFile: {
        type: 'object',
        properties: {
          name:        strEx('sub_001.fit'),
          size:        { type: 'integer', example: 4915200 },
          type:        { type: 'string', enum: [...FILE_CATEGORIES] },
          path:        { type: 'string' },
          downloadUrl: { type: 'string' },
        },
      },

      // DSO catalog (OpenNGC-based, ~3,200 Seestar-appropriate objects)
      DsoEntry: {
        type: 'object',
        properties: {
          id:              strEx('M81'),
          ngcName:         strEx('NGC3031'),
          name:            strEx("Bode's Galaxy"),
          type:            strEx('Spiral Galaxy'),
          typeCode:        strEx('G'),
          constellation:   nullable(strEx('Ursa Major')),
          ra:              { type: 'number', description: 'Right ascension in decimal hours', example: 9.926 },
          dec:             { type: 'number', description: 'Declination in decimal degrees', example: 69.065 },
          magnitude:       nullable({ type: 'number', example: 6.9 }),
          majorAxisArcmin: nullable({ type: 'number', description: 'Angular size in arcminutes', example: 26.9 }),
          commonNames:     { type: 'array', items: { type: 'string' } },
          messier:         nullable({ type: 'integer', example: 81 }),
          altNow:          nullable({ type: 'number', description: 'Altitude in degrees at time of request (if location set)' }),
          azNow:           nullable({ type: 'number', description: 'Azimuth in degrees at time of request (if location set)' }),
        },
      },

      // Built-in catalog (the /catalog router). These are hand-written because
      // the catalog routes do not validate with Zod.
      CatalogImageSource: {
        type: 'object',
        required: ['source', 'label', 'sizeBytes', 'width', 'height'],
        properties: {
          source:    { type: 'string', enum: ['hubble', 'wiki', 'dss2'] },
          label:     strEx('CDS DSS2 Survey'),
          sizeBytes: { type: 'integer' },
          width:     nullable({ type: 'integer' }),
          height:    nullable({ type: 'integer' }),
        },
      },
      CatalogSources: {
        type: 'object',
        required: ['id', 'sources'],
        properties: {
          id:      strEx('NGC7000'),
          sources: { type: 'array', items: { $ref: '#/components/schemas/CatalogImageSource' } },
        },
      },
      CatalogPrefetchResult: {
        type: 'object',
        required: ['id', 'dss2', 'wiki', 'hubble'],
        properties: {
          id:     strEx('NGC7000'),
          dss2:   { type: 'boolean' },
          wiki:   { type: 'boolean' },
          hubble: { type: 'boolean' },
        },
      },
      CatalogOverrideInput: {
        type: 'object',
        properties: {
          name:          { type: 'string' },
          type:          { type: 'string' },
          constellation: { type: 'string' },
          magnitude:     { type: 'number' },
          description:   { type: 'string' },
          ra:            { type: 'string', description: 'Right ascension, e.g. "05h 35m 17.3s"' },
          dec:           { type: 'string', description: 'Declination, e.g. "-05° 23′ 28″"' },
          distanceLy:    { type: 'number', description: 'Distance in light-years' },
        },
      },
      CatalogOverrideRecord: {
        type: 'object',
        required: ['objectId', 'updatedAt', 'updatedBy'],
        properties: {
          objectId:      strEx('M31'),
          name:          { type: 'string' },
          type:          { type: 'string' },
          constellation: { type: 'string' },
          magnitude:     { type: 'number' },
          description:   { type: 'string' },
          ra:            { type: 'string' },
          dec:           { type: 'string' },
          distanceLy:    { type: 'number' },
          updatedAt:     { type: 'integer', description: 'Unix ms' },
          updatedBy:     nullable(strEx('user-id')),
        },
      },
      CatalogOverrideDeleted: {
        type: 'object',
        required: ['removed'],
        properties: { removed: { type: 'boolean', description: 'False when there was no override to remove' } },
      },
      CatalogInfo: {
        type: 'object',
        required: ['name', 'type', 'constellation', 'magnitude', 'description', 'ra', 'dec', 'distance', 'distanceLy', 'size', 'imageUrl', 'wikiUrl', 'alsoKnownAs', 'override'],
        properties: {
          name:          strEx('Andromeda Galaxy'),
          type:          strEx('Spiral Galaxy'),
          constellation: strEx('Andromeda'),
          magnitude:     nullable({ type: 'number', example: 3.4 }),
          description:   { type: 'string' },
          ra:            nullable(strEx('00h 42m 44.3s')),
          dec:           nullable(strEx('41° 16′ 09″')),
          distance:      nullable({ type: 'string', example: '2.54 million light-years', description: 'Formatted distance' }),
          distanceLy:    nullable({ type: 'number', example: 2540000 }),
          size:          nullable({ type: 'string', example: "190.0'", description: 'Formatted angular size' }),
          imageUrl:      strEx('/api/catalog/M31/image'),
          wikiUrl:       nullable({ type: 'string' }),
          alsoKnownAs:   { type: 'array', items: { type: 'string' } },
          override:      { oneOf: [{ $ref: '#/components/schemas/CatalogOverrideRecord' }, { type: 'null' }] },
        },
      },
      CatalogCredit: {
        type: 'object',
        required: ['source', 'credit', 'licenseUrl'],
        properties: {
          source:     { type: 'string', enum: [...CREDIT_SOURCES] },
          credit:     { type: 'string' },
          licenseUrl: { type: 'string' },
        },
      },
      CatalogCacheStats: {
        type: 'object',
        required: ['dss2Count', 'dss2Bytes', 'wikiImageCount', 'wikiImageBytes', 'caldwellCount', 'caldwellBytes', 'wikiWithExtract', 'wikiNotFound'],
        properties: {
          dss2Count:       { type: 'integer' },
          dss2Bytes:       { type: 'integer' },
          wikiImageCount:  { type: 'integer' },
          wikiImageBytes:  { type: 'integer' },
          caldwellCount:   { type: 'integer' },
          caldwellBytes:   { type: 'integer' },
          wikiWithExtract: { type: 'integer' },
          wikiNotFound:    { type: 'integer' },
        },
      },
      CatalogPackState: {
        type: 'object',
        required: ['tier', 'version', 'installedAt', 'objectCount'],
        properties: {
          tier:        { type: 'string', enum: [...CATALOG_TIERS] },
          version:     { type: 'string' },
          installedAt: { type: 'integer', description: 'Unix ms' },
          objectCount: { type: 'integer' },
        },
      },
      CatalogPrefetchStatus: {
        type: 'object',
        required: ['running', 'phase', 'processed', 'total', 'errors', 'startedAt', 'finishedAt', 'lastError', 'imagesCompletedAt', 'wikiCompletedAt', 'caldwellCompletedAt', 'packCompletedAt'],
        properties: {
          running:            { type: 'boolean' },
          phase:              { type: 'string', enum: ['idle', 'pack', 'images', 'wikipedia', 'caldwell', 'done', 'cancelled', 'error'] },
          processed:          { type: 'integer' },
          total:              { type: 'integer' },
          errors:             { type: 'integer' },
          startedAt:          nullable({ type: 'integer', description: 'Unix ms' }),
          finishedAt:         nullable({ type: 'integer', description: 'Unix ms' }),
          lastError:          { type: 'string' },
          imagesCompletedAt:  nullable({ type: 'integer', description: 'Unix ms' }),
          wikiCompletedAt:    nullable({ type: 'integer', description: 'Unix ms' }),
          caldwellCompletedAt: nullable({ type: 'integer', description: 'Unix ms' }),
          packCompletedAt:    nullable({ type: 'integer', description: 'Unix ms' }),
        },
      },
      CatalogPrefetchOverview: {
        allOf: [{ $ref: '#/components/schemas/CatalogPrefetchStatus' }],
        type: 'object',
        required: ['stats', 'packStates'],
        properties: {
          stats:      { $ref: '#/components/schemas/CatalogCacheStats' },
          packStates: { type: 'array', items: { $ref: '#/components/schemas/CatalogPackState' } },
        },
      },
      CatalogPrefetchStartResult: {
        type: 'object',
        required: ['started', 'status'],
        properties: {
          started: { type: 'boolean' },
          reason:  { type: 'string', description: 'Why it did not start, e.g. already_running' },
          status:  { $ref: '#/components/schemas/CatalogPrefetchStatus' },
        },
      },
      CatalogPrefetchCancelResult: {
        type: 'object',
        required: ['cancelled', 'status'],
        properties: {
          cancelled: { type: 'boolean', description: 'False when no job was running' },
          status:    { $ref: '#/components/schemas/CatalogPrefetchStatus' },
        },
      },
      CatalogPrefetchWipeResult: {
        type: 'object',
        required: ['wiped', 'stats'],
        properties: {
          wiped: { type: 'boolean' },
          stats: { $ref: '#/components/schemas/CatalogCacheStats' },
        },
      },
      CatalogCacheWipeInput: {
        type: 'object',
        required: ['confirmation'],
        properties: {
          confirmation: { type: 'string', enum: ['reinitialize'], description: 'Echo reinitialize to confirm the destructive wipe' },
        },
      },
      CatalogPackDebug: {
        type: 'object',
        required: ['steps'],
        properties: {
          steps: {
            type: 'object',
            additionalProperties: true,
            description: 'Per-step outcomes: skyCacheInventory, installedPacks, indexFetch, indexSigFetch, indexSignature, indexParse, tiers',
          },
        },
      },
      GeocodeReverse: {
        type: 'object',
        required: ['city', 'timezone'],
        properties: {
          city:     nullable(strEx('Destin, FL')),
          timezone: nullable(strEx('America/Chicago')),
        },
      },
      GeocodePlace: {
        type: 'object',
        required: ['name', 'label', 'latitude', 'longitude', 'timezone', 'country', 'admin1'],
        properties: {
          name:      strEx('Destin'),
          label:     strEx('Destin, Florida, United States'),
          latitude:  { type: 'number' },
          longitude: { type: 'number' },
          timezone:  nullable(strEx('America/Chicago')),
          country:   nullable(strEx('United States')),
          admin1:    nullable(strEx('Florida')),
        },
      },

      // Storage. Hand-written for the same reason as the catalog schemas: these
      // routes read typed lib results rather than validating with Zod.
      StorageLibraryObject: {
        type: 'object',
        required: ['objectId', 'name', 'size', 'sizeFormatted', 'fileCount'],
        properties: {
          objectId:      strEx('M42'),
          name:          strEx('Orion Nebula'),
          size:          { type: 'integer', description: 'Bytes on the library disk' },
          sizeFormatted: strEx('1.2 GB'),
          fileCount:     { type: 'integer' },
        },
      },
      StorageLibrary: {
        type: 'object',
        required: ['objects'],
        properties: { objects: { type: 'array', items: { $ref: '#/components/schemas/StorageLibraryObject' } } },
      },
      StorageClientLocality: {
        type: 'object',
        required: ['sameMachine', 'serverName'],
        properties: {
          sameMachine: { type: 'boolean', description: 'The browser is running on the server machine' },
          serverName:  strEx('nebulis'),
        },
      },
      StorageVolume: {
        type: 'object',
        required: ['path', 'label', 'totalBytes', 'freeBytes', 'writable', 'external'],
        properties: {
          path:       strEx('/Volumes/MyDrive'),
          label:      strEx('MyDrive'),
          totalBytes: { type: 'integer' },
          freeBytes:  { type: 'integer' },
          writable:   { type: 'boolean' },
          external:   { type: 'boolean', description: 'Removable media rather than a fixed disk' },
        },
      },
      StorageVolumes: {
        type: 'object',
        required: ['volumes'],
        properties: { volumes: { type: 'array', items: { $ref: '#/components/schemas/StorageVolume' } } },
      },
      StorageDirectory: {
        type: 'object',
        required: ['name', 'path'],
        properties: { name: strEx('Astro'), path: strEx('/Volumes/MyDrive/Astro') },
      },
      StorageBrowse: {
        type: 'object',
        required: ['path', 'directories'],
        properties: {
          path:        strEx('/Volumes/MyDrive'),
          directories: { type: 'array', items: { $ref: '#/components/schemas/StorageDirectory' } },
        },
      },
      StorageLocateResult: {
        type: 'object',
        required: ['path'],
        properties: { path: nullable({ type: 'string', example: '/Volumes/MyDrive/Astro/M42', description: 'Null when the dropped folder was not found on this machine' }) },
      },
      StorageRecovered: {
        type: 'object',
        required: ['from', 'to', 'at'],
        properties: { from: strEx('/old/library'), to: strEx('/new/library'), at: { type: 'string', format: 'date-time' } },
      },
      StorageLibraryLocation: {
        type: 'object',
        required: ['path', 'isDefault', 'available', 'libraryId', 'locationType', 'defaultPath', 'network', 'networkLibrarySupported', 'pinned', 'recovered'],
        properties: {
          path:         strEx('/Volumes/MyDrive/Nebulis'),
          isDefault:    { type: 'boolean' },
          available:    { type: 'boolean' },
          libraryId:    { type: 'string' },
          locationType: { type: 'string', enum: ['local', 'network'] },
          defaultPath:  strEx('/app/data/library'),
          network: {
            type: 'object',
            required: ['host', 'share', 'domain', 'username', 'subpath'],
            properties: {
              host:     { type: 'string' },
              share:    { type: 'string' },
              domain:   { type: 'string' },
              username: { type: 'string' },
              subpath:  { type: 'string' },
            },
          },
          networkLibrarySupported: { type: 'boolean', description: 'False on Linux and Docker' },
          pinned:    { type: 'boolean', description: 'LIBRARY_DIR pins the location' },
          recovered: { oneOf: [{ $ref: '#/components/schemas/StorageRecovered' }, { type: 'null' }] },
        },
      },
      StorageAdoptReconcile: {
        type: 'object',
        required: ['registeredObjects', 'retiredObjects', 'staleRecordsRemoved', 'skipped'],
        properties: {
          registeredObjects:   { type: 'integer' },
          retiredObjects:      { type: 'integer' },
          staleRecordsRemoved: { type: 'integer' },
          skipped:             nullable({ type: 'string', description: 'Why the cleanup did not run' }),
        },
      },
      StorageMigration: {
        type: 'object',
        required: ['phase', 'fromPath', 'toPath', 'bytesTotal', 'bytesCopied', 'filesTotal', 'filesCopied', 'error', 'startedAt', 'completedAt', 'previousPath', 'adopted'],
        properties: {
          phase:        { type: 'string', enum: ['idle', 'preparing', 'copying', 'verifying', 'switching', 'done', 'failed', 'adopting'] },
          fromPath:     nullable({ type: 'string' }),
          toPath:       nullable({ type: 'string' }),
          bytesTotal:   { type: 'integer' },
          bytesCopied:  { type: 'integer' },
          filesTotal:   { type: 'integer' },
          filesCopied:  { type: 'integer' },
          error:        nullable({ type: 'string' }),
          startedAt:    nullable({ type: 'integer', description: 'Unix ms' }),
          completedAt:  nullable({ type: 'integer', description: 'Unix ms' }),
          previousPath: nullable({ type: 'string' }),
          adopted:      { oneOf: [{ $ref: '#/components/schemas/StorageAdoptReconcile' }, { type: 'null' }] },
        },
      },
      StorageMigrationWrapper: {
        type: 'object',
        required: ['migration'],
        properties: { migration: { $ref: '#/components/schemas/StorageMigration' } },
      },
      StorageLibraryLocationState: {
        type: 'object',
        required: ['location', 'migration'],
        properties: {
          location:  { $ref: '#/components/schemas/StorageLibraryLocation' },
          migration: { $ref: '#/components/schemas/StorageMigration' },
        },
      },
      StorageNetworkConfigInput: {
        type: 'object',
        properties: {
          host:     { type: 'string' },
          share:    { type: 'string' },
          domain:   { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' },
          subpath:  { type: 'string' },
        },
      },
      StorageNetworkTest: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' }, reason: { type: 'string' } },
      },
      StorageLibraryResetResult: {
        type: 'object',
        required: ['ok', 'changed', 'path', 'previousPath'],
        properties: {
          ok:           { type: 'boolean' },
          changed:      { type: 'boolean' },
          path:         { type: 'string' },
          previousPath: { type: 'string' },
        },
      },
      StorageRenestObjectResult: {
        type: 'object',
        required: ['objectId', 'moved', 'skipped', 'alreadyNested'],
        properties: {
          objectId:      { type: 'string' },
          moved:         { type: 'integer' },
          skipped:       { type: 'integer' },
          alreadyNested: { type: 'boolean' },
          error:         { type: 'string' },
        },
      },
      StorageRenestSummary: {
        type: 'object',
        required: ['objects', 'moved', 'failed', 'results'],
        properties: {
          objects: { type: 'integer' },
          moved:   { type: 'integer' },
          failed:  { type: 'integer' },
          results: { type: 'array', items: { $ref: '#/components/schemas/StorageRenestObjectResult' } },
        },
      },
      StorageRenestStatus: {
        type: 'object',
        required: ['running', 'startedAt', 'objectsTotal', 'objectsDone', 'currentObject', 'summary', 'error'],
        properties: {
          running:       { type: 'boolean' },
          startedAt:     nullable({ type: 'string', format: 'date-time' }),
          objectsTotal:  { type: 'integer' },
          objectsDone:   { type: 'integer' },
          currentObject: nullable({ type: 'string' }),
          summary:       { oneOf: [{ $ref: '#/components/schemas/StorageRenestSummary' }, { type: 'null' }] },
          error:         nullable({ type: 'string' }),
        },
      },
      StorageRenestState: {
        type: 'object',
        required: ['renest', 'flatObjects'],
        properties: {
          renest:       { $ref: '#/components/schemas/StorageRenestStatus' },
          flatObjects:  { type: 'integer' },
        },
      },
      StorageSubframeUsage: {
        type: 'object',
        required: ['files', 'bytes', 'objects', 'staleRecords', 'unreadable', 'topObjects'],
        properties: {
          files:        { type: 'integer' },
          bytes:        { type: 'integer' },
          objects:      { type: 'integer' },
          staleRecords: { type: 'integer' },
          unreadable:   { type: 'integer' },
          topObjects: {
            type: 'array',
            items: {
              type: 'object',
              required: ['objectId', 'files', 'bytes'],
              properties: { objectId: { type: 'string' }, files: { type: 'integer' }, bytes: { type: 'integer' } },
            },
          },
        },
      },
      StoragePurgeResult: {
        type: 'object',
        required: ['deleted', 'freedBytes', 'objects', 'staleRemoved', 'unreadable'],
        properties: {
          deleted:      { type: 'integer' },
          freedBytes:   { type: 'integer' },
          objects:      { type: 'integer' },
          staleRemoved: { type: 'integer' },
          unreadable:   { type: 'integer' },
        },
      },
      StorageAnalysis: {
        type: 'object',
        required: ['staleRecords', 'missingObjects', 'missingObjectCount', 'layoutDrift', 'flatObjects', 'duplicateFiles', 'missingProcessed', 'unreadable', 'ranAt'],
        properties: {
          staleRecords:      { type: 'object', required: ['count', 'objects'], properties: { count: { type: 'integer' }, objects: { type: 'integer' } } },
          missingObjects: {
            type: 'array',
            items: {
              type: 'object',
              required: ['objectId', 'folderName', 'fileRecords'],
              properties: { objectId: { type: 'string' }, folderName: { type: 'string' }, fileRecords: { type: 'integer' } },
            },
            description: 'Capped at 50; missingObjectCount is exact',
          },
          missingObjectCount: { type: 'integer' },
          layoutDrift:        { type: 'integer' },
          flatObjects:        { type: 'integer' },
          duplicateFiles:     { type: 'object', required: ['count', 'objects', 'bytes'], properties: { count: { type: 'integer' }, objects: { type: 'integer' }, bytes: { type: 'integer' } } },
          missingProcessed:   { type: 'object', required: ['count', 'objects'], properties: { count: { type: 'integer' }, objects: { type: 'integer' } } },
          unreadable:         { type: 'integer', description: 'Non-zero means a repair will refuse until the paths can be checked' },
          ranAt:              { type: 'string', format: 'date-time' },
        },
      },
      StorageRepairResult: {
        type: 'object',
        required: ['category'],
        properties: {
          category:   { type: 'string', enum: ['staleRecords', 'missingObjects', 'layoutDrift', 'missingProcessed', 'duplicateFiles'] },
          removed:    { type: 'integer' },
          retired:    { type: 'integer' },
          fixed:      { type: 'integer' },
          freedBytes: { type: 'integer' },
          skipped:    { type: 'integer' },
        },
      },
      StorageBackup: {
        type: 'object',
        required: ['name', 'path', 'kind', 'version', 'createdAt', 'sizeBytes'],
        properties: {
          name:      strEx('nebulis-manual-3.2.0-2026-11-01T06-00-00.db'),
          path:      { type: 'string' },
          kind:      { type: 'string', enum: ['upgrade', 'manual'] },
          version:   nullable({ type: 'string' }),
          createdAt: { type: 'integer', description: 'Unix ms from the file mtime' },
          sizeBytes: { type: 'integer' },
        },
      },
      StorageBackupAttempt: {
        type: 'object',
        required: ['at', 'fromVersion', 'toVersion', 'status'],
        properties: {
          at:          { type: 'integer', description: 'Unix ms' },
          fromVersion: nullable({ type: 'string' }),
          toVersion:   { type: 'string' },
          status:      { type: 'string', enum: ['created', 'failed'] },
          error:       { type: 'string' },
          backupName:  { type: 'string' },
        },
      },
      StorageBackups: {
        type: 'object',
        required: ['backups', 'lastAttempt', 'dir', 'maxRetainedPerKind', 'currentVersion'],
        properties: {
          backups:            { type: 'array', items: { $ref: '#/components/schemas/StorageBackup' } },
          lastAttempt:        { oneOf: [{ $ref: '#/components/schemas/StorageBackupAttempt' }, { type: 'null' }] },
          dir:                { type: 'string' },
          maxRetainedPerKind: { type: 'integer' },
          currentVersion:     { type: 'string' },
        },
      },
      StorageBackupCreated: {
        type: 'object',
        required: ['backup', 'pruned'],
        properties: {
          backup: { $ref: '#/components/schemas/StorageBackup' },
          pruned: { type: 'integer' },
        },
      },
      StorageDeleted: {
        type: 'object',
        required: ['deleted', 'name'],
        properties: { deleted: { type: 'boolean', const: true }, name: { type: 'string' } },
      },
      StorageMigrateInput: {
        type: 'object',
        properties: {
          targetPath: { type: 'string', description: 'A local folder to move the library to' },
          network:    { $ref: '#/components/schemas/StorageNetworkConfigInput' },
          adopt:      { type: 'boolean', description: 'Use an existing library at the destination without copying' },
        },
      },
      StorageRenestInput: {
        type: 'object',
        properties: { objectId: { type: 'string', description: 'Omit to reorganize the whole library' } },
      },
      StorageAnalyzeFixInput: {
        type: 'object',
        required: ['category'],
        properties: { category: { type: 'string', enum: ['staleRecords', 'missingObjects', 'layoutDrift', 'missingProcessed', 'duplicateFiles'] } },
      },
      StorageLocateInput: {
        type: 'object',
        required: ['anchorName', 'samples'],
        properties: {
          anchorName: { type: 'string' },
          samples: {
            type: 'array',
            items: {
              type: 'object',
              required: ['relativePath', 'size'],
              properties: { relativePath: { type: 'string' }, size: { type: 'number' } },
            },
          },
        },
      },

      // External archive
      StorageArchiveNetwork: {
        type: 'object',
        required: ['host', 'share', 'domain', 'username', 'hasPassword', 'subpath'],
        properties: {
          host:        { type: 'string' },
          share:       { type: 'string' },
          domain:      { type: 'string' },
          username:    { type: 'string' },
          hasPassword: { type: 'boolean', description: 'A password is stored; the password itself is never returned' },
          subpath:     { type: 'string' },
        },
      },
      StorageArchiveNetworkInput: {
        type: 'object',
        properties: {
          host:          { type: 'string' },
          share:         { type: 'string' },
          domain:        { type: 'string' },
          username:      { type: 'string' },
          subpath:       { type: 'string' },
          password:      { type: 'string', description: 'Omitted or empty keeps the stored password' },
          clearPassword: { type: 'boolean', description: 'Forget the stored password' },
          hasPassword:   { type: 'boolean' },
        },
      },
      StorageArchiveConfig: {
        type: 'object',
        required: ['enabled', 'path', 'locationType', 'network', 'archiveId', 'scope', 'selectedObjects', 'includeSubframes', 'copyMinAgeDays', 'copyMinAgeEnabled', 'scheduleEnabled', 'scheduleMode', 'scheduleHour', 'scheduleMinute', 'scheduleIntervalHours', 'scheduleCron', 'retentionDays', 'retentionEnabled', 'retentionSubframesOnly', 'removeLocalAfter', 'lastRunAt', 'lastResult'],
        properties: {
          enabled:               { type: 'boolean', description: 'Master switch; off means nothing is copied, adopted or pruned' },
          path:                  { type: 'string' },
          locationType:          { type: 'string', enum: ['local', 'network'] },
          network:               { $ref: '#/components/schemas/StorageArchiveNetwork' },
          archiveId:             { type: 'string', description: 'Empty when the destination has not been adopted' },
          scope:                 { type: 'string', enum: ['all', 'selected'] },
          selectedObjects:       { type: 'array', items: { type: 'string' } },
          includeSubframes:      { type: 'boolean' },
          copyMinAgeDays:        { type: 'integer' },
          copyMinAgeEnabled:     { type: 'boolean' },
          scheduleEnabled:       { type: 'boolean' },
          scheduleMode:          { type: 'string', enum: ['daily', 'interval', 'custom'] },
          scheduleHour:          { type: 'integer', minimum: 0, maximum: 23 },
          scheduleMinute:        { type: 'integer', minimum: 0, maximum: 59 },
          scheduleIntervalHours: { type: 'integer' },
          scheduleCron:          { type: 'string' },
          retentionDays:         { type: 'integer', description: '0 keeps everything' },
          retentionEnabled:      { type: 'boolean' },
          retentionSubframesOnly: { type: 'boolean' },
          removeLocalAfter:      { type: 'boolean', description: 'Remove local sub-frames once the archived copy is verified' },
          lastRunAt:             { type: 'string' },
          lastResult:            { type: 'string' },
        },
      },
      StorageArchiveConfigInput: {
        type: 'object',
        description: 'Any subset of the archive settings. Unknown keys are rejected.',
        properties: {
          enabled:               { type: 'boolean' },
          path:                  { type: 'string' },
          locationType:          { type: 'string', enum: ['local', 'network'] },
          network:               { $ref: '#/components/schemas/StorageArchiveNetworkInput' },
          scope:                 { type: 'string', enum: ['all', 'selected'] },
          selectedObjects:       { type: 'array', items: { type: 'string' } },
          includeSubframes:      { type: 'boolean' },
          copyMinAgeDays:        { type: 'integer' },
          copyMinAgeEnabled:     { type: 'boolean' },
          scheduleEnabled:       { type: 'boolean' },
          scheduleMode:          { type: 'string', enum: ['daily', 'interval', 'custom'] },
          scheduleHour:          { type: 'integer', minimum: 0, maximum: 23 },
          scheduleMinute:        { type: 'integer', minimum: 0, maximum: 59 },
          scheduleIntervalHours: { type: 'integer' },
          scheduleCron:          { type: 'string' },
          retentionDays:         { type: 'integer' },
          retentionEnabled:      { type: 'boolean' },
          retentionSubframesOnly: { type: 'boolean' },
          removeLocalAfter:      { type: 'boolean' },
        },
      },
      StorageArchiveDestination: {
        type: 'object',
        required: ['state', 'path', 'foundArchiveId', 'locationType', 'network', 'networkSupported', 'sameDiskAsLibrary'],
        properties: {
          state:            { type: 'string', enum: ['unconfigured', 'invalid-path', 'offline', 'match', 'absent', 'foreign', 'invalid', 'unreadable'] },
          path:             { type: 'string' },
          foundArchiveId:   nullable({ type: 'string' }),
          locationType:     { type: 'string', enum: ['local', 'network'] },
          network:          { $ref: '#/components/schemas/StorageArchiveNetwork' },
          networkSupported: { type: 'boolean', description: 'False on Linux and Docker' },
          sameDiskAsLibrary: { type: 'boolean', description: 'Local destination on the library or data disk, so it would not survive that disk failing' },
        },
      },
      StorageArchiveState: {
        type: 'object',
        required: ['config', 'destination'],
        properties: {
          config:      { $ref: '#/components/schemas/StorageArchiveConfig' },
          destination: { $ref: '#/components/schemas/StorageArchiveDestination' },
        },
      },
      StorageArchiveAdoptInput: {
        type: 'object',
        properties: {
          createFolder:      { type: 'boolean', description: 'Create the destination folder if it does not exist' },
          confirmArchiveId:  { type: 'string', description: 'The existing archive id to take over' },
        },
      },
      StorageArchiveTestInput: {
        type: 'object',
        required: ['network'],
        properties: { network: { $ref: '#/components/schemas/StorageArchiveNetworkInput' } },
      },
      StorageArchiveTestResult: {
        type: 'object',
        required: ['ok', 'reason'],
        properties: { ok: { type: 'boolean' }, reason: nullable({ type: 'string' }) },
      },
      StorageArchiveBrowseInput: {
        type: 'object',
        properties: {
          network: { $ref: '#/components/schemas/StorageArchiveNetworkInput' },
          path:    { type: 'string', description: 'A folder inside the share; defaults to the share root' },
        },
      },
      StorageArchiveBrowse: {
        type: 'object',
        required: ['path', 'root', 'directories'],
        properties: {
          path:        { type: 'string' },
          root:        { type: 'string' },
          directories: { type: 'array', items: { $ref: '#/components/schemas/StorageDirectory' } },
        },
      },
      StorageArchiveRunProgress: {
        type: 'object',
        required: ['running', 'phase', 'filesTotal', 'filesDone', 'bytesTotal', 'bytesDone', 'copied', 'skipped', 'startedAt', 'finishedAt', 'warnings'],
        properties: {
          running:    { type: 'boolean' },
          phase:      { type: 'string', enum: ['idle', 'scanning', 'copying', 'done', 'failed'] },
          filesTotal: { type: 'integer' },
          filesDone:  { type: 'integer' },
          bytesTotal: { type: 'integer' },
          bytesDone:  { type: 'integer' },
          copied:     { type: 'integer' },
          skipped:    { type: 'integer' },
          startedAt:  nullable({ type: 'integer', description: 'Unix ms' }),
          finishedAt: nullable({ type: 'integer', description: 'Unix ms' }),
          warnings:   { type: 'array', items: { type: 'string' } },
        },
      },
      StorageArchiveFailure: {
        type: 'object',
        required: ['archiveRelPath', 'error'],
        properties: { archiveRelPath: { type: 'string' }, error: { type: 'string' } },
      },
      StorageArchiveRunResult: {
        type: 'object',
        required: ['ran', 'copied', 'skipped', 'tooYoungSkipped', 'linkedSkipped', 'cancelled', 'bytesCopied', 'failures', 'warnings'],
        properties: {
          ran:             { type: 'boolean' },
          reason:          { type: 'string', enum: ['already-running', 'no-destination', 'destination-unusable', 'insufficient-space'] },
          copied:          { type: 'integer' },
          skipped:         { type: 'integer' },
          tooYoungSkipped: { type: 'integer' },
          linkedSkipped:   { type: 'integer' },
          cancelled:       { type: 'boolean' },
          diskLost:        { type: 'boolean' },
          bytesCopied:     { type: 'integer' },
          failures:        { type: 'array', items: { $ref: '#/components/schemas/StorageArchiveFailure' } },
          warnings:        { type: 'array', items: { type: 'string' } },
        },
      },
      StorageArchivePipelineResult: {
        allOf: [{ $ref: '#/components/schemas/StorageArchiveRunResult' }],
        type: 'object',
        required: ['summary', 'localRemoved', 'retentionRemoved'],
        properties: {
          summary:         { type: 'string' },
          localRemoved:    { type: 'integer' },
          retentionRemoved: { type: 'integer' },
        },
      },
      StorageArchiveLastRun: {
        type: 'object',
        required: ['trigger', 'finishedAt', 'result'],
        properties: {
          trigger:    { type: 'string', enum: ['scheduled', 'manual'] },
          finishedAt: { type: 'string', format: 'date-time' },
          result:     { $ref: '#/components/schemas/StorageArchivePipelineResult' },
        },
      },
      StorageArchiveRunStatus: {
        type: 'object',
        required: ['progress', 'running', 'lastRun'],
        properties: {
          progress: { $ref: '#/components/schemas/StorageArchiveRunProgress' },
          running:  { type: 'boolean' },
          lastRun:  { oneOf: [{ $ref: '#/components/schemas/StorageArchiveLastRun' }, { type: 'null' }] },
        },
      },
      StorageArchiveStarted: {
        type: 'object',
        required: ['started'],
        properties: { started: { type: 'boolean', const: true } },
      },
      StorageArchiveCancelling: {
        type: 'object',
        required: ['cancelling'],
        properties: { cancelling: { type: 'boolean', const: true } },
      },
      StorageRetentionItem: {
        type: 'object',
        required: ['folderName', 'archivedAt', 'files', 'bytes'],
        properties: {
          folderName: { type: 'string' },
          archivedAt: { type: 'string' },
          files:      { type: 'array', items: { type: 'string' } },
          bytes:      { type: 'integer' },
        },
      },
      StorageRetentionPlan: {
        type: 'object',
        required: ['mode', 'root', 'items', 'filesTotal', 'bytesTotal', 'warnings'],
        properties: {
          mode:       { type: 'string', enum: ['whole-object', 'subframes-only'] },
          root:       { type: 'string' },
          items:      { type: 'array', items: { $ref: '#/components/schemas/StorageRetentionItem' } },
          filesTotal: { type: 'integer' },
          bytesTotal: { type: 'integer' },
          warnings:   { type: 'array', items: { type: 'string' } },
        },
      },
      StorageRetentionResult: {
        type: 'object',
        required: ['removed', 'bytesRemoved', 'failures'],
        properties: {
          removed:      { type: 'integer' },
          bytesRemoved: { type: 'integer' },
          failures:     { type: 'array', items: { type: 'string' } },
        },
      },
      StorageRetentionApplyResult: {
        allOf: [{ $ref: '#/components/schemas/StorageRetentionResult' }],
        type: 'object',
        required: ['plan'],
        properties: {
          plan: {
            type: 'object',
            required: ['mode', 'filesTotal', 'warnings'],
            properties: {
              mode:       { type: 'string', enum: ['whole-object', 'subframes-only'] },
              filesTotal: { type: 'integer' },
              warnings:   { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      StorageArchivedObject: {
        type: 'object',
        required: ['folderName', 'objectId', 'willCreate', 'firstArchivedAt', 'lastArchivedAt', 'filesTotal', 'subframes', 'bytes', 'missingLocally'],
        properties: {
          folderName:    { type: 'string' },
          objectId:      nullable({ type: 'string' }),
          willCreate:    { type: 'boolean' },
          firstArchivedAt: { type: 'string' },
          lastArchivedAt:  { type: 'string' },
          filesTotal:    { type: 'integer' },
          subframes:     { type: 'integer' },
          bytes:         { type: 'integer' },
          missingLocally: { type: 'integer' },
        },
      },
      StorageArchivedFile: {
        type: 'object',
        required: ['relPath', 'isSubframe', 'bytes', 'presentLocally'],
        properties: {
          relPath:        { type: 'string' },
          isSubframe:     { type: 'boolean' },
          bytes:          { type: 'integer' },
          presentLocally: { type: 'boolean' },
        },
      },
      StorageArchiveContentsObjects: {
        type: 'object',
        required: ['objects', 'warnings'],
        properties: {
          objects:  { type: 'array', items: { $ref: '#/components/schemas/StorageArchivedObject' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      StorageArchiveContentsFiles: {
        type: 'object',
        required: ['files', 'warnings'],
        properties: {
          files:    { type: 'array', items: { $ref: '#/components/schemas/StorageArchivedFile' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      StorageArchiveRestoreInput: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            maxItems: 500,
            items: {
              type: 'object',
              required: ['folderName', 'relPath'],
              properties: { folderName: { type: 'string' }, relPath: { type: 'string' } },
            },
          },
          overwrite: { type: 'boolean', description: 'Replace local files whose contents differ' },
        },
      },
      StorageArchiveRestoreResult: {
        type: 'object',
        required: ['ran', 'restored', 'skipped', 'bytesRestored', 'conflicts', 'failures', 'createdObjects', 'revivedObjects'],
        properties: {
          ran:            { type: 'boolean' },
          restored:       { type: 'integer' },
          skipped:        { type: 'integer' },
          bytesRestored:  { type: 'integer' },
          conflicts:      { type: 'array', items: { type: 'string' } },
          failures:       { type: 'array', items: { type: 'string' } },
          createdObjects: { type: 'integer' },
          revivedObjects: { type: 'integer' },
        },
      },

      // Tonight's planner target — DsoEntry plus visibility window
      PlannerTarget: {
        allOf: [{ $ref: '#/components/schemas/DsoEntry' }],
        type: 'object',
        required: ['maxAlt', 'maxAltTime', 'risesAt', 'setsAt', 'showpiece', 'isInWishlist', 'isAlreadyImaged', 'libraryObjectId', 'moonPenalty', 'bestTonightScore', 'tonightRank'],
        properties: {
          maxAlt:       { type: 'number', description: 'Peak altitude tonight in degrees', example: 72.4 },
          maxAltTime:   nullable({ ...isoDate, description: 'UTC time of peak altitude' }),
          risesAt:      nullable({ ...isoDate, description: 'Time object rises above min altitude / horizon profile' }),
          setsAt:       nullable({ ...isoDate, description: 'Time object sets below min altitude / horizon profile' }),
          aliases:      { type: 'array', items: { type: 'string' }, description: 'Every designation for the object' },
          showpiece:    { type: 'number', description: 'How rewarding the object is to shoot, independent of tonight' },
          isInWishlist:    { type: 'boolean' },
          isAlreadyImaged: { type: 'boolean' },
          libraryObjectId: nullable({ type: 'string' }),
          moonPenalty:     { type: 'number', description: 'How much the Moon costs this target tonight' },
          bestTonightScore: { type: 'number', description: 'Conditions score, 0-100' },
          tonightRank:      { type: 'number', description: 'Shared Best Tonight order, blending conditions and showpiece' },
        },
      },

      PlannerResponse: {
        type: 'object',
        required: ['locationSet', 'targets', 'totalVisible', 'nightStart', 'nightEnd', 'sunset', 'sunrise', 'timelineStart', 'timelineEnd', 'moonIllumination', 'moonPhase', 'observerLat', 'observerLon', 'observerTimezone', 'siteId', 'siteName'],
        properties: {
          locationSet:    { type: 'boolean' },
          targets:        { type: 'array', items: { $ref: '#/components/schemas/PlannerTarget' } },
          totalVisible:   { type: 'integer' },
          nightStart:     nullable({ ...isoDate }),
          nightEnd:       nullable({ ...isoDate }),
          sunset:         nullable({ ...isoDate }),
          sunrise:        nullable({ ...isoDate }),
          timelineStart:  { ...isoDate, description: 'Sunset, or dusk when there is no sunset' },
          timelineEnd:    { ...isoDate },
          moonIllumination: { type: 'integer', minimum: 0, maximum: 100, description: 'Moon illumination %' },
          moonPhase:      { type: 'string', example: 'Waxing Crescent' },
          observerLat:    nullable({ type: 'number' }),
          observerLon:    nullable({ type: 'number' }),
          observerTimezone: nullable(strEx('America/Chicago')),
          siteId:         nullable({ type: 'string', description: 'Null for a transient site from ad-hoc coordinates' }),
          siteName:       { type: 'string' },
        },
      },

      DsoBrowseResult: {
        type: 'object',
        required: ['results', 'total'],
        properties: {
          results: { type: 'array', items: { $ref: '#/components/schemas/DsoEntry' } },
          total:   { type: 'integer' },
        },
      },
      DsoCurveResult: {
        type: 'object',
        required: ['entry', 'curve', 'nightStart', 'nightEnd'],
        properties: {
          entry:      { $ref: '#/components/schemas/DsoEntry' },
          curve:      { type: 'array', items: { $ref: '#/components/schemas/AltitudeCurvePoint' } },
          nightStart: { ...isoDate },
          nightEnd:   { ...isoDate },
        },
      },
      PlannerGoalInput: {
        type: 'object',
        required: ['filter', 'goalSec', 'remainingSec'],
        properties: {
          filter:       nullable({ type: 'string' }),
          goalSec:      { type: 'number' },
          remainingSec: { type: 'number' },
        },
      },
      PlannerPlanTarget: {
        type: 'object',
        required: ['id', 'name', 'type', 'ra', 'dec', 'commonNames', 'isAlreadyImaged'],
        properties: {
          id:              { type: 'string' },
          name:            { type: 'string' },
          type:            { type: 'string' },
          ra:              { type: 'number' },
          dec:             { type: 'number' },
          magnitude:       nullable({ type: 'number' }),
          majorAxisArcmin: nullable({ type: 'number' }),
          constellation:   nullable({ type: 'string' }),
          commonNames:     { type: 'array', items: { type: 'string' } },
          isAlreadyImaged: { type: 'boolean' },
          goals:           { type: 'array', maxItems: 50, items: { $ref: '#/components/schemas/PlannerGoalInput' } },
        },
      },
      PlannerPlanInput: {
        type: 'object',
        required: ['targets', 'observerLat', 'observerLon', 'windowStart', 'windowEnd', 'slotMinutes', 'maxObjects', 'minAlt', 'moonIllumination'],
        properties: {
          targets: {
            type: 'array',
            minItems: 1,
            items: { $ref: '#/components/schemas/PlannerPlanTarget' },
          },
          observerLat:      { type: 'number', minimum: -90, maximum: 90 },
          observerLon:      { type: 'number', minimum: -180, maximum: 180 },
          windowStart:      { type: 'string', format: 'date-time' },
          windowEnd:        { type: 'string', format: 'date-time' },
          slotMinutes:      { type: 'number', exclusiveMinimum: 0 },
          maxObjects:       { type: 'integer', minimum: 1 },
          minAlt:           { type: 'number' },
          moonIllumination: { type: 'number', minimum: 0, maximum: 100 },
          visibleSkyMap:    { type: 'array', maxItems: 1000, items: { type: 'boolean' }, nullable: true },
          focus:            { type: 'string', enum: ['all', 'galaxies', 'nebulae', 'clusters'] },
          unimagedOnly:     { type: 'boolean' },
          jitter:           { type: 'number' },
          avoidIds:         { type: 'array', maxItems: 2000, items: { type: 'string' } },
          useForecast:      { type: 'boolean' },
          maxCloudCover:    { type: 'number', minimum: 0, maximum: 100 },
          favorGoals:       { type: 'boolean' },
          narrowbandCapable: { type: 'boolean' },
        },
      },
      PlannerSky: {
        type: 'object',
        required: ['cloudCover', 'seeing', 'transparency', 'dewRisk', 'usable'],
        properties: {
          cloudCover:   { type: 'number', minimum: 0, maximum: 100 },
          seeing:       nullable({ type: 'number', description: '1 best to 5' }),
          transparency: nullable({ type: 'number', description: '1 clearest to 8' }),
          dewRisk:      { type: 'boolean' },
          usable:       { type: 'boolean' },
        },
      },
      PlannerPlanBlock: {
        type: 'object',
        required: ['target', 'start', 'end', 'meanAlt', 'moonSeparation', 'moonVerdict', 'filterBand', 'sky'],
        properties: {
          target:          { $ref: '#/components/schemas/PlannerPlanTarget' },
          start:           { type: 'string', format: 'date-time' },
          end:             { type: 'string', format: 'date-time' },
          meanAlt:         { type: 'number' },
          moonSeparation:  nullable({ type: 'number' }),
          moonVerdict:     { type: 'string', enum: ['ok', 'caution', 'warning'] },
          filterBand:      { type: 'string', enum: ['broadband', 'narrowband'] },
          filter:          nullable({ type: 'string' }),
          filterRemainingSec: { type: 'number' },
          sky:             { oneOf: [{ $ref: '#/components/schemas/PlannerSky' }, { type: 'null' }] },
        },
      },
      PlannerVerdictInput: {
        type: 'object',
        required: ['items', 'observerLat', 'observerLon', 'moonIllumination'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            items: {
              type: 'object',
              required: ['id', 'ra', 'dec', 'start', 'end'],
              properties: {
                id:    { type: 'string' },
                ra:    { type: 'number' },
                dec:   { type: 'number' },
                start: { type: 'string', format: 'date-time' },
                end:   { type: 'string', format: 'date-time' },
                band:  nullable({ type: 'string', enum: ['broadband', 'narrowband'] }),
              },
            },
          },
          observerLat:      { type: 'number', minimum: -90, maximum: 90 },
          observerLon:      { type: 'number', minimum: -180, maximum: 180 },
          moonIllumination: { type: 'number', minimum: 0, maximum: 100 },
          visibleSkyMap:    { type: 'array', maxItems: 1000, items: { type: 'boolean' }, nullable: true },
          timeZone:         { type: 'string' },
        },
      },
      PlannerVerdict: {
        type: 'object',
        required: ['id', 'moon', 'visibility'],
        properties: {
          id:   { type: 'string' },
          moon: {
            type: 'object',
            required: ['verdict', 'minSeparation', 'threshold', 'worstAt', 'moonAltAtWorst', 'reason', 'band', 'narrowbandVerdict'],
            properties: {
              verdict:          { type: 'string', enum: ['ok', 'caution', 'warning'] },
              minSeparation:    { type: 'number' },
              threshold:        { type: 'number' },
              worstAt:          nullable({ type: 'string', format: 'date-time' }),
              moonAltAtWorst:   { type: 'number' },
              reason:           { type: 'string' },
              band:             { type: 'string', enum: ['broadband', 'narrowband'] },
              narrowbandVerdict: { type: 'string', enum: ['ok', 'caution', 'warning'] },
            },
          },
          visibility: {
            type: 'object',
            required: ['verdict', 'fractionVisible', 'firstBlockedAt', 'reason', 'minAlt', 'maxAlt'],
            properties: {
              verdict:         { type: 'string', enum: ['all', 'partial', 'none'] },
              fractionVisible: { type: 'number' },
              firstBlockedAt:  nullable({ type: 'string', format: 'date-time' }),
              reason:          { type: 'string' },
              minAlt:          { type: 'number' },
              maxAlt:          { type: 'number' },
            },
          },
        },
      },

      // Image annotation and plate solving.
      AnnotateSolverStatus: {
        type: 'object',
        required: ['supported', 'binaryInstalled', 'dbInstalled', 'ready', 'state', 'step', 'progress', 'error'],
        properties: {
          supported:       { type: 'boolean', description: 'ASTAP publishes a build for this OS and CPU' },
          binaryInstalled: { type: 'boolean' },
          dbInstalled:     { type: 'boolean' },
          ready:           { type: 'boolean', description: 'Both pieces present, so solving can run' },
          state:           { type: 'string', enum: ['idle', 'downloading', 'extracting', 'error'] },
          step:            nullable({ type: 'string' }),
          progress:        { type: 'number', minimum: 0, maximum: 1 },
          error:           nullable({ type: 'string' }),
        },
      },
      AnnotateSolveState: {
        type: 'object',
        required: ['state', 'message'],
        properties: {
          state:   { type: 'string', enum: ['idle', 'running', 'failed'] },
          message: nullable({ type: 'string' }),
        },
      },
      AnnotateFrameAnnotation: {
        type: 'object',
        required: ['id', 'label', 'designation', 'typeCode', 'type', 'magnitude', 'x', 'y', 'r', 'rTrue', 'oversized', 'isTarget'],
        properties: {
          id:          { type: 'string' },
          label:       { type: 'string' },
          designation: nullable({ type: 'string' }),
          typeCode:    { type: 'string' },
          type:        { type: 'string' },
          magnitude:   nullable({ type: 'number' }),
          x:           { type: 'number', description: 'Center in pixels, top-left origin' },
          y:           { type: 'number' },
          r:           { type: 'number', description: 'Draw radius in pixels, floored and capped' },
          rTrue:       { type: 'number', description: 'True angular radius in pixels' },
          oversized:   { type: 'boolean' },
          isTarget:    { type: 'boolean' },
        },
      },
      AnnotateResult: {
        type: 'object',
        required: ['quality', 'reason', 'imageWidth', 'imageHeight', 'pixelScaleArcsec', 'annotations', 'solver', 'solve'],
        properties: {
          quality:          { type: 'string', enum: ['solved', 'header', 'approximate', 'unavailable'] },
          reason:           nullable({ type: 'string', enum: ['mosaic', 'no-position', 'unknown-field', 'no-sky', 'edited'] }),
          imageWidth:       { type: 'integer' },
          imageHeight:      { type: 'integer' },
          pixelScaleArcsec: nullable({ type: 'number' }),
          annotations:      { type: 'array', items: { $ref: '#/components/schemas/AnnotateFrameAnnotation' } },
          solver:           { $ref: '#/components/schemas/AnnotateSolverStatus' },
          solve:            { $ref: '#/components/schemas/AnnotateSolveState' },
        },
      },
      AnnotateAutoSolveStatus: {
        type: 'object',
        required: ['enabled', 'running', 'pending', 'solved', 'failed'],
        properties: {
          enabled: { type: 'boolean' },
          running: { type: 'boolean' },
          pending: { type: 'integer', description: 'Pictures still waiting for a solution' },
          solved:  { type: 'integer' },
          failed:  { type: 'integer' },
        },
      },

      // Satellite trail detection.
      SatelliteDetectInput: {
        type: 'object',
        required: ['filePath'],
        properties: {
          filePath:    { type: 'string', description: 'Library-relative path' },
          skipCache:   { type: 'boolean' },
          identifyOnly: { type: 'boolean', description: 'Skip pixel detection and identify the satellite only' },
          overrideLat: { type: 'number', description: 'Used only when the file and the active site give no coordinates' },
          overrideLon: { type: 'number' },
        },
      },
      SatellitePoint: {
        type: 'object',
        required: ['x', 'y'],
        properties: { x: { type: 'number' }, y: { type: 'number' } },
      },
      SatelliteTrackPoint: {
        type: 'object',
        required: ['ra', 'dec', 'time'],
        properties: { ra: { type: 'number' }, dec: { type: 'number' }, time: { type: 'string', format: 'date-time' } },
      },
      SatelliteCandidate: {
        type: 'object',
        required: ['satellite', 'noradId', 'crossingTimeUTC', 'angularDistanceFromCenter', 'velocityDegPerSec', 'matchScore', 'track', 'duringExposure'],
        properties: {
          satellite:               { type: 'string' },
          noradId:                 { type: 'integer' },
          crossingTimeUTC:         { type: 'string', format: 'date-time' },
          angularDistanceFromCenter: { type: 'number' },
          velocityDegPerSec:       { type: 'number' },
          matchScore:              { type: 'number' },
          track:                   { type: 'array', items: { $ref: '#/components/schemas/SatelliteTrackPoint' } },
          duringExposure:          { type: 'boolean' },
        },
      },
      SatelliteNoTrail: {
        type: 'object',
        required: ['trailDetected'],
        properties: { trailDetected: { type: 'boolean', const: false } },
      },
      SatelliteTrailResult: {
        type: 'object',
        required: ['trailDetected', 'identifyOnly', 'candidates', 'nearMissFallback'],
        properties: {
          trailDetected:  { type: 'boolean', const: true },
          identifyOnly:   { type: 'boolean' },
          angleDegrees:   { type: 'number' },
          lengthPixels:   { type: 'number' },
          midpoint:       { $ref: '#/components/schemas/SatellitePoint' },
          endpoints:      { type: 'array', items: { $ref: '#/components/schemas/SatellitePoint' }, minItems: 2, maxItems: 2 },
          confidence:     { type: 'number' },
          profileWidth:   { type: 'number', description: 'FWHM of the trail in pixels' },
          exposureStart:  { type: 'string', format: 'date-time' },
          exposureSeconds: { type: 'number' },
          candidates:     { type: 'array', items: { $ref: '#/components/schemas/SatelliteCandidate' } },
          nearMissFallback: { type: 'boolean' },
          locationRequired: { type: 'boolean' },
          missingHeaders: { type: 'array', items: { type: 'string' } },
          tleArchiveUnavailable: { type: 'boolean' },
        },
      },
      SatelliteResultsInput: {
        type: 'object',
        required: ['filePaths'],
        properties: { filePaths: { type: 'array', items: { type: 'string' } } },
      },
      SatelliteResults: {
        type: 'object',
        additionalProperties: {
          oneOf: [{ $ref: '#/components/schemas/SatelliteNoTrail' }, { $ref: '#/components/schemas/SatelliteTrailResult' }],
        },
        description: 'File path to its cached result',
      },
      SatelliteCatalogStatus: {
        type: 'object',
        required: ['count', 'lastFetch', 'isStale', 'usingSeed', 'seedEpoch', 'lastError', 'retryInMinutes', 'archiveRange'],
        properties: {
          count:          { type: 'integer' },
          lastFetch:      nullable({ type: 'string', format: 'date-time' }),
          isStale:        { type: 'boolean' },
          usingSeed:      { type: 'boolean' },
          seedEpoch:      { type: 'string' },
          lastError:      nullable({ type: 'string' }),
          retryInMinutes: { type: 'integer' },
          archiveRange: {
            type: 'object',
            required: ['oldest', 'newest', 'count'],
            properties: {
              oldest: nullable({ type: 'string' }),
              newest: nullable({ type: 'string' }),
              count:  { type: 'integer' },
            },
          },
        },
      },
      SatelliteRefreshResult: {
        type: 'object',
        required: ['count', 'refreshed'],
        properties: { count: { type: 'integer' }, refreshed: { type: 'boolean', const: true } },
      },
      SatelliteCacheCleared: {
        type: 'object',
        required: ['cleared'],
        properties: { cleared: { type: 'boolean', const: true } },
      },

      // ── Library: imports and linked sources ──────────────────────────
      LibraryImportSkip: {
        type: 'object',
        required: ['reason', 'label', 'count', 'bytes', 'samples'],
        properties: {
          reason:  { type: 'string', description: 'Skip reason code, e.g. sub-frames-disabled' },
          label:   { type: 'string' },
          count:   { type: 'integer' },
          bytes:   { type: 'integer', description: '0 means not measured' },
          samples: { type: 'array', items: { type: 'string' }, description: 'Up to a few of the skipped names' },
        },
      },
      LibraryImportStatus: {
        type: 'object',
        required: ['running', 'runId', 'currentObject', 'telescopeId', 'telescopeName', 'transportKind', 'objectsTotal', 'objectsDone', 'filesTotal', 'filesDone', 'currentObjectFilesTotal', 'currentObjectFilesDone', 'bytesTotal', 'bytesDone', 'skippedFiles', 'skipped', 'lastRun', 'error', 'cancelled', 'startedAt', 'warmingThumbnails', 'manual'],
        properties: {
          running:          { type: 'boolean' },
          runId:            nullable({ type: 'string' }),
          currentObject:    nullable({ type: 'string' }),
          telescopeId:      nullable({ type: 'string' }),
          telescopeName:    nullable({ type: 'string' }),
          transportKind:    nullable({ type: 'string', enum: ['smb', 'local', 'ftp'] }),
          objectsTotal:     { type: 'integer' },
          objectsDone:      { type: 'integer' },
          filesTotal:       { type: 'integer' },
          filesDone:        { type: 'integer' },
          currentObjectFilesTotal: { type: 'integer' },
          currentObjectFilesDone:  { type: 'integer' },
          bytesTotal:       { type: 'integer' },
          bytesDone:        { type: 'integer' },
          skippedFiles:     { type: 'integer', description: 'Already present locally' },
          filesErrored:     { type: 'integer' },
          skipped:          { type: 'array', items: { $ref: '#/components/schemas/LibraryImportSkip' } },
          lastRun:          nullable({ type: 'string' }),
          error:            nullable({ type: 'string' }),
          cancelled:        { type: 'boolean' },
          startedAt:        nullable({ type: 'string' }),
          warmingThumbnails: nullable({ type: 'object', required: ['done', 'total'], properties: { done: { type: 'integer' }, total: { type: 'integer' } } }),
          manual:           { type: 'boolean' },
          archivedFiles:    { type: 'integer' },
          archivePath:      nullable({ type: 'string' }),
          restackArchivedFiles: { type: 'integer' },
          restackArchivePath:   nullable({ type: 'string' }),
        },
      },
      LibraryImportHistoryEntry: {
        type: 'object',
        required: ['id', 'startedAt', 'finishedAt', 'objectsTotal', 'filesTotal', 'newFiles', 'bytesTotal', 'bytesNew', 'error', 'cancelled', 'files', 'telescopeId', 'telescopeName', 'transportKind', 'skipped', 'manual', 'objectsTouched', 'sessionsTouched'],
        properties: {
          id:            { type: 'integer' },
          startedAt:     { type: 'string' },
          finishedAt:    { type: 'string' },
          objectsTotal:  { type: 'integer' },
          filesTotal:    { type: 'integer' },
          newFiles:      { type: 'integer' },
          bytesTotal:    { type: 'integer' },
          bytesNew:      { type: 'integer' },
          error:         nullable({ type: 'string' }),
          cancelled:     { type: 'boolean' },
          files:         { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
          telescopeId:   nullable({ type: 'string' }),
          telescopeName: nullable({ type: 'string' }),
          transportKind: nullable({ type: 'string', enum: ['smb', 'local', 'ftp'] }),
          skipped:       { oneOf: [{ type: 'array', items: { $ref: '#/components/schemas/LibraryImportSkip' } }, { type: 'null' }] },
          manual:        { type: 'boolean' },
          objectsTouched: { oneOf: [{ type: 'array', items: { type: 'object', required: ['objectId', 'name', 'isNew'], properties: { objectId: { type: 'string' }, name: { type: 'string' }, isNew: { type: 'boolean' } } } }, { type: 'null' }] },
          sessionsTouched: { oneOf: [{ type: 'array', items: { type: 'object', required: ['objectId', 'objectName', 'date', 'isNew'], properties: { objectId: { type: 'string' }, objectName: { type: 'string' }, date: { type: 'string' }, isNew: { type: 'boolean' } } } }, { type: 'null' }] },
        },
      },
      LibraryImportHistory: {
        type: 'object',
        required: ['entries', 'total'],
        properties: {
          entries: { type: 'array', items: { $ref: '#/components/schemas/LibraryImportHistoryEntry' } },
          total:   { type: 'integer' },
        },
      },
      LibraryImportStarted: {
        type: 'object',
        required: ['started', 'objectId', 'telescopeId', 'all'],
        properties: {
          started:     { type: 'boolean', const: true },
          objectId:    nullable({ type: 'string' }),
          telescopeId: nullable({ type: 'string' }),
          all:         { type: 'boolean' },
        },
      },
      LibraryImportScanInput: {
        type: 'object',
        required: ['rootPath'],
        properties: {
          rootPath:        { type: 'string' },
          importSubFrames: { type: 'boolean' },
          importFits:      { type: 'boolean' },
          archiveAllFiles: { type: 'boolean' },
          telescopeId:     nullable({ type: 'string' }),
        },
      },
      LibraryImportScanResult: {
        type: 'object',
        additionalProperties: true,
        description: 'The import plan: objects (each with its catalog match, sessions and files), skipped reasons, excluded folders, totals, and truncated/basePathDetected flags.',
      },
      LibraryImportCommitInput: {
        type: 'object',
        required: ['rootPath', 'objects'],
        properties: {
          rootPath:        { type: 'string' },
          objects: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['folderName', 'targetObjectId', 'targetFolderName', 'sessionMap'],
              properties: {
                folderName:       { type: 'string' },
                skip:             { type: 'boolean' },
                targetObjectId:   { type: 'string' },
                targetFolderName: { type: 'string' },
                sessionMap:       { type: 'object', additionalProperties: { type: ['string', 'null'] } },
              },
            },
          },
          importSubFrames: { type: 'boolean' },
          importFits:      { type: 'boolean' },
          archiveAllFiles: { type: 'boolean' },
          telescopeId:     nullable({ type: 'string' }),
          opticalConfigId: nullable({ type: 'string' }),
        },
      },
      LibraryImportCommitResult: {
        type: 'object',
        required: ['started', 'objects'],
        properties: { started: { type: 'boolean', const: true }, objects: { type: 'integer' } },
      },
      LibraryImportPreflightInput: {
        type: 'object',
        required: ['bytes'],
        properties: { bytes: { type: 'number', minimum: 0 } },
      },
      LibraryImportPreflightResult: {
        type: 'object',
        required: ['ok', 'path', 'freeBytes', 'requiredBytes', 'message'],
        properties: {
          ok:            { type: 'boolean' },
          path:          { type: 'string' },
          freeBytes:     { type: 'integer' },
          requiredBytes: { type: 'integer' },
          message:       { type: 'string' },
        },
      },
      LibraryDebugEventInput: {
        type: 'object',
        required: ['message'],
        properties: { message: { type: 'string', minLength: 1, maxLength: 500 } },
      },
      LibraryDebugEventResult: {
        type: 'object',
        required: ['logged'],
        properties: { logged: { type: 'boolean' } },
      },
      LibraryTempPurgeResult: {
        type: 'object',
        required: ['deleted', 'bytes'],
        properties: { deleted: { type: 'boolean' }, bytes: { type: 'integer' } },
      },
      LibraryUploadTempResult: {
        type: 'object',
        required: ['tmpPath', 'tmpId', 'fileCount'],
        properties: {
          tmpPath:   { type: 'string' },
          tmpId:     { type: 'string' },
          fileCount: { type: 'integer' },
        },
      },
      LibrarySource: {
        type: 'object',
        required: ['id', 'label', 'rootPath', 'fingerprint', 'enabled', 'lastScanAt', 'lastScanStats', 'createdAt', 'importOptions', 'overrides', 'refreshIntervalMin', 'fileCount', 'objectCount', 'bytes', 'missingCount', 'offline'],
        properties: {
          id:                 { type: 'string' },
          label:              { type: 'string' },
          rootPath:           { type: 'string' },
          fingerprint:        nullable({ type: 'string' }),
          enabled:            { type: 'boolean' },
          lastScanAt:         nullable({ type: 'string' }),
          lastScanStats:      nullable({ type: 'string' }),
          createdAt:          { type: 'string' },
          importOptions:      nullable({ type: 'string' }),
          overrides:          nullable({ type: 'string' }),
          refreshIntervalMin: nullable({ type: 'integer' }),
          fileCount:          { type: 'integer' },
          objectCount:        { type: 'integer' },
          bytes:              { type: 'integer' },
          missingCount:       { type: 'integer' },
          offline:            { type: 'boolean' },
        },
      },
      LibrarySources: {
        type: 'object',
        required: ['sources'],
        properties: { sources: { type: 'array', items: { $ref: '#/components/schemas/LibrarySource' } } },
      },
      LibrarySourceScanInput: {
        type: 'object',
        required: ['rootPath'],
        properties: {
          rootPath:        { type: 'string' },
          importSubFrames: { type: 'boolean' },
          importFits:      { type: 'boolean' },
        },
      },
      LibrarySourceScanResult: {
        type: 'object',
        additionalProperties: true,
        description: 'The attribution plan: objects with catalog matches and sessions, unresolved files by folder, skipped reasons, excluded and container folders, disagreements, totals, and truncated/depthLimited flags.',
      },
      LibrarySourceCommitInput: {
        allOf: [{ $ref: '#/components/schemas/LibrarySourceScanInput' }],
        type: 'object',
        required: ['label'],
        properties: {
          label:              { type: 'string', minLength: 1, maxLength: 120 },
          refreshIntervalMin: nullable({ type: 'integer' }),
          analyzeFrames:      { type: 'boolean', description: 'Measure the folder\'s sub-frames during the nightly maintenance.' },
          overrides: {
            type: 'array',
            maxItems: 5000,
            items: {
              oneOf: [
                { type: 'object', required: ['dirPath', 'action', 'objectId'], properties: { dirPath: { type: 'string' }, action: { type: 'string', const: 'assign' }, objectId: { type: 'string' } } },
                { type: 'object', required: ['dirPath', 'action'], properties: { dirPath: { type: 'string' }, action: { type: 'string', const: 'ignore' } } },
              ],
            },
          },
        },
      },
      LibrarySourceCommitResult: {
        type: 'object',
        required: ['sourceId', 'objectsLinked', 'filesLinked', 'filesAlreadyInLibrary'],
        properties: {
          sourceId:              { type: 'string' },
          objectsLinked:         { type: 'integer' },
          filesLinked:           { type: 'integer' },
          filesAlreadyInLibrary: { type: 'integer' },
        },
      },
      LibrarySourceUpdateInput: {
        type: 'object',
        description: 'At least one of label, refreshIntervalMin or analyzeFrames is required.',
        properties: {
          label:              { type: 'string' },
          refreshIntervalMin: nullable({ type: 'integer' }),
          analyzeFrames:      { type: 'boolean', description: 'Measure the folder\'s sub-frames during the nightly maintenance.' },
        },
      },
      LibrarySourceDeleted: {
        type: 'object',
        required: ['filesUnlinked', 'objectsRetired'],
        properties: {
          filesUnlinked:  { type: 'integer' },
          objectsRetired: { type: 'array', items: { type: 'string' } },
        },
      },
      LibrarySourceRescanResult: {
        type: 'object',
        required: ['sourceId', 'offline', 'added', 'updated', 'unchanged', 'missing', 'removed', 'truncated', 'depthLimited', 'objects'],
        properties: {
          sourceId:    { type: 'string' },
          offline:     { type: 'boolean' },
          added:       { type: 'integer' },
          updated:     { type: 'integer' },
          unchanged:   { type: 'integer' },
          missing:     { type: 'integer' },
          removed:     { type: 'integer' },
          truncated:   { type: 'boolean' },
          depthLimited: { type: 'boolean' },
          objects:     { type: 'integer' },
        },
      },
      LibraryLinkedFiles: {
        type: 'object',
        required: ['files', 'bytes', 'folders'],
        properties: {
          files:   { type: 'integer' },
          bytes:   { type: 'integer' },
          folders: { type: 'array', items: { type: 'string' } },
        },
      },
      LibraryRedirect: {
        type: 'object',
        required: ['designation', 'targetObjectId', 'createdAt'],
        properties: {
          designation:    { type: 'string' },
          targetObjectId: { type: 'string' },
          createdAt:      { type: 'string' },
        },
      },
      LibraryRedirects: {
        type: 'object',
        required: ['redirects'],
        properties: { redirects: { type: 'array', items: { $ref: '#/components/schemas/LibraryRedirect' } } },
      },
      LibraryRedirectInput: {
        type: 'object',
        required: ['targetObjectId'],
        properties: { targetObjectId: { type: 'string', minLength: 1 } },
      },

      // ── Library: calibrations ────────────────────────────────────────
      LibraryCalibrationFile: {
        type: 'object',
        required: ['name', 'size', 'modifiedAt', 'path', 'info'],
        properties: {
          name:       { type: 'string' },
          size:       { type: 'integer' },
          modifiedAt: { type: 'string' },
          path:       { type: 'string', description: 'Absolute path on the server' },
          info:       { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
        },
      },
      LibraryCalibrationSettingsGroup: {
        type: 'object',
        required: ['key', 'exposureSec', 'binning', 'gain', 'camera', 'frameType', 'sensorTempC', 'fileCount', 'bytes', 'modifiedAt', 'files', 'capturedAt', 'isExpired'],
        properties: {
          key:         { type: 'string', description: 'Opaque, stable for the same settings' },
          exposureSec: nullable({ type: 'number' }),
          binning:     nullable({ type: 'integer' }),
          gain:        nullable({ type: 'number' }),
          camera:      nullable({ type: 'string' }),
          frameType:   nullable({ type: 'string' }),
          sensorTempC: nullable({ type: 'number' }),
          fileCount:   { type: 'integer' },
          bytes:       { type: 'integer' },
          modifiedAt:  nullable({ type: 'string' }),
          files:       { type: 'array', items: { $ref: '#/components/schemas/LibraryCalibrationFile' } },
          capturedAt:  nullable({ type: 'string' }),
          isExpired:   { type: 'boolean' },
          attachments: { type: 'array', items: { $ref: '#/components/schemas/LibraryCalibrationAttachment' } },
        },
      },
      LibraryCalibrationSubfolder: {
        type: 'object',
        required: ['name', 'fileCount', 'bytes', 'modifiedAt', 'files'],
        properties: {
          name:       { type: 'string' },
          fileCount:  { type: 'integer' },
          bytes:      { type: 'integer' },
          modifiedAt: nullable({ type: 'string' }),
          files:      { type: 'array', items: { $ref: '#/components/schemas/LibraryCalibrationFile' } },
        },
      },
      LibraryCalibrationGroup: {
        type: 'object',
        required: ['type', 'typeLabel', 'folderName', 'scope', 'scopeLabel', 'linked', 'fileCount', 'bytes', 'modifiedAt', 'subfolders', 'settingsGroups'],
        properties: {
          type:         { type: 'string', description: 'bias, dark, flat, flatDark, or mixed' },
          typeLabel:    { type: 'string' },
          folderName:   { type: 'string' },
          scope:        nullable({ type: 'string', description: 'A telescope id, null for the shared bucket, or @src/<sourceId> for a linked folder.' }),
          scopeLabel:   { type: 'string' },
          linked:       { type: 'boolean', description: 'Read in place from a linked folder. It can be browsed, downloaded and used for stacking, but not deleted from Nebulis.' },
          fileCount:    { type: 'integer' },
          bytes:        { type: 'integer' },
          modifiedAt:   nullable({ type: 'string' }),
          subfolders:   { type: 'array', items: { $ref: '#/components/schemas/LibraryCalibrationSubfolder' } },
          settingsGroups: { type: 'array', items: { $ref: '#/components/schemas/LibraryCalibrationSettingsGroup' } },
        },
      },
      LibraryCalibrations: {
        type: 'object',
        required: ['groups'],
        properties: { groups: { type: 'array', items: { $ref: '#/components/schemas/LibraryCalibrationGroup' } } },
      },
      LibraryCalibrationAttachment: {
        type: 'object',
        required: ['id', 'objectId', 'date', 'calibrationType', 'scope', 'folderName', 'settingsKey', 'createdAt'],
        properties: {
          id:              { type: 'string' },
          objectId:        { type: 'string' },
          date:            { type: 'string', description: 'Empty string means the whole object' },
          calibrationType: { type: 'string', enum: ['flat', 'flatDark'] },
          scope:           nullable({ type: 'string' }),
          folderName:      { type: 'string' },
          settingsKey:     { type: 'string' },
          createdAt:       { type: 'string' },
          objectName:      { type: 'string' },
        },
      },
      LibraryCalibrationAttachments: {
        type: 'object',
        required: ['attachments'],
        properties: { attachments: { type: 'array', items: { $ref: '#/components/schemas/LibraryCalibrationAttachment' } } },
      },
      LibraryCalibrationAttachInput: {
        type: 'object',
        required: ['scope', 'folderName', 'key', 'objectId'],
        properties: {
          scope:      nullable({ type: 'string' }),
          folderName: { type: 'string', minLength: 1 },
          key:        { type: 'string', minLength: 1 },
          objectId:   { type: 'string', minLength: 1 },
          date:       { type: 'string', minLength: 1 },
        },
      },
      LibraryCalibrationAttached: {
        type: 'object',
        required: ['attachment'],
        properties: { attachment: { $ref: '#/components/schemas/LibraryCalibrationAttachment' } },
      },
      LibraryCalibrationDetached: {
        type: 'object',
        required: ['detached'],
        properties: { detached: { type: 'boolean', const: true } },
      },
      LibraryCalibrationDeleteInput: {
        type: 'object',
        required: ['scope', 'folderName', 'key'],
        properties: {
          scope:      nullable({ type: 'string' }),
          folderName: { type: 'string', minLength: 1 },
          key:        { type: 'string', minLength: 1 },
        },
      },
      LibraryCalibrationDeleteResult: {
        type: 'object',
        required: ['deleted', 'failed'],
        properties: { deleted: { type: 'integer' }, failed: { type: 'integer' } },
      },
      LibraryVariant: {
        type: 'object',
        required: ['objectId', 'label'],
        properties: { objectId: { type: 'string' }, label: { type: 'string' } },
      },
      LibraryObject: {
        type: 'object',
        required: ['id', 'catalogId', 'folderName', 'name', 'type', 'filterTags', 'constellation', 'description', 'magnitude', 'ra', 'dec', 'distanceLy', 'wikiUrl', 'sizeArcmin', 'hasSubFrames', 'thumbnailUrl', 'hasThumbnail', 'sessionsUrl', 'filesUrl', 'subFramesUrl', 'sessionCount', 'projectArchiveCount', 'lastSessionDate', 'lastImport', 'source', 'isFavorite', 'galleryImage', 'galleryImageUserSet', 'galleryImageVersion', 'galleryCrop', 'primaryTelescopeId', 'telescopeIds', 'aliases', 'nicknames', 'processingStatus', 'variants'],
        properties: {
          id:            { type: 'string' },
          catalogId:     { type: 'string' },
          folderName:    { type: 'string' },
          name:          { type: 'string' },
          type:          { type: 'string' },
          filterTags:    { type: 'array', items: { type: 'string' } },
          constellation: { type: 'string' },
          description:   { type: 'string' },
          magnitude:     nullable({ type: 'number' }),
          ra:            nullable({ type: 'string' }),
          dec:           nullable({ type: 'string' }),
          distanceLy:    nullable({ type: 'number' }),
          wikiUrl:       nullable({ type: 'string' }),
          sizeArcmin:    nullable({ type: 'string' }),
          hasSubFrames:  { type: 'boolean' },
          thumbnailUrl:  { type: 'string' },
          hasThumbnail:  { type: 'boolean' },
          sessionsUrl:   { type: 'string' },
          filesUrl:      { type: 'string' },
          subFramesUrl:  nullable({ type: 'string' }),
          sessionCount:  { type: 'integer' },
          projectArchiveCount: { type: 'integer' },
          lastSessionDate: nullable({ type: 'string' }),
          lastImport:    { type: 'string' },
          source:        { type: 'string', const: 'local' },
          isFavorite:    { type: 'boolean' },
          galleryImage:  nullable({ type: 'string' }),
          galleryImageUserSet: { type: 'boolean' },
          galleryImageVersion: nullable({ type: 'string' }),
          galleryCrop:   { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
          primaryTelescopeId: nullable({ type: 'string' }),
          telescopeIds:  { type: 'array', items: { type: 'string' } },
          aliases:       { type: 'array', items: { type: 'string' } },
          nicknames:     { type: 'array', items: { type: 'string' } },
          processingStatus: { type: 'string' },
          variants:      { type: 'array', items: { $ref: '#/components/schemas/LibraryVariant' } },
        },
      },
      LibrarySession: {
        type: 'object',
        required: ['id', 'date', 'objectId', 'fileCount', 'stackedCount', 'fitsCount', 'subFrameCount', 'imageCount', 'videoCount', 'processedCount', 'thumbnailUrl', 'filesUrl', 'weather', 'telescopeId', 'telescopeName', 'telescopeColor', 'optics', 'rigKey', 'integrationSec', 'framesStacked', 'hasNote', 'filters', 'exposures'],
        properties: {
          id:            { type: 'string' },
          date:          { type: 'string' },
          objectId:      { type: 'string' },
          fileCount:     { type: 'integer' },
          stackedCount:  { type: 'integer' },
          fitsCount:     { type: 'integer' },
          subFrameCount: { type: 'integer' },
          imageCount:    { type: 'integer' },
          videoCount:    { type: 'integer' },
          processedCount: { type: 'integer' },
          thumbnailUrl:  { type: 'string' },
          filesUrl:      { type: 'string' },
          weather:       { oneOf: [{ $ref: '#/components/schemas/ObservationWeather' }, { type: 'null' }] },
          telescopeId:   nullable({ type: 'string' }),
          telescopeName: nullable({ type: 'string' }),
          telescopeColor: nullable({ type: 'string' }),
          optics:        { $ref: '#/components/schemas/ObservationOptics' },
          rigKey:        { type: 'string' },
          integrationSec: nullable({ type: 'number' }),
          framesStacked: nullable({ type: 'integer' }),
          hasNote:       { type: 'boolean' },
          filters:       { type: 'array', items: { type: 'string' } },
          exposures:     { type: 'array', items: { type: 'number' } },
          sourceObjectId: { type: 'string' },
          variantLabel:  nullable({ type: 'string' }),
        },
      },
      LibraryDeletedObject: {
        type: 'object',
        required: ['objectId', 'folderName', 'objectName', 'deletedAt'],
        properties: {
          objectId:   { type: 'string' },
          folderName: { type: 'string' },
          objectName: nullable({ type: 'string' }),
          deletedAt:  nullable({ type: 'string' }),
        },
      },
      LibraryDeletedSession: {
        type: 'object',
        required: ['objectId', 'folderName', 'objectName', 'date', 'deletedAt'],
        properties: {
          objectId:   { type: 'string' },
          folderName: { type: 'string' },
          objectName: nullable({ type: 'string' }),
          date:       { type: 'string' },
          deletedAt:  nullable({ type: 'string' }),
        },
      },
      LibraryDiskLocation: {
        type: 'object',
        required: ['relPath', 'path', 'exists'],
        properties: {
          relPath: { type: 'string' },
          path:    { type: 'string' },
          exists:  { type: 'boolean' },
        },
      },
      LibraryLinkedLocation: {
        type: 'object',
        required: ['sourceId', 'sourceLabel', 'path', 'exists'],
        properties: {
          sourceId:    { type: 'string' },
          sourceLabel: { type: 'string' },
          path:        { type: 'string' },
          exists:      { type: 'boolean' },
        },
      },
      LibraryObjectLocation: {
        type: 'object',
        required: ['storage', 'libraryRoot', 'object', 'session', 'linked'],
        properties: {
          storage:     { type: 'string', enum: ['local', 'network'] },
          libraryRoot: { type: 'string' },
          object:      { $ref: '#/components/schemas/LibraryDiskLocation' },
          session:     { oneOf: [{ $ref: '#/components/schemas/LibraryDiskLocation' }, { type: 'null' }] },
          linked:      { type: 'array', items: { $ref: '#/components/schemas/LibraryLinkedLocation' } },
        },
      },
      LibraryObjectLocationResult: {
        allOf: [{ $ref: '#/components/schemas/LibraryObjectLocation' }],
        type: 'object',
        required: ['variants'],
        properties: {
          variants: {
            type: 'array',
            items: {
              type: 'object',
              required: ['objectId', 'label', 'relPath', 'path', 'exists'],
              properties: {
                objectId: { type: 'string' },
                label:    { type: 'string' },
                relPath:  { type: 'string' },
                path:     { type: 'string' },
                exists:   { type: 'boolean' },
              },
            },
          },
        },
      },
      LibraryBuiltinArt: {
        type: 'object',
        required: ['ids'],
        properties: { ids: { type: 'array', items: { type: 'string' } } },
      },
      LibraryMediaResult: {
        type: 'object',
        additionalProperties: true,
        description: 'The object media, grouped and sorted by the requested kind/group/sort, with favorites resolved.',
      },
      LibraryFitsCard: {
        type: 'object',
        required: ['key', 'value'],
        properties: {
          key:     { type: 'string' },
          value:   { description: 'Header value; string, number or boolean' },
          comment: { type: 'string' },
        },
      },
      LibraryFitsHeader: {
        type: 'object',
        required: ['cards', 'values', 'categorized'],
        properties: {
          cards:  { type: 'array', items: { $ref: '#/components/schemas/LibraryFitsCard' } },
          values: { type: 'object', additionalProperties: true },
          categorized: {
            type: 'object',
            required: ['essential', 'observation', 'coordinates', 'sensor', 'quality', 'other', 'comments'],
            properties: {
              essential:   { type: 'array', items: { $ref: '#/components/schemas/LibraryFitsCard' } },
              observation: { type: 'array', items: { $ref: '#/components/schemas/LibraryFitsCard' } },
              coordinates: { type: 'array', items: { $ref: '#/components/schemas/LibraryFitsCard' } },
              sensor:      { type: 'array', items: { $ref: '#/components/schemas/LibraryFitsCard' } },
              quality:     { type: 'array', items: { $ref: '#/components/schemas/LibraryFitsCard' } },
              other:       { type: 'array', items: { $ref: '#/components/schemas/LibraryFitsCard' } },
              comments:    { type: 'array', items: { $ref: '#/components/schemas/LibraryFitsCard' } },
            },
          },
        },
      },
      LibraryDownloadLink: {
        type: 'object',
        required: ['url', 'expiresInMs'],
        properties: { url: { type: 'string' }, expiresInMs: { type: 'integer' } },
      },
      LibraryDownloadSummary: {
        type: 'object',
        required: ['fileCount', 'totalBytes'],
        properties: { fileCount: { type: 'integer' }, totalBytes: { type: 'integer' } },
      },
      LibraryDownloadStarted: {
        type: 'object',
        required: ['jobId', 'filesTotal'],
        properties: { jobId: { type: 'string' }, filesTotal: { type: 'integer' } },
      },
      LibraryDownloadStatus: {
        type: 'object',
        required: ['status', 'filesTotal', 'filesDone', 'elapsedMs'],
        properties: {
          status:    { type: 'string', enum: ['running', 'done', 'error', 'cancelled'] },
          filesTotal: { type: 'integer' },
          filesDone:  { type: 'integer' },
          elapsedMs:  { type: 'integer' },
          token:      { type: 'string', description: 'Present when done; one-time download token' },
          filename:   { type: 'string' },
          size:       { type: 'integer' },
          error:      { type: 'string' },
        },
      },
      LibrarySubframeFiltersInput: {
        type: 'object',
        required: ['dates'],
        properties: {
          dates:           { type: 'array', minItems: 1, items: { type: 'string' } },
          includeVariants: { type: 'boolean' },
        },
      },
      LibrarySubframesInput: {
        type: 'object',
        required: ['dates'],
        properties: {
          dates:           { type: 'array', minItems: 1, items: { type: 'string' } },
          filters:         { type: 'array', items: { type: 'string' } },
          keptOnly:        { type: 'boolean', description: 'Leave out frames the user rejected or graded bad' },
          includeVariants: { type: 'boolean' },
          sirilLayout:     { type: 'boolean', description: 'Flatten every frame into <object>/lights/' },
        },
      },
      LibrarySubframeFilters: {
        type: 'object',
        required: ['filters'],
        properties: { filters: { type: 'array', items: { type: 'string' } } },
      },
      LibraryGalleryImageResult: {
        type: 'object',
        required: ['objectId', 'galleryImage'],
        properties: {
          objectId:     { type: 'string' },
          galleryImage: nullable({ type: 'string' }),
          galleryCrop:  { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
        },
      },
      LibraryGalleryImageInput: {
        type: 'object',
        properties: {
          imagePath: nullable({ type: 'string' }),
          auto: {
            type: 'boolean',
            description:
              'Clear the user\'s choice and any crop so the object follows the gallery source setting again. Takes precedence over `imagePath`, which is ignored when this is true.',
          },
        },
      },
      LibraryGalleryCropInput: {
        type: 'object',
        required: ['crop'],
        properties: {
          crop: {
            oneOf: [
              { type: 'object', required: ['x', 'y', 'zoom'], properties: { x: { type: 'number' }, y: { type: 'number' }, zoom: { type: 'number' }, rotated: { type: 'boolean' } } },
              { type: 'null' },
            ],
          },
        },
      },
      LibraryGalleryCropResult: {
        type: 'object',
        required: ['objectId', 'galleryCrop'],
        properties: {
          objectId:    { type: 'string' },
          galleryCrop: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
        },
      },
      LibrarySessionImageResult: {
        type: 'object',
        required: ['objectId', 'date', 'sessionImage'],
        properties: {
          objectId:     { type: 'string' },
          date:         { type: 'string' },
          sessionImage: nullable({ type: 'string' }),
        },
      },
      LibrarySessionImageInput: {
        type: 'object',
        properties: { imagePath: nullable({ type: 'string' }) },
      },
      LibraryImageEntry: {
        type: 'object',
        required: ['name', 'path', 'date', 'objectId', 'objectName', 'objectType', 'distanceLy', 'downloadUrl', 'thumbUrl', 'previewUrl', 'isFavorite', 'isProcessed', 'isEdited'],
        properties: {
          name:        { type: 'string' },
          path:        { type: 'string' },
          date:        { type: 'string' },
          objectId:    { type: 'string' },
          objectName:  { type: 'string' },
          objectType:  nullable({ type: 'string' }),
          distanceLy:  nullable({ type: 'number' }),
          downloadUrl: { type: 'string' },
          thumbUrl:    { type: 'string' },
          previewUrl:  { type: 'string' },
          isFavorite:  { type: 'boolean' },
          isProcessed: { type: 'boolean' },
          isEdited:    { type: 'boolean' },
        },
      },
      LibraryAllImages: {
        type: 'object',
        required: ['items', 'total', 'nextOffset'],
        properties: {
          items:      { type: 'array', items: { $ref: '#/components/schemas/LibraryImageEntry' } },
          total:      { type: 'integer' },
          nextOffset: nullable({ type: 'integer' }),
        },
      },
      LibraryFavoriteInput: {
        type: 'object',
        required: ['imagePath'],
        properties: { imagePath: { type: 'string', minLength: 1 } },
      },
      LibraryFavoriteResult: {
        type: 'object',
        required: ['objectId', 'isFavorite'],
        properties: { objectId: { type: 'string' }, isFavorite: { type: 'boolean' } },
      },
      LibraryImageFavoriteResult: {
        type: 'object',
        required: ['imagePath', 'isFavorite'],
        properties: { imagePath: { type: 'string' }, isFavorite: { type: 'boolean' } },
      },
      LibraryProcessedImage: {
        type: 'object',
        required: ['id', 'objectId', 'date', 'filename', 'originalName', 'title', 'notes', 'size', 'mimeType', 'uploadedAt', 'url', 'path', 'thumbUrl', 'previewUrl', 'runId', 'runDates', 'source'],
        properties: {
          id:           { type: 'string' },
          objectId:     { type: 'string' },
          date:         nullable({ type: 'string' }),
          filename:     { type: 'string' },
          originalName: { type: 'string' },
          title:        { type: 'string' },
          notes:        { type: 'string' },
          size:         { type: 'integer' },
          mimeType:     { type: 'string' },
          uploadedAt:   { type: 'string' },
          url:          { type: 'string' },
          path:         { type: 'string' },
          thumbUrl:     nullable({ type: 'string' }),
          previewUrl:   nullable({ type: 'string' }),
          runId:        nullable({ type: 'string' }),
          runDates:     { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
          source:       { type: 'string', description: 'user, dwarf-restack, or another recorded source' },
          isFavorite:   { type: 'boolean' },
          movedOriginal: { type: 'boolean', description: 'Set by the from-file route when the original was moved into the processed folder' },
        },
      },
      LibraryProcessingRun: {
        type: 'object',
        required: ['id', 'objectId', 'title', 'notes', 'software', 'createdAt', 'dates'],
        properties: {
          id:        { type: 'string' },
          objectId:  { type: 'string' },
          title:     { type: 'string' },
          notes:     { type: 'string' },
          software:  { type: 'string' },
          createdAt: { type: 'string' },
          dates:     { type: 'array', items: { type: 'string' } },
        },
      },
      LibraryProcessingRunInput: {
        type: 'object',
        required: ['dates'],
        properties: {
          dates:    { type: 'array', minItems: 1, items: { type: 'string' } },
          title:    { type: 'string' },
          notes:    { type: 'string' },
          software: { type: 'string' },
        },
      },
      LibraryProjectArchive: {
        type: 'object',
        required: ['id', 'objectId', 'filename', 'originalName', 'title', 'notes', 'software', 'size', 'mimeType', 'uploadedAt', 'url', 'path'],
        properties: {
          id:           { type: 'string' },
          objectId:     { type: 'string' },
          filename:     { type: 'string' },
          originalName: { type: 'string' },
          title:        { type: 'string' },
          notes:        { type: 'string' },
          software:     { type: 'string' },
          size:         { type: 'integer' },
          mimeType:     { type: 'string' },
          uploadedAt:   { type: 'string' },
          url:          { type: 'string' },
          path:         { type: 'string' },
        },
      },
      LibraryDeletedId: {
        type: 'object',
        required: ['deleted', 'id'],
        properties: { deleted: { type: 'boolean', const: true }, id: { type: 'string' } },
      },
      LibraryFileDeleted: {
        type: 'object',
        required: ['deleted'],
        properties: { deleted: { type: 'boolean', const: true } },
      },
      LibraryFrameAnalysisResult: {
        type: 'object',
        additionalProperties: true,
        description: 'The night\u2019s frames with their metrics, verdict, review and accepted state, plus the background queue counts.',
      },
      LibraryFrameMeasureInput: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string', minLength: 1 }, force: { type: 'boolean' } },
      },
      LibraryFrameMeasureResult: {
        type: 'object',
        required: ['path', 'metrics', 'cached'],
        properties: {
          path:    { type: 'string' },
          metrics: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
          cached:  { type: 'boolean' },
        },
      },
      LibraryFrameReviewInput: {
        type: 'object',
        required: ['path', 'keep'],
        properties: { path: { type: 'string', minLength: 1 }, keep: nullable({ type: 'boolean' }) },
      },
      LibraryFrameReviewResult: {
        type: 'object',
        required: ['path', 'keep'],
        properties: { path: { type: 'string' }, keep: nullable({ type: 'boolean' }) },
      },
      LibraryFrameQueueInput: {
        type: 'object',
        properties: { includeVariants: { type: 'boolean' }, force: { type: 'boolean' } },
      },
      LibraryFrameQueueResult: {
        type: 'object',
        required: ['queued', 'pending', 'total'],
        properties: { queued: { type: 'integer' }, pending: { type: 'integer' }, total: { type: 'integer' } },
      },
      LibraryStackingExportInput: {
        type: 'object',
        required: ['dates'],
        properties: {
          dates:          { type: 'array', minItems: 1, maxItems: 366, items: { type: 'string', format: 'date' } },
          includeNotKept: { type: 'boolean' },
          layout:         { type: 'string', enum: ['wbpp', 'siril'] },
        },
      },
      LibraryStackingExportPlan: {
        type: 'object',
        additionalProperties: true,
        description: 'The lights and matched calibration that would be exported, with totals and per-night detail.',
      },
      LibraryFileReplaceResult: {
        type: 'object',
        required: ['replaced'],
        properties: { replaced: { type: 'boolean', const: true } },
        additionalProperties: true,
        description: 'Also carries the backup path and whether a linked original was affected.',
      },
      LibraryFileRestoreResult: {
        type: 'object',
        required: ['restored'],
        properties: { restored: { type: 'boolean', const: true } },
        additionalProperties: true,
      },
      LibraryUnmarkResult: {
        type: 'object',
        required: ['id', 'path'],
        properties: { id: { type: 'string' }, path: { type: 'string' } },
      },
      LibraryManualObservationResult: {
        type: 'object',
        additionalProperties: true,
        description: 'The created object and session identifiers, and the image that was filed.',
      },
      LibrarySampleState: {
        type: 'object',
        required: ['object', 'location'],
        properties: { object: { type: 'boolean' }, location: { type: 'boolean' } },
      },
      LibraryReclassifyInput: {
        type: 'object',
        required: ['targetCatalogId'],
        properties: {
          targetCatalogId: { type: 'string', minLength: 1 },
          remember:        { type: 'boolean' },
        },
      },
      LibraryReclassifyResult: {
        type: 'object',
        required: ['mode', 'objectId', 'filesMoved', 'filesLeftBehind'],
        properties: {
          mode:            { type: 'string', enum: ['rename', 'merge'] },
          objectId:        { type: 'string' },
          filesMoved:      { type: 'integer' },
          filesLeftBehind: { type: 'integer' },
        },
      },
      LibraryProcessingStatusInput: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string', description: 'One of PROCESSING_STATUSES' } },
      },
      LibraryProcessingStatusResult: {
        type: 'object',
        required: ['objectId', 'processingStatus'],
        properties: { objectId: { type: 'string' }, processingStatus: { type: 'string' } },
      },
      LibraryObjectFilter: {
        type: 'object',
        required: ['id', 'label', 'matchTypes'],
        properties: {
          id:         { type: 'string' },
          label:      { type: 'string' },
          matchTypes: { type: 'array', items: { type: 'string' } },
          matchMode:  { type: 'string', enum: ['exact', 'contains'] },
        },
      },
      LibraryClusterResult: {
        type: 'object',
        additionalProperties: true,
        description: 'Per-object work done and the best own picture, as the desktop cluster view needs it.',
      },
      LibraryArchivedFolder: {
        type: 'object',
        required: ['name', 'fileCount', 'bytes', 'path'],
        properties: {
          name:      { type: 'string' },
          fileCount: { type: 'integer' },
          bytes:     { type: 'integer' },
          path:      { type: 'string', description: 'Absolute path on the server' },
        },
      },
      LibraryArchiveResult: {
        type: 'object',
        required: ['path', 'folders'],
        properties: {
          path:    { type: 'string' },
          folders: { type: 'array', items: { $ref: '#/components/schemas/LibraryArchivedFolder' } },
        },
      },
      LibraryStackedImage: {
        type: 'object',
        required: ['name', 'path', 'date', 'downloadUrl'],
        properties: {
          name:        { type: 'string' },
          path:        { type: 'string' },
          date:        { type: 'string' },
          downloadUrl: { type: 'string' },
        },
      },
      LibrarySessionMoveInput: {
        type: 'object',
        required: ['toObjectId'],
        properties: { toObjectId: { type: 'string', minLength: 1 } },
      },
      LibrarySessionMoveResult: {
        type: 'object',
        required: ['moved', 'fromObjectId', 'toObjectId', 'date'],
        properties: {
          moved:        { type: 'integer' },
          fromObjectId: { type: 'string' },
          toObjectId:   { type: 'string' },
          date:         { type: 'string' },
        },
      },
      LibraryTelescopeInput: {
        type: 'object',
        required: ['telescopeId'],
        properties: { telescopeId: { type: 'string', minLength: 1 } },
      },
      LibraryOpticsInput: {
        type: 'object',
        required: ['opticalConfigId'],
        properties: { opticalConfigId: nullable({ type: 'string', minLength: 1 }) },
      },
      LibrarySiteInput: {
        type: 'object',
        required: ['siteId'],
        properties: { siteId: nullable({ type: 'string' }) },
      },
      LibrarySessionUpdated: {
        type: 'object',
        required: ['updated'],
        properties: {
          updated:          { type: 'boolean', const: true },
          telescopeId:      nullable({ type: 'string' }),
          opticalConfigId:  nullable({ type: 'string' }),
          siteId:           nullable({ type: 'string' }),
        },
      },
      LibrarySyncStarted: {
        type: 'object',
        required: ['started'],
        properties: {
          started:     { type: 'boolean', const: true },
          objectId:    { type: 'string' },
          date:        { type: 'string' },
          telescopeId: nullable({ type: 'string' }),
        },
      },
      LibrarySessionSubframesDeleted: {
        type: 'object',
        required: ['deleted', 'objectId', 'date'],
        properties: {
          deleted:  { type: 'integer' },
          objectId: { type: 'string' },
          date:     { type: 'string' },
        },
      },
      LibraryRestored: {
        type: 'object',
        required: ['restored'],
        properties: {
          restored: { type: 'boolean', const: true },
          objectId: { type: 'string' },
          date:     { type: 'string' },
        },
      },
      LibraryObjectDeleted: {
        type: 'object',
        required: ['deleted', 'objectId'],
        properties: { deleted: { type: 'boolean', const: true }, objectId: { type: 'string' } },
      },
      LibraryCalibrationLinkResult: {
        type: 'object',
        required: ['url', 'filename', 'expiresInMs'],
        properties: {
          url:         { type: 'string' },
          filename:    { type: 'string' },
          expiresInMs: { type: 'integer' },
        },
      },

      AltitudeCurvePoint: {
        type: 'object',
        properties: {
          time: isoDate,
          alt:  { type: 'number', description: 'Altitude in degrees' },
          az:   { type: 'number', description: 'Azimuth in degrees, 0=N clockwise' },
        },
      },

      // Wishlist
      WishlistItem: {
        type: 'object',
        properties: {
          id:              strEx('uuid'),
          objectId:        strEx('M31'),
          name:            strEx('Andromeda Galaxy'),
          type:            strEx('Spiral Galaxy'),
          constellation:   nullable(strEx('Andromeda')),
          magnitude:       nullable({ type: 'number', example: 3.4 }),
          majorAxisArcmin: nullable({ type: 'number', example: 192.4 }),
          priority:        { type: 'string', enum: [...WISHLIST_PRIORITIES], default: 'medium' },
          notes:           { type: 'string', default: '' },
          addedAt:         isoDate,
        },
      },

      // Integration / session report
      IntegrationStats: {
        type: 'object',
        properties: {
          objectId:        strEx('M42'),
          totalFrames:     { type: 'integer' },
          totalExposureSec: { type: 'integer' },
          totalFormatted:  strEx('3h 12m'),
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date:        isoDateD,
                frames:      { type: 'integer' },
                exposureSec: { type: 'number' },
              },
            },
          },
        },
      },

      IntegrationGoal: {
        type: 'object',
        properties: {
          filter:  nullable(strEx('Ha')),
          goalSec: { type: 'integer', example: 36000 },
        },
      },
      IntegrationBreakdown: {
        type: 'object',
        properties: {
          objectId:         strEx('Sh2-105'),
          totalFrames:      { type: 'integer' },
          totalExposureSec: { type: 'integer' },
          unreadableFrames: { type: 'integer' },
          filters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                filter:      nullable(strEx('OIII')),
                frames:      { type: 'integer' },
                exposureSec: { type: 'integer' },
                goalSec:     nullable({ type: 'integer' }),
                nights: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      date:        strEx('2026-09-20'),
                      frames:      { type: 'integer' },
                      exposureSec: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      FilterAlias: {
        type: 'object',
        properties: {
          alias:     strEx('H-alpha 7nm'),
          canonical: strEx('Ha'),
        },
      },

      // Storage
      StorageObject: {
        type: 'object',
        properties: {
          id:            strEx('M42'),
          name:          strEx('Orion Nebula'),
          totalSize:     { type: 'integer', description: 'Bytes' },
          fileCount:     { type: 'integer' },
          subFrameCount: { type: 'integer' },
          subFrameSize:  { type: 'integer' },
          imageCount:    { type: 'integer' },
          fitsCount:     { type: 'integer' },
          oldestFile:    nullable(isoDateD),
          newestFile:    nullable(isoDateD),
        },
      },

      SystemStorage: {
        type: 'object',
        properties: {
          disk: {
            nullable: true,
            type: 'object',
            properties: {
              total:          { type: 'integer', description: 'Bytes' },
              used:           { type: 'integer' },
              free:           { type: 'integer' },
              usedPercent:    { type: 'integer', minimum: 0, maximum: 100 },
              totalFormatted: strEx('500.00 GB'),
              usedFormatted:  strEx('200.0 GB'),
              freeFormatted:  strEx('300.0 GB'),
            },
          },
          dataDir: {
            type: 'object',
            properties: {
              path:          strEx('/app/data'),
              size:          { type: 'integer', description: 'Bytes' },
              files:         { type: 'integer' },
              sizeFormatted: strEx('1.2 GB'),
            },
          },
        },
      },

      // Telescope profile & status
      TelescopeProfile: jsonSchemaOf(TelescopeProfileResponseSchema),
      TelescopeProfileListItem: jsonSchemaOf(TelescopeProfileListItemResponseSchema),
      TelescopeProfileInput: jsonSchemaOf(TelescopeProfileBodySchema, 'input'),
      TelescopeTransport: jsonSchemaOf(TelescopeTransportResponseSchema),
      TelescopeTransportInput: jsonSchemaOf(TransportBodySchema, 'input'),
      TelescopeOpticalConfig: jsonSchemaOf(TelescopeOpticalConfigResponseSchema),
      TelescopeOpticalConfigInput: jsonSchemaOf(OpticalConfigBodySchema, 'input'),
      TelescopeRig: jsonSchemaOf(TelescopeRigResponseSchema),
      TelescopeRigInput: jsonSchemaOf(RigBodySchema, 'input'),
      TelescopeReassignInput: jsonSchemaOf(ReassignBodySchema, 'input'),
      TelescopeTestConnectionInput: jsonSchemaOf(TestConnectionBodySchema, 'input'),
      TelescopeProbeIdentityInput: jsonSchemaOf(ProbeIdentityBodySchema, 'input'),

      // Alerts — generated from the same Zod schemas the routes validate with.
      AlertChannel: jsonSchemaOf(AlertChannelSchema),
      AlertChannelInput: jsonSchemaOf(AlertChannelBodySchema, 'input'),
      AlertChannelPatch: jsonSchemaOf(AlertChannelPatchSchema, 'input'),
      AlertDevice: jsonSchemaOf(AlertDeviceSchema),
      AlertDeviceRegistration: jsonSchemaOf(AlertDeviceRegistrationSchema, 'input'),
      AlertDevicePatch: jsonSchemaOf(AlertDevicePatchSchema, 'input'),
      AlertConfig: jsonSchemaOf(AlertConfigSchema),
      AlertConfigInput: jsonSchemaOf(AlertConfigBodySchema, 'input'),
      AlertDetails: jsonSchemaOf(AlertDetailsSchema),
      AlertDeliveryResult: jsonSchemaOf(AlertDeliveryResultSchema),
      AlertChannelTestResult: jsonSchemaOf(AlertChannelTestResultSchema),
      AlertDeviceTestResult: jsonSchemaOf(AlertDeviceTestResultSchema),
      AlertDewForecast: jsonSchemaOf(AlertDewForecastSchema),
      AlertTonightPlan: jsonSchemaOf(AlertTonightPlanSchema),
      AlertClearNightData: jsonSchemaOf(AlertClearNightDataSchema),
      AlertClearNightCheck: jsonSchemaOf(AlertClearNightCheckSchema),
      AlertNextClearNightCheck: jsonSchemaOf(AlertNextClearNightCheckSchema),
      AlertOverview: jsonSchemaOf(AlertOverviewSchema),
      AlertPushInfo: jsonSchemaOf(AlertPushInfoSchema),
      AlertPhoneFailure: jsonSchemaOf(AlertPhoneFailureSchema),
      AlertPhonesResult: jsonSchemaOf(AlertPhonesResultSchema),
      AlertDewPhonesResult: jsonSchemaOf(AlertDewPhonesResultSchema),
      AlertDeleted: jsonSchemaOf(AlertDeletedSchema),

      // Auth, generated from the same Zod schemas the routes validate with.
      AuthToken: jsonSchemaOf(AuthTokenSchema),
      AuthUser: jsonSchemaOf(AuthUserSchema),
      AuthRegisterInput: jsonSchemaOf(AuthRegisterBodySchema, 'input'),
      AuthLoginInput: jsonSchemaOf(AuthLoginBodySchema, 'input'),
      AuthCreateUserInput: jsonSchemaOf(AuthCreateUserBodySchema, 'input'),
      AuthPasswordInput: jsonSchemaOf(AuthPasswordBodySchema, 'input'),
      AuthProfileInput: jsonSchemaOf(AuthProfileBodySchema, 'input'),
      AuthRoleInput: jsonSchemaOf(AuthRoleBodySchema, 'input'),
      AuthStatus: jsonSchemaOf(AuthStatusSchema),
      AuthUpdated: jsonSchemaOf(AuthUpdatedSchema),

      // Settings sub-routes, generated from the same Zod schemas the routes validate with.
      SettingsApiKeyCreateInput: jsonSchemaOf(SettingsApiKeyCreateBodySchema, 'input'),
      SettingsApiKeySummary: jsonSchemaOf(SettingsApiKeySummarySchema),
      SettingsApiKeyOwner: jsonSchemaOf(SettingsApiKeyOwnerSchema),
      SettingsApiKeyCreated: jsonSchemaOf(SettingsApiKeyCreatedSchema),
      SettingsApiKeyRevoked: jsonSchemaOf(SettingsApiKeyRevokedSchema),
      SettingsResetDatabaseInput: jsonSchemaOf(SettingsResetDatabaseBodySchema, 'input'),
      SettingsResetResult: jsonSchemaOf(SettingsResetResultSchema),
      SettingsNightlyStarted: jsonSchemaOf(SettingsNightlyStartedSchema),
      SettingsDebugLogState: jsonSchemaOf(SettingsDebugLogStateSchema),
      SettingsDebugLogStatus: jsonSchemaOf(SettingsDebugLogStatusSchema),

      // Small routers documented by hand: they read typed lib results rather
      // than validating request bodies with Zod.
      SystemLogEntry: {
        type: 'object',
        required: ['id', 'createdAt', 'category', 'event', 'level', 'message', 'userId', 'username', 'ip', 'metadata'],
        properties: {
          id:        { type: 'integer' },
          createdAt: { type: 'integer', description: 'Unix ms' },
          category:  { type: 'string', enum: [...SYSTEM_LOG_CATEGORIES] },
          event:     { type: 'string' },
          level:     { type: 'string', enum: [...SYSTEM_LOG_LEVELS] },
          message:   { type: 'string' },
          userId:    nullable({ type: 'string' }),
          username:  nullable({ type: 'string' }),
          ip:        nullable({ type: 'string' }),
          metadata:  nullable({ type: 'object', additionalProperties: true }),
        },
      },
      SystemLogPage: {
        type: 'object',
        required: ['entries', 'total'],
        properties: {
          entries: { type: 'array', items: { $ref: '#/components/schemas/SystemLogEntry' } },
          total:   { type: 'integer' },
        },
      },
      SystemLogCleared: {
        type: 'object',
        required: ['cleared'],
        properties: { cleared: { type: 'boolean', const: true } },
      },
      WishlistDeleted: {
        type: 'object',
        required: ['deleted'],
        properties: { deleted: { type: 'boolean', description: 'False when no wishlist entry matched' } },
      },
      ForecastHour: {
        type: 'object',
        required: ['time', 'cloudCover', 'cloudCoverLow', 'cloudCoverMid', 'cloudCoverHigh', 'seeing', 'transparency', 'humidity', 'temperature', 'dewPoint', 'wind', 'visibility', 'precipProb', 'jetStream', 'cape'],
        properties: {
          time:            { type: 'string', format: 'date-time' },
          cloudCover:      { type: 'number', minimum: 0, maximum: 100 },
          cloudCoverLow:   { type: 'number', minimum: 0, maximum: 100 },
          cloudCoverMid:   { type: 'number', minimum: 0, maximum: 100 },
          cloudCoverHigh:  { type: 'number', minimum: 0, maximum: 100 },
          seeing:          nullable({ type: 'number', description: '1 best to 5' }),
          transparency:    nullable({ type: 'number', description: '1 to 8' }),
          humidity:        { type: 'number' },
          temperature:     { type: 'number', description: 'Degrees C' },
          dewPoint:        { type: 'number' },
          wind:            { type: 'number', description: 'km/h' },
          visibility:      nullable({ type: 'number' }),
          precipProb:      { type: 'number', minimum: 0, maximum: 100 },
          jetStream:       nullable({ type: 'number', description: '500 hPa wind, km/h' }),
          cape:            nullable({ type: 'number', description: 'Convective available potential energy, J/kg' }),
        },
      },
      ForecastAstro: {
        type: 'object',
        required: ['moonIllumination', 'moonPhase', 'moonRise', 'moonSet', 'sunset', 'sunrise', 'astronomicalTwilightEnd', 'astronomicalTwilightStart', 'nauticalTwilightEnd', 'nauticalTwilightStart', 'darkHours', 'nauticalDarkHours'],
        properties: {
          moonIllumination:        { type: 'number', minimum: 0, maximum: 100 },
          moonPhase:               { type: 'string' },
          moonRise:                nullable({ type: 'string', format: 'date-time' }),
          moonSet:                 nullable({ type: 'string', format: 'date-time' }),
          sunset:                  { type: 'string', format: 'date-time' },
          sunrise:                 { type: 'string', format: 'date-time' },
          astronomicalTwilightEnd:   { type: 'string', format: 'date-time', description: 'Empty when it never occurs' },
          astronomicalTwilightStart: { type: 'string', format: 'date-time', description: 'Empty when it never occurs' },
          nauticalTwilightEnd:       { type: 'string', format: 'date-time' },
          nauticalTwilightStart:     { type: 'string', format: 'date-time' },
          darkHours:               { type: 'number' },
          nauticalDarkHours:       { type: 'number' },
          imagingWindow: nullable({
            type: 'object',
            description: "Tonight's imaging window for the requested site: the twilight and offsets from the site's settings applied to the twilight times above. Null when those settings leave no window tonight. Absent on older servers, which means the astronomical night (else nautical).",
            required: ['start', 'end', 'darkness', 'startOffsetMin', 'endOffsetMin'],
            properties: {
              start:          { type: 'string', format: 'date-time' },
              end:            { type: 'string', format: 'date-time' },
              darkness:       { type: 'string', enum: ['astronomical', 'nautical'], description: 'The twilight actually used; astronomical falls back to nautical where the Sun never gets 18 degrees down' },
              startOffsetMin: { type: 'integer', description: 'Minutes after dusk the window opens, as set on the site' },
              endOffsetMin:   { type: 'integer', description: 'Minutes before dawn the window closes, as set on the site' },
            },
          }),
        },
      },
      ForecastNightRating: {
        type: 'object',
        required: ['date', 'score', 'rating', 'avgCloudCover', 'avgHumidity', 'avgWind', 'precipChance', 'confidence'],
        properties: {
          date:          { type: 'string', format: 'date' },
          score:         { type: 'number', minimum: 0, maximum: 100 },
          rating:        { type: 'string', enum: ['Ideal', 'Great', 'Good', 'Fair', 'Poor', 'Bad'] },
          avgCloudCover: { type: 'number', minimum: 0, maximum: 100 },
          avgHumidity:   { type: 'number' },
          avgWind:       { type: 'number' },
          precipChance:  { type: 'number', minimum: 0, maximum: 100 },
          confidence:    { type: 'string', enum: ['normal', 'low'] },
        },
      },
      ForecastResponse: {
        type: 'object',
        required: ['location', 'timezone', 'units', 'hourly', 'tonight', 'nightRatings', 'sources'],
        properties: {
          location: {
            type: 'object',
            required: ['lat', 'lon'],
            properties: { lat: { type: 'number' }, lon: { type: 'number' } },
          },
          timezone: { type: 'string' },
          units: {
            type: 'object',
            required: ['temperature', 'wind'],
            properties: {
              temperature: { type: 'string', enum: [...TEMPERATURE_UNITS] },
              wind:        { type: 'string', enum: [...WIND_SPEED_UNITS] },
            },
          },
          hourly:      { type: 'array', items: { $ref: '#/components/schemas/ForecastHour' } },
          tonight:     { $ref: '#/components/schemas/ForecastAstro' },
          nightRatings: { type: 'array', items: { $ref: '#/components/schemas/ForecastNightRating' } },
          sources: {
            type: 'object',
            required: ['weather', 'seeing'],
            properties: {
              weather: nullable({ type: 'string', enum: ['open-meteo'] }),
              seeing:  nullable({ type: 'string', enum: ['7timer'] }),
            },
          },
        },
      },
      ForecastOutlookModel: {
        type: 'object',
        required: ['model', 'label', 'members', 'clearMembers', 'clearProbability'],
        properties: {
          model: { type: 'string' },
          label: { type: 'string' },
          members: { type: 'integer', minimum: 0 },
          clearMembers: { type: 'integer', minimum: 0 },
          clearProbability: nullable({ type: 'number', minimum: 0, maximum: 1 }),
        },
      },
      ForecastOutlookNight: {
        type: 'object',
        required: ['date', 'darkStart', 'darkEnd', 'darkHours', 'members', 'clearMembers', 'clearProbability', 'cloudMedian', 'cloudP25', 'cloudP75', 'moonIllumination', 'moonUpAtMidnight', 'models'],
        properties: {
          date: { type: 'string', description: 'Observing night, YYYY-MM-DD (the date of the evening)' },
          darkStart: { type: 'string', format: 'date-time' },
          darkEnd: { type: 'string', format: 'date-time' },
          darkHours: { type: 'number' },
          members: { type: 'integer', minimum: 0, description: 'Model runs that cover the night, all models together' },
          clearMembers: { type: 'integer', minimum: 0 },
          clearProbability: nullable({ type: 'number', minimum: 0, maximum: 1 }),
          cloudMedian: nullable({ type: 'number', description: 'Mean cloud cover over the window, median across runs (%)' }),
          cloudP25: nullable({ type: 'number' }),
          cloudP75: nullable({ type: 'number' }),
          moonIllumination: { type: 'number', minimum: 0, maximum: 100 },
          moonUpAtMidnight: { type: 'boolean' },
          models: { type: 'array', items: { $ref: '#/components/schemas/ForecastOutlookModel' } },
        },
      },
      ForecastOutlook: {
        type: 'object',
        required: ['nights', 'thresholds', 'timeZone', 'models', 'source', 'fetchedAt'],
        properties: {
          nights: { type: 'array', items: { $ref: '#/components/schemas/ForecastOutlookNight' } },
          thresholds: {
            type: 'object',
            required: ['maxCloudCover', 'minClearHours'],
            properties: { maxCloudCover: { type: 'number' }, minClearHours: { type: 'number' } },
          },
          timeZone: { type: 'string' },
          models: {
            type: 'array',
            items: {
              type: 'object',
              required: ['model', 'label', 'members'],
              properties: { model: { type: 'string' }, label: { type: 'string' }, members: { type: 'integer', minimum: 0 } },
            },
          },
          source: { type: 'string', enum: ['open-meteo-ensemble'] },
          fetchedAt: { type: 'string', format: 'date-time' },
        },
      },
      // Gear and journal, generated from the same Zod schemas the routes validate with.
      GearItem: jsonSchemaOf(GearItemResponseSchema),
      GearItemInput: jsonSchemaOf(ItemCreateSchema, 'input'),
      GearItemPatch: jsonSchemaOf(ItemPatchSchema, 'input'),
      GearKit: jsonSchemaOf(GearKitResponseSchema),
      GearKitInput: jsonSchemaOf(KitSchema, 'input'),
      GearKitPatch: jsonSchemaOf(KitPatchSchema, 'input'),
      GearKitCheckInput: jsonSchemaOf(CheckSchema, 'input'),
      JournalEntry: jsonSchemaOf(JournalEntryResponseSchema),
      JournalAttachment: jsonSchemaOf(JournalAttachmentResponseSchema),
      JournalEntryInput: jsonSchemaOf(EntryCreateSchema, 'input'),
      JournalEntryPatch: jsonSchemaOf(EntryPatchSchema, 'input'),
      LibraryImportInput: jsonSchemaOf(ImportBodySchema, 'input'),

      // Notes, generated from the same Zod schemas the routes validate with.
      ObservationNote: jsonSchemaOf(ObservationNoteSchema),
      NoteInput: jsonSchemaOf(NoteBodySchema, 'input'),
      NoteUpdateInput: jsonSchemaOf(NoteUpdateBodySchema, 'input'),
      ObjectNote: jsonSchemaOf(ObjectNoteSchema),
      ObjectNoteInput: jsonSchemaOf(ObjectNoteBodySchema, 'input'),
      NoteDeleted: {
        type: 'object',
        required: ['deleted'],
        properties: { deleted: { type: 'boolean', const: true } },
      },

      // Version and update metadata.
      MetaVersion: {
        type: 'object',
        required: ['version', 'shortVersion', 'build'],
        properties: {
          version:      strEx('2.2.0'),
          shortVersion: strEx('2.2'),
          build:        { type: 'integer' },
        },
      },
      MetaChangelogEntry: {
        type: 'object',
        required: ['version', 'build', 'date', 'sections'],
        properties: {
          version: strEx('2.2.0'),
          build:   { type: 'integer' },
          date:    strEx('November 1, 2026'),
          sections: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
            description: 'Section title to its bullet lines, e.g. "New" and "Fixes"',
          },
        },
      },
      MetaUpdateStatus: {
        type: 'object',
        required: ['platform', 'channel', 'autoUpdateEnabled', 'currentVersion', 'currentBuild', 'latestVersion', 'latestBuild', 'updateAvailable', 'mandatory', 'notesUrl', 'staged', 'applyRequested', 'lastCheckedAt', 'lastError'],
        properties: {
          platform:          nullable({ type: 'string', description: 'Null on a non-desktop build' }),
          channel:           { type: 'string' },
          autoUpdateEnabled: { type: 'boolean' },
          currentVersion:    { type: 'string' },
          currentBuild:      { type: 'integer' },
          latestVersion:     nullable({ type: 'string' }),
          latestBuild:       nullable({ type: 'integer' }),
          updateAvailable:   { type: 'boolean' },
          mandatory:         { type: 'boolean' },
          notesUrl:          nullable({ type: 'string' }),
          staged:            { type: 'boolean', description: 'A verified installer is on disk and ready' },
          applyRequested:    { type: 'boolean' },
          lastCheckedAt:     nullable({ type: 'integer', description: 'Unix ms' }),
          lastError:         nullable({ type: 'string' }),
        },
      },
      MetaUpdateStatusFull: {
        type: 'object',
        required: ['platform', 'channel', 'currentVersion', 'latestVersion', 'latestBuild', 'updateAvailable', 'mandatory', 'notesUrl', 'staged', 'stagedPath', 'stagedSha256', 'applyRequested', 'lastCheckedAt', 'lastError'],
        properties: {
          platform:        nullable({ type: 'string' }),
          channel:         { type: 'string' },
          currentVersion:  { type: 'string' },
          latestVersion:   nullable({ type: 'string' }),
          latestBuild:     nullable({ type: 'integer' }),
          updateAvailable: { type: 'boolean' },
          mandatory:       { type: 'boolean' },
          notesUrl:        nullable({ type: 'string' }),
          staged:          { type: 'boolean' },
          stagedPath:      nullable({ type: 'string' }),
          stagedSha256:    nullable({ type: 'string' }),
          applyRequested:  { type: 'boolean' },
          lastCheckedAt:   nullable({ type: 'integer', description: 'Unix ms' }),
          lastError:       nullable({ type: 'string' }),
        },
      },
      MetaUpdateApplied: {
        type: 'object',
        required: ['applyRequested', 'version'],
        properties: {
          applyRequested: { type: 'boolean', const: true },
          version:        nullable({ type: 'string' }),
        },
      },
      PreferencesWatermarkPreset: jsonSchemaOf(WatermarkPresetSchema),
      PreferencesWatermarksInput: jsonSchemaOf(WatermarkPresetsBodySchema, 'input'),
      PreferencesLastSeenVersion: {
        type: 'object',
        required: ['lastSeenVersion'],
        properties: { lastSeenVersion: nullable({ type: 'string' }) },
      },
      PreferencesLastSeenVersionInput: jsonSchemaOf(LastSeenVersionBodySchema, 'input'),
      PreferencesSupportAsk: {
        type: 'object',
        required: ['seenAt'],
        properties: { seenAt: nullable({ type: 'string', format: 'date-time' }) },
      },

      // Device pairing and connected devices.
      PairStartBody: {
        type: 'object',
        properties: { tvName: { type: 'string', maxLength: 80, description: 'Defaults to TV' } },
      },
      PairStartResult: {
        type: 'object',
        required: ['userCode', 'userCodeFormatted', 'deviceCode', 'expiresAt', 'pollIntervalSec'],
        properties: {
          userCode:          { type: 'string' },
          userCodeFormatted: { type: 'string' },
          deviceCode:        { type: 'string', description: 'Only for the polling client' },
          expiresAt:         { type: 'integer', description: 'Unix ms' },
          pollIntervalSec:   { type: 'integer' },
        },
      },
      PairPollResult: {
        oneOf: [
          { type: 'object', required: ['status'], properties: { status: { type: 'string', const: 'pending' } } },
          { type: 'object', required: ['status'], properties: { status: { type: 'string', const: 'expired' } } },
          { type: 'object', required: ['status'], properties: { status: { type: 'string', const: 'rejected' } } },
          {
            type: 'object',
            required: ['status', 'token', 'deviceId', 'user'],
            properties: {
              status:   { type: 'string', const: 'approved' },
              token:    { type: 'string' },
              deviceId: { type: 'string' },
              user: {
                type: 'object',
                required: ['id', 'username', 'displayName', 'role'],
                properties: {
                  id:          { type: 'string' },
                  username:    { type: 'string' },
                  displayName: { type: 'string' },
                  role:        { type: 'string', enum: ['admin', 'viewer'] },
                },
              },
            },
          },
        ],
      },
      PairQrBody: {
        type: 'object',
        properties: {
          origin:     { type: 'string', description: 'The URL the browser is using' },
          deviceName: { type: 'string', maxLength: 80, description: 'Defaults to Phone' },
        },
      },
      PairQrResult: {
        type: 'object',
        required: ['qrDataUrl', 'url', 'deviceCode', 'expiresAt', 'pollIntervalSec'],
        properties: {
          qrDataUrl:       { type: 'string', description: 'data: URL for the QR image' },
          url:             { type: 'string' },
          deviceCode:      { type: 'string' },
          expiresAt:       { type: 'integer', description: 'Unix ms' },
          pollIntervalSec: { type: 'integer' },
        },
      },
      PairQrStatus: {
        type: 'object',
        required: ['status'],
        properties: {
          status:     { type: 'string', enum: ['waiting', 'connected', 'expired'] },
          deviceName: { type: 'string' },
        },
      },
      PairLookup: {
        type: 'object',
        required: ['tvName', 'expiresAt'],
        properties: {
          tvName:    { type: 'string' },
          expiresAt: { type: 'integer', description: 'Unix ms' },
        },
      },
      PairApproveBody: {
        type: 'object',
        required: ['userCode'],
        properties: { userCode: { type: 'string' } },
      },
      PairApproveResult: {
        type: 'object',
        required: ['tvName'],
        properties: { tvName: { type: 'string' } },
      },
      ConnectedDevice: {
        type: 'object',
        required: ['id', 'name', 'createdAt', 'lastSeenAt'],
        properties: {
          id:         { type: 'string' },
          name:       { type: 'string' },
          createdAt:  { type: 'integer', description: 'Unix ms' },
          lastSeenAt: { type: 'integer', description: 'Unix ms' },
        },
      },
      ConnectedDeviceWithOwner: {
        allOf: [{ $ref: '#/components/schemas/ConnectedDevice' }],
        type: 'object',
        required: ['userId', 'ownerUsername', 'ownerDisplayName'],
        properties: {
          userId:          { type: 'string' },
          ownerUsername:   nullable({ type: 'string' }),
          ownerDisplayName: nullable({ type: 'string' }),
        },
      },
      DeviceRenamed: {
        type: 'object',
        required: ['renamed'],
        properties: { renamed: { type: 'boolean', const: true } },
      },
      DeviceRevoked: {
        type: 'object',
        required: ['revoked'],
        properties: { revoked: { type: 'boolean', const: true } },
      },
      DeviceRenameBody: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', maxLength: 80 } },
      },

      // Observing catalog progress and walls.
      CatalogImagedVia: {
        type: 'object',
        required: ['objectId', 'name', 'sepDeg'],
        properties: {
          objectId: { type: 'string' },
          name:     { type: 'string' },
          sepDeg:   { type: 'number', description: 'Separation from the host, degrees' },
        },
      },
      CatalogProgressObject: {
        type: 'object',
        required: ['number', 'id', 'ngcName', 'name', 'type', 'typeClass', 'constellation', 'magnitude', 'majorAxisArcmin', 'ra', 'dec', 'isImaged', 'libraryObjectId', 'sessionCount', 'imagedVia'],
        properties: {
          number:      nullable({ type: 'integer' }),
          id:          { type: 'string' },
          ngcName:     nullable({ type: 'string' }),
          name:        { type: 'string' },
          type:        { type: 'string' },
          typeClass:   { type: 'string', enum: ['galaxy', 'nebula', 'cluster', 'other'] },
          constellation: nullable({ type: 'string' }),
          magnitude:   nullable({ type: 'number' }),
          majorAxisArcmin: nullable({ type: 'number' }),
          ra:          nullable({ type: 'number', description: 'Decimal hours' }),
          dec:         nullable({ type: 'number', description: 'Decimal degrees' }),
          isImaged:    { type: 'boolean' },
          libraryObjectId: nullable({ type: 'string' }),
          sessionCount: { type: 'integer' },
          imagedVia:   { oneOf: [{ type: 'array', items: { $ref: '#/components/schemas/CatalogImagedVia' } }, { type: 'null' }] },
        },
      },
      CatalogProgress: {
        type: 'object',
        required: ['catalog', 'label', 'total', 'imagedCount', 'imagedInFrameCount', 'byType', 'objects'],
        properties: {
          catalog:            { type: 'string' },
          label:              { type: 'string' },
          total:              { type: 'integer' },
          imagedCount:        { type: 'integer' },
          imagedInFrameCount: { type: 'integer' },
          byType: {
            type: 'object',
            required: ['galaxy', 'nebula', 'cluster', 'other'],
            properties: Object.fromEntries(
              ['galaxy', 'nebula', 'cluster', 'other'].map(k => [k, {
                type: 'object',
                required: ['imaged', 'total'],
                properties: { imaged: { type: 'integer' }, total: { type: 'integer' } },
              }]),
            ),
          },
          objects: { type: 'array', items: { $ref: '#/components/schemas/CatalogProgressObject' } },
        },
      },
      BestImagingWindow: {
        type: 'object',
        required: ['months', 'windowStart', 'windowEnd', 'everVisible', 'upTonight'],
        properties: {
          months: {
            type: 'array',
            items: {
              type: 'object',
              required: ['label', 'maxAlt', 'aboveMinAlt'],
              properties: {
                label:      { type: 'string' },
                maxAlt:     { type: 'number', description: '-1 when the sky never gets dark enough' },
                aboveMinAlt: { type: 'boolean' },
              },
            },
          },
          windowStart: nullable({ type: 'string' }),
          windowEnd:   nullable({ type: 'string' }),
          everVisible: { type: 'boolean' },
          upTonight:   nullable({ type: 'boolean', description: 'Null when there is no dark window' }),
        },
      },
      WallImage: {
        type: 'object',
        required: ['path', 'kind', 'aspect'],
        properties: {
          path:   { type: 'string', description: 'Library-relative path' },
          kind:   { type: 'string', enum: ['processed', 'telescope'] },
          aspect: { type: 'number' },
        },
      },
      WallSpan: {
        type: 'object',
        required: ['cols', 'rows'],
        properties: { cols: { type: 'integer' }, rows: { type: 'integer' } },
      },
      WallOverride: {
        type: 'object',
        properties: {
          span:      { $ref: '#/components/schemas/WallSpan' },
          imagePath: { type: 'string' },
          focus:     { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
          zoom:      { type: 'number' },
        },
      },
      WallOverrides: {
        type: 'object',
        additionalProperties: { $ref: '#/components/schemas/WallOverride' },
        description: 'Tile id to its override',
      },
      WallTile: {
        type: 'object',
        required: ['id', 'number', 'name', 'typeClass', 'majorAxisArcmin', 'libraryObjectId', 'imaged', 'inFrame', 'mergedIds', 'image', 'span', 'lastSessionDate', 'sessionCount'],
        properties: {
          id:              { type: 'string' },
          number:          nullable({ type: 'integer' }),
          name:            { type: 'string' },
          typeClass:       { type: 'string', enum: ['galaxy', 'nebula', 'cluster', 'other'] },
          majorAxisArcmin: nullable({ type: 'number' }),
          libraryObjectId: nullable({ type: 'string' }),
          imaged:          { type: 'boolean' },
          inFrame:         { type: 'boolean' },
          mergedIds:       { type: 'array', items: { type: 'string' } },
          image:           { oneOf: [{ $ref: '#/components/schemas/WallImage' }, { type: 'null' }] },
          span:            { $ref: '#/components/schemas/WallSpan' },
          lastSessionDate: nullable({ type: 'string' }),
          sessionCount:    { type: 'integer' },
        },
      },
      CatalogWall: {
        type: 'object',
        required: ['catalog', 'label', 'total', 'imagedCount', 'tiles', 'overrides'],
        properties: {
          catalog:     { type: 'string' },
          label:       { type: 'string' },
          total:       { type: 'integer' },
          imagedCount: { type: 'integer' },
          tiles:       { type: 'array', items: { $ref: '#/components/schemas/WallTile' } },
          overrides:   { $ref: '#/components/schemas/WallOverrides' },
        },
      },
      WallEditInput: {
        type: 'object',
        properties: {
          set:   { $ref: '#/components/schemas/WallOverrides' },
          clear: { type: 'array', items: { type: 'string' } },
        },
        required: ['set', 'clear'],
      },
      WallImageChoice: {
        type: 'object',
        required: ['path', 'kind', 'label', 'aspect'],
        properties: {
          path:   { type: 'string' },
          kind:   { type: 'string', enum: ['processed', 'telescope'] },
          label:  { type: 'string' },
          aspect: { type: 'number' },
        },
      },
      WallImagesResult: {
        type: 'object',
        required: ['images'],
        properties: { images: { type: 'array', items: { $ref: '#/components/schemas/WallImageChoice' } } },
      },
      WallOverridesResult: {
        type: 'object',
        required: ['overrides'],
        properties: { overrides: { $ref: '#/components/schemas/WallOverrides' } },
      },

      // Files in the local library, as the telescope browse views return them.
      TelescopeFile: {
        type: 'object',
        required: ['name', 'size', 'type', 'fileType', 'path', 'sessionFolder', 'exposure', 'filter', 'timestamp', 'date', 'frameCount', 'isThumbnail', 'previewable', 'downloadUrl', 'subIndex'],
        properties: {
          name:          { type: 'string' },
          size:          { type: 'integer' },
          type:          { type: 'string', enum: [...FILE_CATEGORIES] },
          fileType:      { type: 'string', description: 'Parsed capture type, e.g. stacked, sub, thumbnail' },
          path:          { type: 'string', description: 'Library-relative path' },
          sessionFolder: { type: 'string' },
          exposure:      nullable({ type: 'string' }),
          filter:        nullable({ type: 'string' }),
          timestamp:     nullable({ type: 'string' }),
          date:          nullable({ type: 'string' }),
          frameCount:    nullable({ type: 'integer' }),
          isThumbnail:   { type: 'boolean' },
          previewable:   { type: 'boolean' },
          downloadUrl:   { type: 'string' },
          videoUrl:      { type: 'string', description: 'Present only for video' },
          thumbUrl:      { type: 'string' },
          previewUrl:    { type: 'string' },
          subIndex:      nullable({ type: 'integer' }),
        },
      },
      TelescopeSubFrame: {
        type: 'object',
        required: ['name', 'size', 'type', 'fileType', 'subIndex', 'path', 'exposure', 'filter', 'timestamp', 'date', 'isThumbnail', 'downloadUrl'],
        properties: {
          name:        { type: 'string' },
          size:        { type: 'integer' },
          type:        { type: 'string', enum: [...FILE_CATEGORIES] },
          fileType:    { type: 'string' },
          subIndex:    nullable({ type: 'integer' }),
          path:        { type: 'string' },
          exposure:    nullable({ type: 'string' }),
          filter:      nullable({ type: 'string' }),
          timestamp:   nullable({ type: 'string' }),
          date:        nullable({ type: 'string' }),
          isThumbnail: { type: 'boolean' },
          downloadUrl: { type: 'string' },
        },
      },
      TelescopeSubsSummary: {
        type: 'object',
        required: ['totalSubFrames', 'fitsCount', 'jpgCount', 'sessionDates'],
        properties: {
          totalSubFrames: { type: 'integer' },
          fitsCount:      { type: 'integer' },
          jpgCount:       { type: 'integer' },
          sessionDates: {
            type: 'array',
            items: {
              type: 'object',
              required: ['date', 'count'],
              properties: { date: { type: 'string' }, count: { type: 'integer' } },
            },
          },
        },
      },
      TelescopeLegacyError: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' } },
        description: 'These legacy routes answer with a bare object, not the usual API envelope.',
      },
      TelescopeLegacyDeleted: {
        type: 'object',
        required: ['deleted'],
        properties: { deleted: { type: 'boolean', const: true } },
      },

      // Observations: the calendar rows and the full detail view.
      ObservationListItem: {
        type: 'object',
        required: ['id', 'objectId', 'objectName', 'catalogId', 'type', 'constellation', 'date', 'startTime', 'endTime', 'fileCount', 'stackedCount', 'fitsCount', 'subFrameCount', 'processedCount', 'thumbnailUrl', 'ra', 'dec', 'hasNotes', 'telescopeId'],
        properties: {
          id:            { type: 'string' },
          objectId:      { type: 'string' },
          objectName:    { type: 'string' },
          catalogId:     { type: 'string' },
          type:          { type: 'string' },
          constellation: { type: 'string' },
          date:          { type: 'string', format: 'date' },
          startTime:     nullable({ type: 'string' }),
          endTime:       nullable({ type: 'string' }),
          fileCount:     { type: 'integer' },
          stackedCount:  { type: 'integer' },
          fitsCount:     { type: 'integer' },
          subFrameCount: { type: 'integer' },
          processedCount: { type: 'integer' },
          thumbnailUrl:  { type: 'string' },
          ra:            nullable({ type: 'string' }),
          dec:           nullable({ type: 'string' }),
          hasNotes:      { type: 'boolean' },
          telescopeId:   nullable({ type: 'string' }),
        },
      },
      ObservationLocation: {
        type: 'object',
        required: ['objectId', 'date', 'objectName', 'catalogId', 'telescopeId', 'lat', 'lon', 'source'],
        properties: {
          objectId:   { type: 'string' },
          date:       { type: 'string', format: 'date' },
          objectName: { type: 'string' },
          catalogId:  { type: 'string' },
          telescopeId: nullable({ type: 'string' }),
          lat:        { type: 'number' },
          lon:        { type: 'number' },
          source:     { type: 'string', enum: ['fits', 'settings'], description: 'fits is precise; settings fell back to a site' },
        },
      },
      ObservationCapture: {
        type: 'object',
        required: ['id', 'objectId', 'sessionFolder', 'sessionDate', 'exposureSec', 'gain', 'filter', 'binning', 'framesStacked', 'framesTaken', 'framesPlanned', 'minTempC', 'maxTempC', 'raHours', 'decDeg', 'target', 'sourceRelPath', 'updatedAt'],
        properties: {
          id:            { type: 'integer' },
          objectId:      { type: 'string' },
          sessionFolder: { type: 'string' },
          sessionDate:   nullable({ type: 'string' }),
          exposureSec:   nullable({ type: 'number' }),
          gain:          nullable({ type: 'number' }),
          filter:        nullable({ type: 'string' }),
          binning:       nullable({ type: 'string' }),
          framesStacked: nullable({ type: 'integer' }),
          framesTaken:   nullable({ type: 'integer' }),
          framesPlanned: nullable({ type: 'integer' }),
          minTempC:      nullable({ type: 'number' }),
          maxTempC:      nullable({ type: 'number' }),
          raHours:       nullable({ type: 'number' }),
          decDeg:        nullable({ type: 'number' }),
          target:        nullable({ type: 'string' }),
          sourceRelPath: nullable({ type: 'string' }),
          updatedAt:     { type: 'string' },
        },
      },
      ObservationCaptureSummary: {
        type: 'object',
        required: ['runs', 'integrationSec', 'framesStacked', 'framesTaken', 'framesPlanned', 'exposureSec', 'gain', 'filter', 'minTempC', 'maxTempC'],
        properties: {
          runs:          { type: 'integer' },
          integrationSec: nullable({ type: 'number' }),
          framesStacked: nullable({ type: 'integer' }),
          framesTaken:   nullable({ type: 'integer' }),
          framesPlanned: nullable({ type: 'integer' }),
          exposureSec:   nullable({ type: 'number', description: 'Null when the night\u2019s runs disagree' }),
          gain:          nullable({ type: 'number' }),
          filter:        nullable({ type: 'string' }),
          minTempC:      nullable({ type: 'number' }),
          maxTempC:      nullable({ type: 'number' }),
        },
      },
      ObservationOptics: {
        type: 'object',
        required: ['configId', 'configName', 'focalLengthMm', 'source', 'fileFocalMm'],
        properties: {
          configId:     nullable({ type: 'string' }),
          configName:   nullable({ type: 'string' }),
          focalLengthMm: nullable({ type: 'number' }),
          source:       nullable({ type: 'string', enum: ['manual', 'fits', 'only'] }),
          fileFocalMm:  nullable({ type: 'number' }),
        },
      },
      ObservationWeather: {
        type: 'object',
        required: ['temperature', 'cloudCover', 'humidity', 'windSpeed', 'dewPoint', 'visibility', 'precipProb'],
        properties: {
          temperature: nullable({ type: 'number' }),
          cloudCover:  nullable({ type: 'number' }),
          humidity:    nullable({ type: 'number' }),
          windSpeed:   nullable({ type: 'number' }),
          dewPoint:    nullable({ type: 'number' }),
          visibility:  nullable({ type: 'number' }),
          precipProb:  nullable({ type: 'number' }),
        },
      },
      ObservationCoordinates: {
        type: 'object',
        required: ['lat', 'lon'],
        properties: { lat: { type: 'number' }, lon: { type: 'number' } },
      },
      ObservationDetail: {
        type: 'object',
        required: ['id', 'objectId', 'objectName', 'catalogId', 'type', 'constellation', 'date', 'startTime', 'endTime', 'fileCount', 'stackedCount', 'fitsCount', 'subFrameCount', 'processedCount', 'thumbnailUrl', 'ra', 'dec', 'magnitude', 'distanceLy', 'description', 'wikiUrl', 'sizeArcmin', 'hasNotes', 'sessionImage', 'capture', 'captureRuns', 'files', 'note', 'coordinates', 'weather', 'telescopeId', 'optics', 'rigKey', 'siteId', 'locationSource', 'locationLabel', 'fileCoordinates'],
        properties: {
          id:            { type: 'string' },
          objectId:      { type: 'string' },
          objectName:    { type: 'string' },
          catalogId:     { type: 'string' },
          type:          { type: 'string' },
          constellation: { type: 'string' },
          date:          { type: 'string', format: 'date' },
          startTime:     nullable({ type: 'string' }),
          endTime:       nullable({ type: 'string' }),
          fileCount:     { type: 'integer' },
          stackedCount:  { type: 'integer' },
          fitsCount:     { type: 'integer' },
          subFrameCount: { type: 'integer' },
          processedCount: { type: 'integer' },
          thumbnailUrl:  { type: 'string' },
          ra:            nullable({ type: 'string' }),
          dec:           nullable({ type: 'string' }),
          magnitude:     nullable({ type: 'number' }),
          distanceLy:    nullable({ type: 'number' }),
          description:   { type: 'string' },
          wikiUrl:       nullable({ type: 'string' }),
          sizeArcmin:    nullable({ type: 'string' }),
          hasNotes:      { type: 'boolean' },
          sessionImage:  nullable({ type: 'string' }),
          capture:       { oneOf: [{ $ref: '#/components/schemas/ObservationCaptureSummary' }, { type: 'null' }] },
          captureRuns:   { type: 'array', items: { $ref: '#/components/schemas/ObservationCapture' } },
          files:         { type: 'array', items: { $ref: '#/components/schemas/TelescopeFile' } },
          note:          { oneOf: [{ $ref: '#/components/schemas/ObservationNote' }, { type: 'null' }] },
          coordinates:   { oneOf: [{ $ref: '#/components/schemas/ObservationCoordinates' }, { type: 'null' }] },
          weather:       { oneOf: [{ $ref: '#/components/schemas/ObservationWeather' }, { type: 'null' }] },
          telescopeId:   nullable({ type: 'string' }),
          optics:        { $ref: '#/components/schemas/ObservationOptics' },
          rigKey:        { type: 'string' },
          siteId:        nullable({ type: 'string', description: 'Null when the location was not explicitly tagged' }),
          locationSource: { type: 'string', enum: ['fits', 'site'] },
          locationLabel: { type: 'string' },
          fileCoordinates: { oneOf: [{ $ref: '#/components/schemas/ObservationCoordinates' }, { type: 'null' }] },
        },
      },

      // Planned sessions and their plan-vs-actual outcomes.
      PlannedSession: {
        type: 'object',
        required: ['id', 'objectId', 'objectName', 'ra', 'dec', 'startTime', 'endTime', 'notes', 'framingSetup', 'filterBand', 'filter', 'skipped', 'createdAt', 'updatedAt'],
        properties: {
          id:          { type: 'integer' },
          objectId:    { type: 'string' },
          objectName:  { type: 'string' },
          ra:          { type: 'number' },
          dec:         { type: 'number' },
          startTime:   { type: 'string', format: 'date-time' },
          endTime:     { type: 'string', format: 'date-time' },
          notes:       { type: 'string' },
          framingSetup: nullable({ type: 'string', description: 'Serialized mosaic framing, opaque to the API' }),
          filterBand:  nullable({ type: 'string', enum: ['broadband', 'narrowband'] }),
          filter:      nullable({ type: 'string' }),
          skipped:     { type: 'integer', enum: [0, 1] },
          createdAt:   { type: 'string' },
          updatedAt:   { type: 'string' },
        },
      },
      PlanOutcome: {
        type: 'object',
        required: ['status', 'plannedSec', 'achievedSec', 'frames'],
        properties: {
          status:      { type: 'string', enum: ['upcoming', 'in_progress', 'awaiting_import', 'done', 'partial', 'missed', 'skipped'] },
          plannedSec:  { type: 'number' },
          achievedSec: { type: 'number' },
          frames:      { type: 'integer' },
        },
      },
      PlannedSessionWithOutcome: {
        allOf: [{ $ref: '#/components/schemas/PlannedSession' }],
        type: 'object',
        properties: {
          outcome: { oneOf: [{ $ref: '#/components/schemas/PlanOutcome' }, { type: 'null' }], description: 'Absent when ?outcomes=0' },
        },
      },
      PlanNightSummary: {
        type: 'object',
        required: ['night', 'objectId', 'objectName', 'libraryObjectIds', 'blocks', 'plannedSec', 'achievedSec', 'frames', 'status'],
        properties: {
          night:            { type: 'string', format: 'date' },
          objectId:         { type: 'string' },
          objectName:       { type: 'string' },
          libraryObjectIds: { type: 'array', items: { type: 'string' } },
          blocks:           { type: 'integer' },
          plannedSec:       { type: 'number' },
          achievedSec:      { type: 'number' },
          frames:           { type: 'integer' },
          status:           { type: 'string', enum: ['upcoming', 'in_progress', 'awaiting_import', 'done', 'partial', 'missed', 'skipped'] },
        },
      },
      PlannedSessionCreateInput: {
        type: 'object',
        required: ['objectId', 'objectName', 'ra', 'dec', 'startTime', 'endTime'],
        properties: {
          objectId:   { type: 'string' },
          objectName: { type: 'string' },
          ra:         { type: 'number', description: 'Decimal hours' },
          dec:        { type: 'number', description: 'Decimal degrees' },
          startTime:  { type: 'string', format: 'date-time' },
          endTime:    { type: 'string', format: 'date-time' },
          notes:      { type: 'string' },
          filterBand: nullable({ type: 'string', enum: ['broadband', 'narrowband'] }),
          filter:     nullable({ type: 'string' }),
        },
      },
      PlannedSessionUpdateInput: {
        type: 'object',
        properties: {
          startTime:    { type: 'string', format: 'date-time' },
          endTime:      { type: 'string', format: 'date-time' },
          notes:        { type: 'string' },
          framingSetup: { type: 'string' },
          filterBand:   nullable({ type: 'string', enum: ['broadband', 'narrowband'] }),
          filter:       nullable({ type: 'string' }),
          skipped:      { type: 'boolean' },
        },
      },
      PlannedSessionDeleted: {
        type: 'object',
        required: ['deleted'],
        properties: { deleted: { type: 'boolean', const: true } },
      },

      // Observing sites — generated from the same Zod schemas the routes validate with.
      ObservingSite: jsonSchemaOf(ObservingSiteSchema),
      ObservingSiteInput: jsonSchemaOf(SiteBodySchema, 'input'),
      ObservingSiteUpdate: jsonSchemaOf(SiteUpdateSchema, 'input'),
      ActiveSiteInput: jsonSchemaOf(ActiveSiteBodySchema, 'input'),
      SitePhoto: jsonSchemaOf(SitePhotoSchema),
      SitePhotoCaptionInput: jsonSchemaOf(SitePhotoCaptionBodySchema, 'input'),
      BortleLookup: jsonSchemaOf(BortleLookupSchema),
      SiteDeleted: jsonSchemaOf(SiteDeletedSchema),
      SiteDeletedWithId: jsonSchemaOf(SiteDeletedWithIdSchema),

      TelescopeStatus: {
        type: 'object',
        properties: {
          configured:  { type: 'boolean' },
          hostname:    strEx('seestar.local'),
          online:      { type: 'boolean', description: 'true if TCP port 445 is reachable within 2 s' },
          latencyMs:   nullable({ type: 'integer', description: 'TCP round-trip time in ms' }),
          checkedAt:   nullable(isoDate),
        },
      },

      // Settings — global app settings. Per-telescope connection fields
      // (hostname, shareName, username, password, model) live on
      // TelescopeProfile, not here; see /telescopes.
      Settings: {
        type: 'object',
        properties: {
          apiKey:          { type: 'string', description: 'Masked (first 8 chars + "..."). Send the unchanged mask on PUT to keep the current value.' },
          hasApiKey:       { type: 'boolean' },
          latitude:        nullable({ type: 'number', example: 40.7128, description: 'Observer latitude, decimal degrees north' }),
          longitude:       nullable({ type: 'number', example: -74.006, description: 'Observer longitude, decimal degrees east' }),
          locationName:    strEx('New York, NY'),
          timezone:        strEx('America/New_York'),
          minAlt:          { type: 'integer', default: 20, description: 'Minimum altitude in degrees for planner visibility filter (0–45)' },
          horizonProfile:  {
            type: 'array',
            items: { type: 'integer', minimum: 0, maximum: 85 },
            minItems: SKY_MAP_AZ_SLICES,
            maxItems: SKY_MAP_AZ_SLICES,
            description: '36 blocked-altitude values (degrees), one per 10° azimuth bucket starting at 0° (North) clockwise',
          },
          visibleSkyMap: {
            type: 'array',
            items: { type: 'boolean' },
            description: `${SKY_MAP_CELLS} values (${SKY_MAP_AZ_SLICES} azimuth slices x ${SKY_MAP_BANDS} elevation bands), or [] if not set (whole sky treated as visible)`,
          },
          skyMapBands: {
            type: 'integer',
            example: SKY_MAP_BANDS,
            description: 'Elevation-band count the server supports for visibleSkyMap. Native clients gate the finer-grid sky map editor on this and a client built for fewer bands should keep using its own resolution rather than assume this value.',
          },
          syncEnabled:     { type: 'boolean' },
          syncJpg:         { type: 'boolean' },
          syncFits:        { type: 'boolean' },
          syncThumbnails:  { type: 'boolean' },
          syncSubFrames:   { type: 'boolean' },
          syncVideos:      { type: 'boolean' },
          autoImportInterval: { type: 'integer', description: 'Minutes between auto-imports' },
          importJpg:        { type: 'boolean', description: 'Legacy global default; superseded by TelescopeProfile.importJpg for newer installs' },
          importFits:       { type: 'boolean', description: 'Legacy global default; superseded by TelescopeProfile.importFits for newer installs' },
          importThumbnails: { type: 'boolean', description: 'Legacy global default; superseded by TelescopeProfile.importThumbnails for newer installs' },
          importSubFrames:  { type: 'boolean', description: 'Legacy global default; superseded by TelescopeProfile.importSubFrames for newer installs' },
          importVideos:     { type: 'boolean', description: 'Legacy global default; superseded by TelescopeProfile.importVideos for newer installs' },
          archiveAllFiles:  { type: 'boolean', description: 'Legacy global default; superseded by TelescopeProfile.archiveAllFiles for newer installs' },
          galleryProcessedOnlyDefault: { type: 'boolean', description: 'Gallery opens with the processed-only filter on' },
          planetariumProcessedOnlyDefault: { type: 'boolean', description: 'Planetarium opens with the processed-only filter on' },
          annotateAutoSolve: { type: 'boolean', default: true, description: 'Plate-solve new stacked images in the background while the library is idle, so Annotate has results ready' },
          autoMeasureFrames: { type: 'boolean', default: false, description: 'Analyze new raw sub-frames in the background after an import, once the library is idle, so the Subframes list is already scored when opened' },
          onboardingCompleted: { type: 'boolean' },
          prefetchCatalogAssets: { type: 'boolean', description: 'Toggles the bulk background prefetch job that warms catalog imagery/descriptions in the cache' },
          planetariumShowInfo: { type: 'boolean' },
          galleryImageSource: { type: 'string', enum: [...GALLERY_IMAGE_SOURCES], description: 'Default image shown on library cards when no custom image is set' },
          slideshowRotateCCW: { type: 'boolean', description: 'Rotate all images 90° CCW in slideshow / planetarium mode' },
          preferredCatalog: { type: 'string', enum: [...PREFERRED_CATALOGS], description: 'Preferred nomenclature for new object folder names when an object has both an NGC/IC and a Caldwell designation' },
          groupObservingNights: { type: 'boolean', description: 'Whether a session crossing local midnight groups as one observing night or splits at the calendar date' },
          temperatureUnit: { type: 'string', enum: [...TEMPERATURE_UNITS] },
          windSpeedUnit:   { type: 'string', enum: [...WIND_SPEED_UNITS] },
          updateChannel:   { type: 'string', enum: [...UPDATE_CHANNELS], description: 'Desktop auto-update channel' },
          autoUpdateEnabled: { type: 'boolean', description: 'Whether the updater checks and pre-downloads automatically' },
          plannerPrefetchEnabled: { type: 'boolean', description: 'Nightly maintenance: pre-warm planner thumbnails for tonight’s visible objects' },
          plannerPrefetchTime: { type: 'string', example: '03:00', description: 'HH:MM in the observer’s local timezone' },
          plannerPrefetchLastRun: nullable({ type: 'integer', description: 'Unix ms of the last run, read-only' }),
          nightlyCatalogPackCheckEnabled: { type: 'boolean', description: 'Nightly maintenance: check for and apply catalog pack updates' },
          nightlyHousekeepingEnabled: { type: 'boolean', description: 'Nightly maintenance: purge junk files and stale import temp data' },
          nightlyForecastPrefetchEnabled: { type: 'boolean', description: 'Nightly maintenance: pre-warm the weather/seeing forecast cache' },
          nightlyMaintenanceEnabled: { type: 'boolean', description: 'Master switch for the whole nightly maintenance batch' },
          nightlyHousekeepingLastRun: nullable({ type: 'integer', description: 'Unix ms of the last run, read-only' }),
          nightlyForecastLastRun: nullable({ type: 'integer', description: 'Unix ms of the last run, read-only' }),
          calibrationExpiryDays: { type: 'integer', description: 'Days an archived bias/dark bundle stays valid before the Calibrations page flags it expired' },
          pixinsightEnabled: { type: 'boolean', description: 'Serve the PixInsight connector update repository at /plugins/pixinsight/ (admin opt-in, default off)' },
          objectPageLayout: { type: 'string', enum: [...OBJECT_PAGE_LAYOUTS], description: "Object page layout: 'media' (Combined: every picture of the object on one page, the default) or 'nights' (Classic: a grid of observations)" },
          groupCatalogCompanions: { type: 'boolean', description: 'Catalog boards also count objects that sat inside the frame of an object you imaged (M43 when M42 was shot)' },
        },
      },
    },
  },

  // ─── Paths ──────────────────────────────────────────────────────────
  paths: {

    // ── System ────────────────────────────────────────────────────────
    '/health': {
      get: {
        summary: 'Health check',
        tags: ['System'],
        responses: { 200: { description: 'API status and uptime' } },
      },
    },

    // ── Auth ──────────────────────────────────────────────────────────
    '/auth/register': {
      post: {
        summary: 'Create the first account',
        tags: ['Auth'],
        description: 'Open only while the install has no accounts; once any user exists this answers 403 and an admin must create further accounts through /auth/users. The first account is an admin. Rate limited per source IP.',
        requestBody: jsonBody('AuthRegisterInput'),
        responses: {
          200: jsonResponse('The new session and its user', 'AuthToken'),
          400: { description: 'REGISTRATION_FAILED. Username taken, or too short (3 characters minimum).' },
          403: { description: 'REGISTRATION_CLOSED' },
          422: { description: 'VALIDATION_ERROR' },
          429: { description: 'RATE_LIMITED' },
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Sign in',
        tags: ['Auth'],
        description: 'Returns a JWT and its user. Rate limited per source IP: ten failures in fifteen minutes locks that address out for fifteen minutes.',
        requestBody: jsonBody('AuthLoginInput'),
        responses: {
          200: jsonResponse('The session and its user', 'AuthToken'),
          401: { description: 'LOGIN_FAILED' },
          422: { description: 'VALIDATION_ERROR' },
          429: { description: 'RATE_LIMITED' },
        },
      },
    },
    '/auth/me': {
      get: {
        summary: 'The signed-in user',
        tags: ['Auth'],
        description: 'Validates the bearer token, including device revocation and password-change invalidation, and returns the current account.',
        responses: {
          200: jsonResponse('The current user', 'AuthUser'),
          401: { description: 'NO_TOKEN, AUTH_FAILED, DEVICE_REVOKED, USER_NOT_FOUND or SESSION_INVALIDATED' },
        },
      },
    },
    '/auth/status': {
      get: {
        summary: 'Whether setup is needed',
        tags: ['Auth'],
        responses: { 200: jsonResponse('User count and setup state', 'AuthStatus') },
      },
    },
    '/auth/users': {
      get: {
        summary: 'List accounts',
        tags: ['Auth'],
        description: 'Admin only. Never includes password hashes or token versions.',
        responses: {
          200: jsonResponse('Every account', 'AuthUser', true),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
      post: {
        summary: 'Create an account',
        tags: ['Auth'],
        description: 'Admin only. Returns the updated account list, not a session. The role defaults to viewer.',
        requestBody: jsonBody('AuthCreateUserInput'),
        responses: {
          200: jsonResponse('Every account after the change', 'AuthUser', true),
          400: { description: 'CREATE_FAILED. Username taken, or too short.' },
          403: { description: 'FORBIDDEN. Admin only.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/auth/users/{id}': {
      delete: {
        summary: 'Delete an account',
        tags: ['Auth'],
        description: 'Admin only. Also revokes every device paired to that account. The last admin cannot be deleted.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Every account after the change', 'AuthUser', true),
          400: { description: 'LAST_ADMIN' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
        },
      },
    },
    '/auth/users/{id}/password': {
      put: {
        summary: "Reset an account's password",
        tags: ['Auth'],
        description: 'Admin only. Bumps the token version, so existing sign-ins are invalidated, and revokes paired devices.',
        parameters: [idParam],
        requestBody: jsonBody('AuthPasswordInput'),
        responses: {
          200: jsonResponse('Whether the password changed', 'AuthUpdated'),
          400: { description: 'UPDATE_FAILED. Too short (6 characters minimum).' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/auth/users/{id}/profile': {
      put: {
        summary: "Change an account's display name and email",
        tags: ['Auth'],
        description: 'Admin only. An empty email clears it.',
        parameters: [idParam],
        requestBody: jsonBody('AuthProfileInput'),
        responses: {
          200: jsonResponse('Every account after the change', 'AuthUser', true),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/auth/users/{id}/role': {
      put: {
        summary: "Change an account's role",
        tags: ['Auth'],
        description: 'Admin only. The last admin cannot be demoted.',
        parameters: [idParam],
        requestBody: jsonBody('AuthRoleInput'),
        responses: {
          200: jsonResponse('Every account after the change', 'AuthUser', true),
          400: { description: 'LAST_ADMIN' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },

    // ── Settings ──────────────────────────────────────────────────────
    '/settings': {
      get: {
        summary: 'Get settings',
        tags: ['Settings'],
        description: 'Returns all settings. Passwords and API keys are masked.',
        responses: {
          200: { description: 'Settings object', content: { 'application/json': { schema: { $ref: '#/components/schemas/Settings' } } } },
        },
      },
      put: {
        summary: 'Update settings',
        tags: ['Settings'],
        description: 'Partial update: only send fields you want to change. To keep the current password/API key, omit those fields or send the masked placeholder.',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Settings' } } },
        },
        responses: { 200: { description: 'Updated settings' } },
      },
    },
    '/settings/generate-api-key': {
      post: {
        summary: 'Generate API key',
        tags: ['Settings'],
        description: 'Generates and stores a new API key. The full key is returned only once.',
        responses: { 200: { description: 'Full API key (shown once)' } },
      },
    },
    '/settings/api-key': {
      delete: { summary: 'Revoke API key', tags: ['Settings'], responses: { 200: { description: 'Key revoked' } } },
    },
    '/settings/api-keys': {
      get: {
        summary: 'List personal API keys',
        tags: ['Settings'],
        description: 'Any signed-in user sees their own keys. `?scope=all` lists every key with its owner and is admin only. A key acts with its owner\u2019s role; keys cannot manage keys.',
        parameters: [{ name: 'scope', in: 'query', schema: { type: 'string', enum: ['all'] }, description: 'Admin only: every account\u2019s keys' }],
        responses: {
          200: {
            description: '`{ keys, max }`. Owner fields are present only for `scope=all`.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['keys', 'max'],
                  properties: {
                    keys: {
                      type: 'array',
                      items: { oneOf: [{ $ref: '#/components/schemas/SettingsApiKeySummary' }, { $ref: '#/components/schemas/SettingsApiKeyOwner' }] },
                    },
                    max: { type: 'integer' },
                  },
                },
              },
            },
          },
          401: { description: 'UNAUTHORIZED' },
          403: { description: 'FORBIDDEN. scope=all requires an admin.' },
        },
      },
      post: {
        summary: 'Create a personal API key',
        tags: ['Settings'],
        description: 'Needs a sign-in session: an API key or a paired-device token cannot mint another key. The full key is returned once; only its hash is stored.',
        requestBody: jsonBody('SettingsApiKeyCreateInput'),
        responses: {
          200: jsonResponse('The new key, shown once', 'SettingsApiKeyCreated'),
          400: { description: 'INVALID_BODY. name is longer than 50 characters.' },
          401: { description: 'UNAUTHORIZED' },
          403: { description: 'API_KEY_NOT_ALLOWED or DEVICE_TOKEN_NOT_ALLOWED' },
          409: { description: 'LIMIT_REACHED. Five keys per account.' },
        },
      },
    },
    '/settings/api-keys/{id}': {
      delete: {
        summary: 'Revoke an API key',
        tags: ['Settings'],
        description: 'Needs a sign-in session. Admins can revoke anyone\u2019s key; everyone else only their own.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Revocation confirmed', 'SettingsApiKeyRevoked'),
          401: { description: 'UNAUTHORIZED' },
          403: { description: 'API_KEY_NOT_ALLOWED or DEVICE_TOKEN_NOT_ALLOWED' },
          404: { description: 'NOT_FOUND' },
        },
      },
    },
    '/settings/reset-database': {
      delete: {
        summary: 'Reset the database',
        tags: ['Settings'],
        description: 'Admin only and destructive. Takes a backup first, then purges library data and caches while keeping settings and users. Requires the body to confirm.',
        requestBody: jsonBody('SettingsResetDatabaseInput'),
        responses: {
          200: jsonResponse('The reset finished', 'SettingsResetResult'),
          400: { description: 'CONFIRMATION_REQUIRED. Send { "confirmation": "delete" }.' },
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'RESET_FAILED' },
        },
      },
    },
    '/settings/debug-logging/status': {
      get: {
        summary: 'Debug capture status',
        tags: ['Settings'],
        description: 'Admin only. Whether capture is on, when it expires, and where the log is.',
        responses: {
          200: jsonResponse('Capture state and minutes remaining', 'SettingsDebugLogStatus'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/settings/debug-logging/enable': {
      post: {
        summary: 'Start debug capture',
        tags: ['Settings'],
        description: 'Admin only. Writes a log with the app version, library and data paths, the import settings, a credential-free view of each telescope, and database counts.',
        responses: {
          200: jsonResponse('The capture state', 'SettingsDebugLogState'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/settings/debug-logging/disable': {
      post: {
        summary: 'Stop debug capture',
        tags: ['Settings'],
        description: 'Admin only.',
        responses: {
          200: jsonResponse('The capture state', 'SettingsDebugLogState'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/settings/debug-logging/download': {
      get: {
        summary: 'Download the debug log',
        tags: ['Settings'],
        description: 'Admin only. Streams the capture log gzipped as an attachment.',
        responses: {
          200: { description: 'The gzipped log', content: { 'application/gzip': { schema: { type: 'string', format: 'binary' } } } },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. No capture has been made yet.' },
          500: { description: 'STREAM_ERROR' },
        },
      },
    },
    '/settings/nightly/run': {
      post: {
        summary: 'Run nightly maintenance now',
        tags: ['Settings'],
        description: 'Admin only. Respects the master switch, so it refuses while maintenance is off. The work runs in the background; refetch settings for the new last-run times.',
        responses: {
          200: jsonResponse('Maintenance started', 'SettingsNightlyStarted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'MAINTENANCE_DISABLED or ALREADY_RUNNING' },
        },
      },
    },

    // ── System log ────────────────────────────────────────────────────
    '/system-log': {
      get: {
        summary: 'The audit trail',
        tags: ['System'],
        description: 'Admin only. Newest first. Unknown filter values are dropped rather than widening the query.',
        parameters: [
          { $ref: '#/components/parameters/limit' },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'category', in: 'query', schema: { type: 'string', enum: [...SYSTEM_LOG_CATEGORIES] } },
          { name: 'level', in: 'query', schema: { type: 'string', enum: [...SYSTEM_LOG_LEVELS] } },
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Matches message, event or username' },
        ],
        responses: {
          200: jsonResponse('A page of entries and the matching total', 'SystemLogPage'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
      delete: {
        summary: 'Clear the audit trail',
        tags: ['System'],
        description: 'Admin only. A record of who cleared it is written immediately afterwards, so the trail never ends without an explanation.',
        responses: {
          200: jsonResponse('Cleared', 'SystemLogCleared'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },

    // ── Meta ──────────────────────────────────────────────────────────
    '/meta/version': {
      get: {
        summary: 'App version',
        tags: ['System'],
        responses: { 200: jsonResponse('The running version and build', 'MetaVersion') },
      },
    },
    '/meta/changelog': {
      get: {
        summary: 'Release notes',
        tags: ['System'],
        description: 'Parsed from CHANGELOG.md, newest first. Each entry has its version, build, date and sections of bullet lines.',
        responses: {
          200: jsonResponse('Changelog entries', 'MetaChangelogEntry', true),
          500: { description: 'CHANGELOG_READ_ERROR' },
        },
      },
    },
    '/meta/update': {
      get: {
        summary: 'Desktop update status',
        tags: ['System'],
        description: 'Read-only. Drives the update banner. `platform` is null on a non-desktop build.',
        responses: { 200: jsonResponse('The update status', 'MetaUpdateStatus') },
      },
    },
    '/meta/update/check': {
      post: {
        summary: 'Check for an update now',
        tags: ['System'],
        description: 'Admin only. Triggers the network check and a possible background download, then returns the raw update status.',
        responses: {
          200: jsonResponse('The update status after the check', 'MetaUpdateStatusFull'),
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'UPDATE_CHECK_FAILED' },
        },
      },
    },
    '/meta/update/apply': {
      post: {
        summary: 'Apply the staged update',
        tags: ['System'],
        description: 'Admin only. Writes the marker the native helper consumes to install and restart.',
        responses: {
          200: jsonResponse('The update was queued', 'MetaUpdateApplied'),
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'NO_UPDATE, NOT_STAGED or APPLY_FAILED' },
        },
      },
    },

    // ── Preferences ───────────────────────────────────────────────────
    '/preferences/watermarks': {
      get: {
        summary: 'Saved watermark presets',
        tags: ['Settings'],
        description: 'For the signed-in user. Entries that fail the read schema are dropped rather than breaking the list.',
        responses: { 200: jsonResponse('The presets', 'PreferencesWatermarkPreset', true) },
      },
      put: {
        summary: 'Replace the watermark presets',
        tags: ['Settings'],
        description: 'Admin only. Replaces the whole array. Names must be unique ignoring case, and ids unique.',
        requestBody: jsonBody('PreferencesWatermarksInput'),
        responses: {
          200: jsonResponse('The stored presets', 'PreferencesWatermarkPreset', true),
          403: { description: 'FORBIDDEN. Admin only.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/preferences/last-seen-version': {
      get: {
        summary: "The version this user last acknowledged",
        tags: ['Settings'],
        responses: { 200: jsonResponse('The version, or null if never seen', 'PreferencesLastSeenVersion') },
      },
      put: {
        summary: 'Mark a version as seen',
        tags: ['Settings'],
        description: 'Called when the user dismisses the What\u2019s New popup. Idempotent.',
        requestBody: jsonBody('PreferencesLastSeenVersionInput'),
        responses: {
          200: jsonResponse('The acknowledged version', 'PreferencesLastSeenVersion'),
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },

    '/preferences/support-ask': {
      get: {
        summary: 'When this user dismissed the "Enjoying Nebulis?" ask',
        tags: ['Settings'],
        responses: { 200: jsonResponse('The instant it was dismissed (UTC), or null if never', 'PreferencesSupportAsk') },
      },
      put: {
        summary: 'Record that the support ask was seen',
        tags: ['Settings'],
        description: 'Takes no body. Called when the ask is closed or its coffee link is opened. Idempotent: the first call keeps its date.',
        responses: { 200: jsonResponse('The instant it was first dismissed', 'PreferencesSupportAsk') },
      },
    },

    // ── Device pairing ────────────────────────────────────────────────
    '/pair/start': {
      post: {
        summary: 'Start a TV pairing',
        tags: ['Pairing'],
        description: 'Public. The TV shows the user code and polls /pair/poll with the device code until a signed-in user approves it.',
        requestBody: { required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/PairStartBody' } } } },
        responses: { 200: jsonResponse('The codes and their expiry', 'PairStartResult') },
      },
    },
    '/pair/poll': {
      get: {
        summary: 'Poll a TV pairing',
        tags: ['Pairing'],
        description: 'Public. The first approved poll consumes the code and returns a device token; later polls see expired.',
        parameters: [{ name: 'deviceCode', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('Pending, expired, rejected, or approved with a token', 'PairPollResult'),
          400: { description: 'MISSING_DEVICE_CODE' },
        },
      },
    },
    '/pair/qr': {
      post: {
        summary: 'Create a QR enrollment',
        tags: ['Pairing'],
        description: 'Needs a sign-in session. The QR encodes the connect URL, the stable instance id and a pre-approved short-lived device code, so a phone can connect and sign in in one scan.',
        requestBody: { required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/PairQrBody' } } } },
        responses: {
          200: jsonResponse('The QR image and its code', 'PairQrResult'),
          401: { description: 'AUTH_REQUIRED' },
          500: { description: 'QR_FAILED' },
          503: { description: 'NO_LAN_ADDRESS' },
        },
      },
    },
    '/pair/qr/status': {
      get: {
        summary: 'Has the phone finished connecting',
        tags: ['Pairing'],
        description: 'Needs a sign-in session. Read-only: it never consumes the code, so it cannot race the phone for the token.',
        parameters: [{ name: 'deviceCode', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('Waiting, connected or expired', 'PairQrStatus'),
          400: { description: 'MISSING_DEVICE_CODE' },
          401: { description: 'AUTH_REQUIRED' },
        },
      },
    },
    '/pair/lookup': {
      get: {
        summary: 'Look up a pairing code',
        tags: ['Pairing'],
        description: 'Needs a sign-in session. Lets the link page confirm the device before approving it.',
        parameters: [{ name: 'userCode', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('The device name and expiry', 'PairLookup'),
          401: { description: 'AUTH_REQUIRED' },
          404: { description: 'CODE_INVALID' },
        },
      },
    },
    '/pair/approve': {
      post: {
        summary: 'Approve a pairing code',
        tags: ['Pairing'],
        description: 'Needs a sign-in session. Links the waiting device to the current user.',
        requestBody: jsonBody('PairApproveBody'),
        responses: {
          200: jsonResponse('The linked device name', 'PairApproveResult'),
          400: { description: 'CODE_INVALID' },
          401: { description: 'AUTH_REQUIRED' },
          404: { description: 'CODE_NOT_FOUND' },
          409: { description: 'CODE_USED' },
          410: { description: 'CODE_EXPIRED' },
        },
      },
    },

    // ── Connected devices ─────────────────────────────────────────────
    '/devices': {
      get: {
        summary: 'Your paired devices',
        tags: ['Devices'],
        description: 'Authenticated. Only the caller\u2019s own devices.',
        responses: {
          200: jsonResponse('The active devices', 'ConnectedDevice', true),
          401: { description: 'AUTH_REQUIRED' },
        },
      },
    },
    '/devices/admin/all': {
      get: {
        summary: 'Every paired device',
        tags: ['Devices'],
        description: 'Admin only. Includes the owner, with null owner fields for a deleted account.',
        responses: {
          200: jsonResponse('Every active device', 'ConnectedDeviceWithOwner', true),
          401: { description: 'AUTH_REQUIRED' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/devices/admin/{id}': {
      delete: {
        summary: 'Revoke any device',
        tags: ['Devices'],
        description: 'Admin only.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Revocation confirmed', 'DeviceRevoked'),
          401: { description: 'AUTH_REQUIRED' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'DEVICE_NOT_FOUND' },
        },
      },
    },
    '/devices/{id}': {
      delete: {
        summary: 'Revoke one of your devices',
        tags: ['Devices'],
        description: 'Authenticated. The device token stops working immediately.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Revocation confirmed', 'DeviceRevoked'),
          401: { description: 'AUTH_REQUIRED' },
          404: { description: 'DEVICE_NOT_FOUND' },
        },
      },
      patch: {
        summary: 'Rename one of your devices',
        tags: ['Devices'],
        description: 'Authenticated. Names are trimmed to 80 characters.',
        parameters: [idParam],
        requestBody: jsonBody('DeviceRenameBody'),
        responses: {
          200: jsonResponse('Rename confirmed', 'DeviceRenamed'),
          400: { description: 'INVALID. The name was blank, or no matching device.' },
          401: { description: 'AUTH_REQUIRED' },
        },
      },
    },

    // ── Observing catalogs ────────────────────────────────────────────
    '/catalogs/best-window': {
      get: {
        summary: 'Best imaging window for a target',
        tags: ['Catalog'],
        description: 'Twelve monthly altitude samples for the target from the given site, the contiguous months above `minAlt`, and whether it is up tonight. RA is decimal hours; declination and the site are decimal degrees.',
        parameters: [
          { name: 'ra', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'dec', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'lat', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'lon', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'minAlt', in: 'query', schema: { type: 'number', default: 20 } },
        ],
        responses: {
          200: jsonResponse('Monthly samples, the window and tonight', 'BestImagingWindow'),
          400: { description: 'BAD_REQUEST' },
        },
      },
    },
    '/catalogs/{catalog}/progress': {
      get: {
        summary: 'Catalog progress',
        tags: ['Catalog'],
        description: 'Every object in the named catalog with whether it has been imaged, including objects credited only because they sat in another object\u2019s frame. Catalogs: messier, caldwell, herschel400, sharpless.',
        parameters: [subIdParam('catalog')],
        responses: {
          200: jsonResponse('Progress and per-object rows', 'CatalogProgress'),
          404: { description: 'UNKNOWN_CATALOG' },
        },
      },
    },
    '/catalogs/{catalog}/wall': {
      get: {
        summary: 'The catalog wall',
        tags: ['Catalog'],
        description: 'The user\u2019s own pictures laid out for the My Catalog mosaic. An object without a picture of the user\u2019s own comes back with `image: null`; no survey image is ever substituted.',
        parameters: [subIdParam('catalog')],
        responses: {
          200: jsonResponse('Tiles and saved overrides', 'CatalogWall'),
          404: { description: 'UNKNOWN_CATALOG' },
          500: { description: 'WALL_FAILED' },
        },
      },
    },
    '/catalogs/{catalog}/wall/overrides': {
      put: {
        summary: 'Save wall tile overrides',
        tags: ['Catalog'],
        description: 'Admin only. Saves a whole edit session at once. A chosen picture must be one of the user\u2019s own library files.',
        parameters: [subIdParam('catalog')],
        requestBody: jsonBody('WallEditInput'),
        responses: {
          200: jsonResponse('The saved overrides', 'WallOverridesResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'UNKNOWN_CATALOG' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
      delete: {
        summary: 'Reset the wall to automatic',
        tags: ['Catalog'],
        description: 'Admin only. Removes every override for the catalog.',
        parameters: [subIdParam('catalog')],
        responses: {
          200: jsonResponse('Empty overrides', 'WallOverridesResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'UNKNOWN_CATALOG' },
        },
      },
    },
    '/catalogs/wall/images/{objectId}': {
      get: {
        summary: 'Pictures a wall tile could show',
        tags: ['Catalog'],
        description: 'The user\u2019s own processed images, then the telescope stacks, for the tile image chooser.',
        parameters: [subIdParam('objectId')],
        responses: { 200: jsonResponse('The image choices', 'WallImagesResult') },
      },
    },

    // ── Forecast ──────────────────────────────────────────────────────
    '/forecast': {
      get: {
        summary: 'Weather and seeing forecast',
        tags: ['Forecast'],
        description: [
          'Hourly cloud, seeing, transparency, humidity, temperature, wind and rain chance for the resolved site, plus tonight\u2019s astro conditions and a night score for up to four nights.',
          'Served from a 5 minute cache when fresh and usable. `siteId` wins over `lat`/`lon`, which win over the active site. A stale entry is served rather than a failure when the upstream is unreachable.',
        ].join('\n'),
        parameters: [
          { name: 'siteId', in: 'query', schema: { type: 'string' } },
          { name: 'lat', in: 'query', schema: { type: 'number' }, description: 'Use with lon instead of a site' },
          { name: 'lon', in: 'query', schema: { type: 'number' } },
          { name: 'refresh', in: 'query', schema: { type: 'string', enum: ['1'] }, description: 'Fetch again, at most once past the minimum refresh age' },
        ],
        responses: {
          200: jsonResponse('The forecast', 'ForecastResponse'),
          400: { description: 'INVALID_COORDS' },
          500: { description: 'FORECAST_FAILED' },
        },
      },
    },
    '/forecast/outlook': {
      get: {
        summary: 'Two-week outlook from weather-model ensembles',
        tags: ['Forecast'],
        description: [
          'For each of the next 15 observing nights, the share of ensemble model runs (ECMWF, GEM and GFS, about 100 runs) that give at least `minClearHours` hours of the site\u2019s imaging window at or under `maxCloudCover`, with the spread of cloud cover, the odds per model and the Moon.',
          'Fetched from Open-Meteo\u2019s ensemble API and cached per site for 3 hours; a stale entry is served when a refresh fails. `siteId` wins over `lat`/`lon`, which win over the active site.',
        ].join('\n'),
        parameters: [
          { name: 'siteId', in: 'query', schema: { type: 'string' } },
          { name: 'lat', in: 'query', schema: { type: 'number' }, description: 'Use with lon instead of a site' },
          { name: 'lon', in: 'query', schema: { type: 'number' } },
          { name: 'maxCloudCover', in: 'query', schema: { type: 'number', minimum: 0, maximum: 100, default: 30 }, description: 'A usable hour has cloud cover at or under this (%)' },
          { name: 'minClearHours', in: 'query', schema: { type: 'number', minimum: 0.5, maximum: 12, default: 3 }, description: 'A usable night has at least this many such hours' },
        ],
        responses: {
          200: jsonResponse('The outlook', 'ForecastOutlook'),
          400: { description: 'INVALID_COORDS' },
          502: { description: 'OUTLOOK_UNAVAILABLE' },
        },
      },
    },

    // ── Gear ──────────────────────────────────────────────────────────
    '/gear/{id}/unarchive': {
      post: {
        summary: 'Bring a gear item out of the archive',
        tags: ['Gear'],
        description: 'Admin only.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('The unarchived item', 'GearItem'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
        },
      },
    },

    // ── Wishlist ──────────────────────────────────────────────────────
    '/wishlist/by-object/{objectId}': {
      delete: {
        summary: 'Remove a wishlist entry by catalog id',
        tags: ['Wishlist'],
        description: 'Admin only. The iOS and Android clients use this spelling; /wishlist/object/{objectId} is the same operation.',
        parameters: [{ name: 'objectId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('Whether an entry was removed', 'WishlistDeleted'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },

    // ── Night notes ───────────────────────────────────────────────────
    '/notes': {
      get: {
        summary: 'Every night note',
        tags: ['Notes'],
        description: 'Newest night first.',
        responses: { 200: jsonResponse('The notes', 'ObservationNote', true) },
      },
      post: {
        summary: 'Write or replace a night note',
        tags: ['Notes'],
        description: 'Admin only. A note for the same object and date is updated instead of duplicated. Moon phase and illumination are filled in from the date when not sent.',
        requestBody: jsonBody('NoteInput'),
        responses: {
          200: jsonResponse('The saved note', 'ObservationNote'),
          403: { description: 'FORBIDDEN. Admin only.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/notes/object/{objectId}': {
      get: {
        summary: "One object's night notes",
        tags: ['Notes'],
        description: 'Newest night first.',
        parameters: [subIdParam('objectId')],
        responses: { 200: jsonResponse('The notes', 'ObservationNote', true) },
      },
    },
    '/notes/object/{objectId}/{date}': {
      get: {
        summary: 'The note for one object and night',
        tags: ['Notes'],
        parameters: [subIdParam('objectId'), subIdParam('date')],
        responses: {
          200: {
            description: 'The note, or null when none exists yet',
            content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/ObservationNote' }, { type: 'null' }] } } },
          },
        },
      },
    },
    '/notes/{id}': {
      put: {
        summary: 'Change a night note',
        tags: ['Notes'],
        description: 'Admin only. Only the fields sent change.',
        parameters: [idParam],
        requestBody: jsonBody('NoteUpdateInput'),
        responses: {
          200: jsonResponse('The updated note', 'ObservationNote'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
      delete: {
        summary: 'Delete a night note',
        tags: ['Notes'],
        description: 'Admin only.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Deletion confirmed', 'NoteDeleted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
        },
      },
    },
    '/object-notes/{objectId}': {
      get: {
        summary: "One object's free-text note",
        tags: ['Notes'],
        parameters: [subIdParam('objectId')],
        responses: {
          200: {
            description: 'The note, or null when none exists',
            content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/ObjectNote' }, { type: 'null' }] } } },
          },
        },
      },
      put: {
        summary: 'Save or clear an object note',
        tags: ['Notes'],
        description: 'Admin only. Upserts: blank text clears the note, so a client can use one call for save and clear.',
        parameters: [subIdParam('objectId')],
        requestBody: jsonBody('ObjectNoteInput'),
        responses: {
          200: {
            description: 'The saved note, or null after a clear',
            content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/ObjectNote' }, { type: 'null' }] } } },
          },
          403: { description: 'FORBIDDEN. Admin only.' },
          422: { description: 'VALIDATION_ERROR. Notes are limited to 5000 characters.' },
        },
      },
      delete: {
        summary: 'Delete an object note',
        tags: ['Notes'],
        description: 'Admin only.',
        parameters: [subIdParam('objectId')],
        responses: {
          200: jsonResponse('Deletion confirmed', 'NoteDeleted'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },

    // ── Planned sessions ──────────────────────────────────────────────
    '/planned-sessions': {
      get: {
        summary: 'Planned imaging blocks',
        tags: ['Planner'],
        description: 'Blocks overlapping `from`..`to`, or every block without a range. Each carries a plan-vs-actual `outcome` computed from the library on read; `outcomes=0` skips that work and omits the field.',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'outcomes', in: 'query', schema: { type: 'string', enum: ['0', '1'] } },
        ],
        responses: {
          200: jsonResponse('The blocks', 'PlannedSessionWithOutcome', true),
          422: { description: 'VALIDATION_ERROR' },
        },
      },
      post: {
        summary: 'Schedule a block',
        tags: ['Planner'],
        description: 'Admin only. `endTime` must be after `startTime`.',
        requestBody: jsonBody('PlannedSessionCreateInput'),
        responses: {
          200: jsonResponse('The new block', 'PlannedSession'),
          403: { description: 'FORBIDDEN. Admin only.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/planned-sessions/nights': {
      get: {
        summary: 'Plan vs actual per object and night',
        tags: ['Planner'],
        description: 'Groups the blocks by observing night in the active site\u2019s zone and says how much of each plan was achieved.',
        parameters: [
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        ],
        responses: {
          200: jsonResponse('The per-night summaries', 'PlanNightSummary', true),
          422: { description: 'VALIDATION_ERROR. Dates must be YYYY-MM-DD and from <= to.' },
          500: { description: 'PLAN_OUTCOME_FAILED' },
        },
      },
    },
    '/planned-sessions/{id}': {
      patch: {
        summary: 'Move, resize or edit a block',
        tags: ['Planner'],
        description: 'Admin only. Only the fields sent change; `null` clears the filter or band. Marking `skipped` keeps the block but excludes it from the plan totals.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: jsonBody('PlannedSessionUpdateInput'),
        responses: {
          200: jsonResponse('The updated block', 'PlannedSession'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
      delete: {
        summary: 'Remove a block',
        tags: ['Planner'],
        description: 'Admin only.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          200: jsonResponse('Deletion confirmed', 'PlannedSessionDeleted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },

    // ── Observations ──────────────────────────────────────────────────
    '/observations': {
      get: {
        summary: 'Every imported observation',
        tags: ['Observations'],
        description: 'One row per object and observing night, across the whole local library. No SMB calls: data must be imported first.',
        responses: {
          200: jsonResponse('The observations', 'ObservationListItem', true),
          500: { description: 'LIST_FAILED' },
        },
      },
    },
    '/observations/locations': {
      get: {
        summary: 'Observation locations for the world map',
        tags: ['Observations'],
        description: 'Only observations whose session resolved to coordinates. `source` says whether the files recorded them or a site supplied them.',
        responses: {
          200: jsonResponse('The locations', 'ObservationLocation', true),
          500: { description: 'LOCATIONS_FAILED' },
        },
      },
    },
    '/observations/{objectId}/{date}': {
      get: {
        summary: 'One observation in full',
        tags: ['Observations'],
        description: 'The object, the night, its files, weather, capture runs and optical train. `coordinates` is null when nothing resolved.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        responses: {
          200: jsonResponse('The observation detail', 'ObservationDetail'),
          500: { description: 'FETCH_FAILED' },
        },
      },
    },

    // ── Telescope device files ────────────────────────────────────────
    '/telescope/objects/{objectId}/files': {
      get: {
        summary: 'Every file of one library object',
        tags: ['Telescope'],
        description: 'Reads the local library, never SMB. Thumbnails are filtered out unless `includeThumbnails=true`.',
        parameters: [
          subIdParam('objectId'),
          { name: 'fileType', in: 'query', schema: { type: 'string' }, description: 'Filter by parsed capture type' },
          { name: 'includeThumbnails', in: 'query', schema: { type: 'string', enum: ['true'] } },
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/limit' },
        ],
        responses: {
          200: jsonResponse('The files and pagination metadata', 'TelescopeFile', true),
          500: { description: 'LIST_FAILED' },
        },
      },
    },
    '/telescope/objects/{objectId}/subs': {
      get: {
        summary: 'Sub-frames of one library object',
        tags: ['Telescope'],
        description: 'Reads the local `_sub` or `_subs` folder. `date` filters to one observing night.',
        parameters: [
          subIdParam('objectId'),
          { name: 'fileType', in: 'query', schema: { type: 'string' } },
          { name: 'date', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Observing night' },
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/limit' },
        ],
        responses: {
          200: jsonResponse('The sub-frames, pagination and a per-night summary', 'TelescopeSubFrame', true),
          400: { description: 'INVALID_OBJECT_ID' },
          500: { description: 'LIST_FAILED' },
        },
      },
    },
    '/telescope/file': {
      get: {
        summary: 'Serve one library file',
        tags: ['Telescope'],
        description: 'Legacy browse endpoint. Answers with the file itself, or a bare `{ error }` object (not the API envelope) on failure. The path must sit under the library base path and name a real image file.',
        parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'Absolute path, as returned in a file row downloadUrl' }],
        responses: {
          200: { description: 'The file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          400: { description: '`{ error: "path required" }` or `{ error: "Not a real image file" }`', content: { 'application/json': { schema: { $ref: '#/components/schemas/TelescopeLegacyError' } } } },
          403: { description: '`{ error: "Invalid path" }`', content: { 'application/json': { schema: { $ref: '#/components/schemas/TelescopeLegacyError' } } } },
          404: { description: '`{ error: "File not found in local library" }`', content: { 'application/json': { schema: { $ref: '#/components/schemas/TelescopeLegacyError' } } } },
        },
      },
      delete: {
        summary: 'Delete one library file',
        tags: ['Telescope'],
        description: 'Admin only. Legacy endpoint: on success it answers a bare `{ deleted: true }`, and on failure a bare `{ error }`.',
        parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/TelescopeLegacyDeleted' } } } },
          400: { description: '`{ error: "path required" }`', content: { 'application/json': { schema: { $ref: '#/components/schemas/TelescopeLegacyError' } } } },
          403: { description: '`{ error: "Invalid path" }`', content: { 'application/json': { schema: { $ref: '#/components/schemas/TelescopeLegacyError' } } } },
          500: { description: '`{ error }`', content: { 'application/json': { schema: { $ref: '#/components/schemas/TelescopeLegacyError' } } } },
        },
      },
    },

    // ── Telescope profiles & status ───────────────────────────────────
    '/telescopes': {
      get: {
        summary: 'List telescope profiles',
        tags: ['Telescope'],
        description: 'Every profile with its transports, optical configs, rig, filters used and session count inline.',
        responses: { 200: jsonResponse('Array of profiles', 'TelescopeProfileListItem', true) },
      },
      post: {
        summary: 'Create telescope profile',
        tags: ['Telescope'],
        description: 'A telescope on a USB drive is paired with that drive straight away. Admin only.',
        requestBody: jsonBody('TelescopeProfileInput'),
        responses: {
          200: jsonResponse('New profile', 'TelescopeProfile'),
          409: { description: 'The drive belongs to another telescope (DRIVE_BELONGS_TO_OTHER or DRIVE_SWAP_NEEDED)' },
          422: { description: 'Validation error' },
        },
      },
    },
    '/telescopes/{id}': {
      put: {
        summary: 'Update telescope profile',
        tags: ['Telescope'],
        description: 'Admin only. Only the fields in the request body change.',
        parameters: [idParam],
        requestBody: jsonBody('TelescopeProfileInput'),
        responses: { 200: jsonResponse('Updated profile', 'TelescopeProfile'), 404: notFound, 409: { description: 'Drive pairing conflict' }, 422: { description: 'Validation error' } },
      },
      delete: {
        summary: 'Delete telescope profile',
        tags: ['Telescope'],
        description: 'Admin only.',
        parameters: [idParam],
        responses: { 200: deleted, 400: { description: 'Cannot delete the only profile' }, 404: notFound },
      },
    },
    '/telescopes/{id}/archive': {
      post: { summary: 'Archive telescope profile', tags: ['Telescope'], description: 'Admin only.', parameters: [idParam], responses: { 200: { description: 'Archived' }, 404: notFound } },
    },
    '/telescopes/{id}/unarchive': {
      post: { summary: 'Unarchive telescope profile', tags: ['Telescope'], description: 'Admin only.', parameters: [idParam], responses: { 200: { description: 'Unarchived' }, 404: notFound } },
    },
    '/telescopes/{id}/reassign-all': {
      post: {
        summary: 'Move every observation to another telescope',
        tags: ['Telescope'],
        description: 'Admin only. Source and destination must differ.',
        parameters: [idParam],
        requestBody: jsonBody('TelescopeReassignInput'),
        responses: { 200: { description: 'Number of observations moved' }, 400: { description: 'Source and destination are the same' }, 404: { description: 'Source or destination not found' }, 422: { description: 'Validation error' } },
      },
    },
    '/telescopes/{id}/transports': {
      get: { summary: 'List a telescope\'s transports', tags: ['Telescope'], description: 'Admin only. Passwords are masked.', parameters: [idParam], responses: { 200: jsonResponse('Transports', 'TelescopeTransport', true), 404: notFound } },
      post: {
        summary: 'Add a transport',
        tags: ['Telescope'],
        description: 'Admin only. Dwarf telescopes refuse SMB and ASIAIR refuses FTP. Send `replaceDrive: true` to confirm swapping a paired USB drive.',
        parameters: [idParam],
        requestBody: jsonBody('TelescopeTransportInput'),
        responses: { 200: jsonResponse('New transport, with the drive pairing outcome', 'TelescopeTransport'), 404: notFound, 409: { description: 'Drive pairing conflict' }, 422: { description: 'Validation error' } },
      },
    },
    '/telescopes/{id}/transports/{tid}': {
      put: {
        summary: 'Update a transport',
        tags: ['Telescope'],
        description: 'Admin only.',
        parameters: [idParam, subIdParam('tid')],
        requestBody: jsonBody('TelescopeTransportInput'),
        responses: { 200: jsonResponse('Updated transport', 'TelescopeTransport'), 404: { description: 'Profile or transport not found' }, 409: { description: 'Drive pairing conflict' }, 422: { description: 'Validation error' } },
      },
      delete: { summary: 'Remove a transport', tags: ['Telescope'], description: 'Admin only.', parameters: [idParam, subIdParam('tid')], responses: { 200: deleted, 404: { description: 'Profile or transport not found' } } },
    },
    '/telescopes/{id}/optical-configs': {
      get: { summary: 'List optical configs', tags: ['Telescope'], description: 'Admin only.', parameters: [idParam], responses: { 200: jsonResponse('Optical configs', 'TelescopeOpticalConfig', true), 404: notFound } },
      post: {
        summary: 'Add an optical config',
        tags: ['Telescope'],
        description: 'Admin only. Drives the field of view in Framing & Mosaic for telescopes with no fixed one.',
        parameters: [idParam],
        requestBody: jsonBody('TelescopeOpticalConfigInput'),
        responses: { 200: jsonResponse('New config', 'TelescopeOpticalConfig'), 404: notFound, 422: { description: 'Validation error' } },
      },
    },
    '/telescopes/{id}/optical-configs/{cid}': {
      put: {
        summary: 'Update an optical config',
        tags: ['Telescope'],
        description: 'Admin only.',
        parameters: [idParam, subIdParam('cid')],
        requestBody: jsonBody('TelescopeOpticalConfigInput'),
        responses: { 200: jsonResponse('Updated config', 'TelescopeOpticalConfig'), 404: { description: 'Profile or config not found' }, 422: { description: 'Validation error' } },
      },
      delete: { summary: 'Delete an optical config', tags: ['Telescope'], description: 'Admin only.', parameters: [idParam, subIdParam('cid')], responses: { 200: deleted, 404: { description: 'Profile or config not found' } } },
    },
    '/telescopes/{id}/rig': {
      put: {
        summary: 'Set the rig (sensor type and filters)',
        tags: ['Telescope'],
        description: 'Admin only. Used to suggest integration goals.',
        parameters: [idParam],
        requestBody: jsonBody('TelescopeRigInput'),
        responses: { 200: jsonResponse('Saved rig', 'TelescopeRig'), 404: notFound, 422: { description: 'Validation error' } },
      },
    },
    '/telescopes/{id}/photo': {
      get: {
        summary: 'Get the telescope picture',
        tags: ['Telescope'],
        description: 'Served as WebP. Add `?v=<photoVersion>` so a changed picture is a new URL.',
        parameters: [idParam],
        responses: { 200: { description: 'WebP image', content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } } }, 404: { description: 'This telescope has no picture' } },
      },
      put: {
        summary: 'Upload the telescope picture',
        tags: ['Telescope'],
        description: 'Admin only. Multipart with one image in the `file` field.',
        parameters: [idParam],
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } } } },
        responses: { 200: { description: 'The new photoVersion' }, 413: { description: 'FILE_TOO_LARGE' }, 422: { description: 'Not a usable picture' } },
      },
      delete: { summary: 'Remove the telescope picture', tags: ['Telescope'], description: 'Admin only.', parameters: [idParam], responses: { 200: deleted } },
    },
    '/telescopes/status': {
      get: {
        summary: 'Telescope online status',
        tags: ['Telescope'],
        description: 'Probes the configured transport to determine reachability: TCP port 445 for SMB profiles, port 21 for FTP (Dwarf), or a filesystem stat for USB. Result is cached for 30 seconds.',
        responses: {
          200: {
            description: 'Status object',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TelescopeStatus' } } },
          },
        },
      },
    },

    '/telescopes/status/all': {
      get: { summary: 'Online status of every telescope', tags: ['Telescope'], description: 'Same probe as `/telescopes/status`, one entry per profile.', responses: { 200: { description: 'Array of status objects' } } },
    },
    '/telescopes/test-connection': {
      post: {
        summary: 'Test a connection',
        tags: ['Telescope'],
        description: 'Admin only. Lists the device over SMB or FTP. A failed connection is a 200 with `connected: false` and an `error`.',
        requestBody: jsonBody('TelescopeTestConnectionInput'),
        responses: { 200: { description: '`{ connected, objectCount?, remoteRoot?, error? }`' } },
      },
    },
    '/telescopes/probe-identity': {
      post: {
        summary: 'Read or create the device identity marker',
        tags: ['Telescope'],
        description: 'Admin only. Reads `.nebulis.dat` on the device and, unless identity tracking is off, writes it when missing.',
        requestBody: jsonBody('TelescopeProbeIdentityInput'),
        responses: { 200: { description: '`{ deviceId, alreadyKnownProfileId, alreadyKnownProfileName, wrote, readonly }`' } },
      },
    },
    '/telescopes/scan': {
      post: { summary: 'Scan the network for telescopes', tags: ['Telescope'], description: 'Admin only.', responses: { 200: { description: 'Devices found' } } },
    },
    '/telescopes/drives': {
      get: { summary: 'List connected drives', tags: ['Telescope'], description: 'Admin only. Each drive says whether it looks like a SeeStar or Dwarf and whether it is already paired.', responses: { 200: { description: '`{ drives: [...] }`' } } },
    },
    '/telescopes/dwarf-mounts': {
      get: { summary: 'List mounted Dwarf USB volumes', tags: ['Telescope'], description: 'An empty array is normal when no Dwarf is plugged into the server.', responses: { 200: { description: '`{ mounts: [...] }`' } } },
    },

    // ── SMB library (live from telescope) ────────────────────────────
    '/telescope/objects': {
      get: {
        summary: 'List imaged objects',
        tags: ['Library (SMB)'],
        description: 'Lists all objects found on the telescope SMB share, falling back to local cache when offline.',
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/limit' },
          { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Filter by object type' },
          { name: 'search', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Paginated list of objects' } },
      },
    },
    '/telescope/objects/{objectId}': {
      get: {
        summary: 'Get object detail',
        tags: ['Library (SMB)'],
        parameters: [{ $ref: '#/components/parameters/objectId' }],
        responses: { 200: { description: 'Object with session count and integration time' }, 404: { description: 'Not found' } },
      },
    },
    '/telescope/objects/{objectId}/thumbnail': {
      get: {
        summary: 'Object thumbnail',
        tags: ['Library (SMB)'],
        parameters: [{ $ref: '#/components/parameters/objectId' }, { $ref: '#/components/parameters/format' }],
        responses: { 200: { description: 'JPEG binary, or base64 JSON when ?format=base64' } },
      },
    },
    '/telescope/objects/{objectId}/sessions': {
      get: {
        summary: 'List sessions for an object',
        tags: ['Library (SMB)'],
        parameters: [
          { $ref: '#/components/parameters/objectId' },
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/limit' },
        ],
        responses: { 200: { description: 'Paginated list of sessions' } },
      },
    },
    '/telescope/objects/{objectId}/sessions/{sessionId}/files': {
      get: {
        summary: 'List files in a session',
        tags: ['Library (SMB)'],
        parameters: [
          { $ref: '#/components/parameters/objectId' },
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'fileType', in: 'query', schema: { type: 'string', enum: [...FILE_CATEGORIES] } },
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/limit' },
        ],
        responses: { 200: { description: 'File list with type counts' } },
      },
    },
    '/telescope/files': {
      get: {
        summary: 'Download a file',
        tags: ['Library (SMB)'],
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/format' },
        ],
        responses: { 200: { description: 'File binary or base64 JSON' } },
      },
      delete: {
        summary: 'Delete a file',
        tags: ['Library (SMB)'],
        parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deletion confirmed' } },
      },
    },
    '/telescope/test': {
      get: { summary: 'Test SMB connection', tags: ['Library (SMB)'], responses: { 200: { description: 'Connection OK with object count' }, 502: { description: 'Connection failed' } } },
    },

    // ── Local library (imported copies) ──────────────────────────────
    '/library/objects': {
      get: {
        summary: 'List locally imported objects',
        tags: ['Library (Local)'],
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/limit' },
          { name: 'search', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Paginated local object list' } },
      },
    },
    '/library/objects/{objectId}/thumbnail': {
      get: {
        summary: 'Local object thumbnail',
        tags: ['Library (Local)'],
        parameters: [{ $ref: '#/components/parameters/objectId' }, { $ref: '#/components/parameters/format' }],
        responses: { 200: { description: 'JPEG binary or base64 JSON' } },
      },
    },
    '/library/objects/{objectId}/sessions': {
      get: {
        summary: 'List local sessions for an object',
        tags: ['Library (Local)'],
        description: 'Newest night first. With `includeVariants=true`, sessions from the object and all its Mosaic/Ha variants are merged and tagged with their source.',
        parameters: [
          { $ref: '#/components/parameters/objectId' },
          { name: 'includeVariants', in: 'query', schema: { type: 'string', enum: ['true'] } },
        ],
        responses: {
          200: jsonResponse('The sessions', 'LibrarySession', true),
          500: { description: 'LIST_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/files': {
      get: {
        summary: 'List files in a local session',
        tags: ['Library (Local)'],
        parameters: [
          { $ref: '#/components/parameters/objectId' },
          { name: 'date', in: 'path', required: true, schema: { type: 'string' }, description: 'Session date YYYY-MM-DD' },
        ],
        responses: { 200: { description: 'File list' } },
      },
    },
    '/library/objects/{objectId}/files': {
      get: {
        summary: 'List all local files for an object',
        tags: ['Library (Local)'],
        parameters: [{ $ref: '#/components/parameters/objectId' }],
        responses: { 200: { description: 'File list across all sessions' } },
      },
    },
    '/library/objects/{objectId}/integration/filters': {
      get: {
        summary: 'Integration per filter and per night, with goals',
        tags: ['Library (Local)'],
        description: 'Groups light sub-frames (managed and linked folders) by canonical filter name, then by observing night. Filter comes from the FITS FILTER keyword, then the capture sidecar, else the "no filter" bucket (filter: null). Filters that only have a goal are listed after the others.',
        parameters: [{ $ref: '#/components/parameters/objectId' }],
        responses: {
          200: {
            description: 'Integration breakdown',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/IntegrationBreakdown' } } },
          },
        },
      },
    },
    '/library/objects/{objectId}/integration/goals': {
      put: {
        summary: 'Replace the integration goals of an object (admin)',
        tags: ['Library (Local)'],
        description: 'Replaces every goal on the object. Filter names are normalised with the same aliases as frames; goalSec 0 removes a goal.',
        parameters: [{ $ref: '#/components/parameters/objectId' }],
        requestBody: {
          content: { 'application/json': { schema: {
            type: 'object',
            properties: { goals: { type: 'array', items: { $ref: '#/components/schemas/IntegrationGoal' } } },
          } } },
        },
        responses: { 200: { description: 'Goals now stored' }, 422: { description: 'Invalid goal' } },
      },
    },
    '/library/integration/progress': {
      get: {
        summary: 'Progress toward integration goals, for every object that has one',
        tags: ['Library (Local)'],
        description: 'Used by the Planner and Wishlist to show the time left per filter. Objects without goals are omitted.',
        responses: {
          200: {
            description: 'Progress per object',
            content: { 'application/json': { schema: { type: 'array', items: {
              type: 'object',
              properties: {
                objectId: strEx('NGC6888'),
                complete: { type: 'boolean' },
                filters: { type: 'array', items: {
                  type: 'object',
                  properties: {
                    filter:       nullable(strEx('D2')),
                    goalSec:      { type: 'integer' },
                    exposureSec:  { type: 'integer' },
                    remainingSec: { type: 'integer' },
                  },
                } },
              },
            } } } },
          },
        },
      },
    },
    '/library/filter-aliases': {
      get: {
        summary: 'List user-defined filter name aliases',
        tags: ['Library (Local)'],
        responses: { 200: { description: 'Aliases', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/FilterAlias' } } } } } },
      },
      put: {
        summary: 'Replace the filter name aliases (admin)',
        tags: ['Library (Local)'],
        requestBody: {
          content: { 'application/json': { schema: {
            type: 'object',
            properties: { aliases: { type: 'array', items: { $ref: '#/components/schemas/FilterAlias' } } },
          } } },
        },
        responses: { 200: { description: 'Aliases now stored' }, 422: { description: 'Invalid alias' } },
      },
    },
    '/library/file': {
      get: {
        summary: 'Download a local library file',
        tags: ['Library (Local)'],
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/format' },
        ],
        responses: { 200: { description: 'File binary or base64 JSON' } },
      },
      delete: {
        summary: 'Delete one library file',
        tags: ['Library (Local)'],
        description: 'Admin only. A file in a linked folder needs `confirmLinked=1` when Nebulis holds no other copy.',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'confirmLinked', in: 'query', schema: { type: 'string', enum: ['1'] } },
        ],
        responses: {
          200: jsonResponse('Deleted', 'LibraryFileDeleted'),
          400: { description: 'MISSING_PATH' },
          403: { description: 'FORBIDDEN. Admin only, or the path is outside the library.' },
          409: { description: 'LINKED_DELETE_UNCONFIRMED or LINKED_SOURCE_UNAVAILABLE' },
          500: { description: 'DELETE_FAILED' },
        },
      },
    },
    '/library/video': {
      get: {
        summary: 'Stream a local video file (inline, byte-range)',
        tags: ['Library (Local)'],
        description: 'Range-capable stream for a library `.mp4` / `.mov` / `.avi`, served `Content-Disposition: inline` so a `<video>` element or a native AVPlayer/ExoPlayer can play it. Use `/library/file` to download instead.',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Full video stream' },
          206: { description: 'Partial content (range request)' },
          415: { description: 'Not a supported video extension' },
        },
      },
    },
    '/library/import': {
      post: {
        summary: 'Trigger library import',
        tags: ['Library (Local)'],
        description: 'Starts a background import from the telescope into local storage, over whichever transport the profile resolves to (SMB, FTP, or a USB mount). With no body, imports from the active telescope.',
        requestBody: jsonBody('LibraryImportInput', false),
        responses: { 200: { description: 'Import started or already running' }, 422: { description: 'VALIDATION_ERROR' } },
      },
    },
    '/library/import/status': {
      get: {
        summary: 'Import status',
        tags: ['Library (Local)'],
        responses: { 200: jsonResponse('Running state and progress', 'LibraryImportStatus') },
      },
    },
    '/library/import/history': {
      get: {
        summary: 'Sync history',
        tags: ['Library (Local)'],
        description: 'Runs that imported new files, failed, or were explicitly triggered. A routine scheduled tick that found nothing new stays hidden.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: { 200: jsonResponse('History entries and the total', 'LibraryImportHistory') },
      },
    },
    '/library/import/cancel': {
      post: {
        summary: 'Cancel the running import',
        tags: ['Library (Local)'],
        description: 'Admin only. `runId` cancels exactly the run that was started; omit it to cancel whatever is running.',
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { runId: { type: 'string' } } } } } },
        responses: {
          200: { description: 'Cancellation requested', content: { 'application/json': { schema: { type: 'object', required: ['cancelled'], properties: { cancelled: { type: 'boolean', const: true } } } } } },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/import/debug-event': {
      post: {
        summary: 'Log a browser import event',
        tags: ['Library (Local)'],
        description: 'Admin only. A no-op unless debug capture is on. Used by the manual upload flow to leave a trace next to the server log.',
        requestBody: jsonBody('LibraryDebugEventInput'),
        responses: {
          200: jsonResponse('Whether it was logged', 'LibraryDebugEventResult'),
          400: { description: 'INVALID_EVENT' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/import/scan': {
      post: {
        summary: 'Scan a folder for import',
        tags: ['Library (Local)'],
        description: 'Admin only. Phase 1 of the folder-import wizard. Read-only: copies nothing and does not claim the import lock.',
        requestBody: jsonBody('LibraryImportScanInput'),
        responses: {
          200: jsonResponse('The import plan', 'LibraryImportScanResult'),
          400: { description: 'MISSING_PATH, INVALID_PATH or VALIDATION_ERROR' },
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'SCAN_FAILED' },
        },
      },
    },
    '/library/import/commit': {
      post: {
        summary: 'Commit a reviewed import plan',
        tags: ['Library (Local)'],
        description: 'Admin only. Phase 2 of the folder-import wizard. The folder is re-walked server-side, so only the decisions are trusted. Runs in the background; progress shows on the import status.',
        requestBody: jsonBody('LibraryImportCommitInput'),
        responses: {
          200: jsonResponse('The import started', 'LibraryImportCommitResult'),
          400: { description: 'VALIDATION_ERROR or INVALID_PATH' },
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'An import is already running' },
        },
      },
    },
    '/library/import/preflight': {
      post: {
        summary: 'Check room for an upload',
        tags: ['Library (Local)'],
        description: 'Admin only. Called with the total byte size before a manual upload starts, so a doomed upload is refused in the dialog.',
        requestBody: jsonBody('LibraryImportPreflightInput'),
        responses: {
          200: jsonResponse('Whether there is room', 'LibraryImportPreflightResult'),
          400: { description: 'VALIDATION_ERROR' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/import/temp/{tmpId}': {
      delete: {
        summary: 'Discard an upload staging session',
        tags: ['Library (Local)'],
        description: 'Admin only. Reclaims an abandoned upload immediately instead of waiting for the sweeper.',
        parameters: [subIdParam('tmpId')],
        responses: {
          200: jsonResponse('What was reclaimed', 'LibraryTempPurgeResult'),
          400: { description: 'INVALID_TMP_ID' },
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'IMPORT_RUNNING' },
        },
      },
    },
    '/library/import/upload-temp': {
      post: {
        summary: 'Upload a folder for import',
        tags: ['Library (Local)'],
        description: 'Admin only. multipart/form-data: the browser sends the folder\'s files under a UUID staging directory and receives its path for /import/scan.',
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: { type: 'object', additionalProperties: { type: 'string', format: 'binary' } } } },
        },
        responses: {
          200: jsonResponse('The staging path and file count', 'LibraryUploadTempResult'),
          400: { description: 'No files, or an invalid upload' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/sources': {
      get: {
        summary: 'Linked folders',
        tags: ['Library (Local)'],
        description: 'Admin only. Each source with live file, object and byte counts, and whether its folder is reachable now.',
        responses: {
          200: jsonResponse('The linked sources', 'LibrarySources'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
      post: {
        summary: 'Link a folder in place',
        tags: ['Library (Local)'],
        description: 'Admin only. Indexes the folder without copying bytes. Accepts per-directory attribution overrides and an optional automatic rescan interval.',
        requestBody: jsonBody('LibrarySourceCommitInput'),
        responses: {
          200: jsonResponse('What was linked', 'LibrarySourceCommitResult'),
          400: { description: 'VALIDATION_ERROR' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'SOURCE_NOT_FOUND' },
          409: { description: 'ALREADY_LINKED, ALREADY_IMPORTED or an import is running' },
        },
      },
    },
    '/library/sources/scan': {
      post: {
        summary: 'Preview a linked folder',
        tags: ['Library (Local)'],
        description: 'Admin only. Scans and attributes the folder without writing anything.',
        requestBody: jsonBody('LibrarySourceScanInput'),
        responses: {
          200: jsonResponse('The attribution plan', 'LibrarySourceScanResult'),
          400: { description: 'MISSING_PATH or an invalid folder' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'SOURCE_NOT_FOUND' },
        },
      },
    },
    '/library/sources/{id}': {
      patch: {
        summary: 'Change a linked folder',
        tags: ['Library (Local)'],
        description: 'Admin only. At least one of label, refreshIntervalMin or analyzeFrames is required.',
        parameters: [idParam],
        requestBody: jsonBody('LibrarySourceUpdateInput'),
        responses: {
          200: jsonResponse('The updated source', 'LibrarySource'),
          400: { description: 'VALIDATION_ERROR' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'SOURCE_NOT_FOUND' },
        },
      },
      delete: {
        summary: 'Unlink a folder',
        tags: ['Library (Local)'],
        description: 'Admin only. Drops the index rows, never the files. Objects left with nothing are soft-deleted.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('What was unlinked', 'LibrarySourceDeleted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'SOURCE_NOT_FOUND' },
        },
      },
    },
    '/library/sources/{id}/rescan': {
      post: {
        summary: 'Rescan a linked folder',
        tags: ['Library (Local)'],
        description: 'Admin only. Adds new files, updates changed ones and marks missing ones; an offline folder is reported without touching anything. A file that stays missing is removed from the index on a scan 24 hours or more after it was first flagged, or at once with removeMissing=true.',
        parameters: [idParam, { name: 'removeMissing', in: 'query', schema: { type: 'boolean', default: false }, description: 'Drop files this scan cannot find from the index now, without the 24 hour wait. Never deletes anything on disk.' }],
        responses: {
          200: jsonResponse('What the scan found', 'LibrarySourceRescanResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'SOURCE_NOT_FOUND' },
          409: { description: 'An import is running' },
        },
      },
    },
    '/library/redirects': {
      get: {
        summary: 'Designation redirects',
        tags: ['Library (Local)'],
        description: 'Designations future imports are told to file under another object.',
        responses: { 200: jsonResponse('The redirects', 'LibraryRedirects') },
      },
    },
    '/library/redirects/{designation}': {
      put: {
        summary: 'Remember a reclassification',
        tags: ['Library (Local)'],
        description: 'Admin only. Files the designation under the target object on future imports.',
        parameters: [subIdParam('designation')],
        requestBody: jsonBody('LibraryRedirectInput'),
        responses: {
          200: jsonResponse('The redirect list after the change', 'LibraryRedirects'),
          400: { description: 'BAD_REQUEST' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
      delete: {
        summary: 'Forget a reclassification',
        tags: ['Library (Local)'],
        description: 'Admin only.',
        parameters: [subIdParam('designation')],
        responses: {
          200: jsonResponse('The redirect list after the change', 'LibraryRedirects'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/calibrations': {
      get: {
        summary: 'The calibration library',
        tags: ['Library (Local)'],
        description: 'Bias, dark, flat and flat-dark frames from the archive, grouped by type and then by the capture settings a stacking app matches on. Flats and flat-darks carry their attachments.',
        responses: {
          200: jsonResponse('The calibration groups', 'LibraryCalibrations'),
          500: { description: 'CALIBRATIONS_LIST_FAILED' },
        },
      },
    },
    '/library/calibrations/attachments': {
      get: {
        summary: "Calibration bundles attached to an object",
        tags: ['Library (Local)'],
        description: 'Every attachment on the object, or with `date` just what resolves for that session (a session pick replaces the whole-object ones for that type).',
        parameters: [
          { name: 'objectId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: {
          200: jsonResponse('The attachments', 'LibraryCalibrationAttachments'),
          400: { description: 'MISSING_OBJECT_ID' },
        },
      },
    },
    '/library/calibrations/attach': {
      post: {
        summary: 'Attach a flat or flat-dark bundle',
        tags: ['Library (Local)'],
        description: 'Admin only. Only flats and flat-darks attach; bias and darks stay in the shared pool.',
        requestBody: jsonBody('LibraryCalibrationAttachInput'),
        responses: {
          200: jsonResponse('The attachment', 'LibraryCalibrationAttached'),
          400: { description: 'INVALID_BODY or NOT_ATTACHABLE' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'BUNDLE_NOT_FOUND or OBJECT_NOT_FOUND' },
        },
      },
    },
    '/library/calibrations/attach/{id}': {
      delete: {
        summary: 'Detach a calibration bundle',
        tags: ['Library (Local)'],
        description: 'Admin only. Removes the pointer only, never the files.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Detached', 'LibraryCalibrationDetached'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'ATTACHMENT_NOT_FOUND' },
        },
      },
    },
    '/library/calibrations/bundle': {
      delete: {
        summary: 'Delete a bias or dark bundle',
        tags: ['Library (Local)'],
        description: 'Admin only and destructive. Deletes the files of one bias/dark bundle. Flats and flat-darks are detached instead.',
        requestBody: jsonBody('LibraryCalibrationDeleteInput'),
        responses: {
          200: jsonResponse('Deleted and failed counts', 'LibraryCalibrationDeleteResult'),
          400: { description: 'INVALID_BODY or NOT_DELETABLE_HERE' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'BUNDLE_NOT_FOUND' },
        },
      },
    },
    '/library/calibrations/download/link': {
      post: {
        summary: 'Mint a calibration bundle download link',
        tags: ['Library (Local)'],
        description: 'Returns a short-lived signed URL for a browser download. The bundle is re-derived from a fresh scan when the URL is used.',
        requestBody: jsonBody('LibraryCalibrationDeleteInput'),
        responses: {
          200: jsonResponse('The signed URL and filename', 'LibraryCalibrationLinkResult'),
          400: { description: 'INVALID_BODY' },
          404: { description: 'BUNDLE_NOT_FOUND' },
        },
      },
    },
    '/library/calibrations/download/{id}': {
      get: {
        summary: 'Download a calibration bundle',
        tags: ['Library (Local)'],
        description: 'Consumes the signed link and streams the bundle as a ZIP.',
        parameters: [subIdParam('id')],
        responses: {
          200: { description: 'The ZIP', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } },
          400: { description: 'INVALID_BUNDLE_ID' },
          404: { description: 'BUNDLE_NOT_FOUND' },
          500: { description: 'Archive failed' },
        },
      },
    },

    // ── Library: objects and sessions ────────────────────────────────
    '/library/objects/deleted': {
      get: {
        summary: 'Deleted objects (trash)',
        tags: ['Library (Local)'],
        description: 'Admin only. Tombstoned objects, most recently deleted first.',
        responses: {
          200: jsonResponse('The deleted objects', 'LibraryDeletedObject', true),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/objects/deleted-sessions': {
      get: {
        summary: 'Deleted sessions (trash)',
        tags: ['Library (Local)'],
        description: 'Admin only. Tombstoned sessions of objects that are not themselves deleted.',
        responses: {
          200: jsonResponse('The deleted sessions', 'LibraryDeletedSession', true),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/objects/{objectId}': {
      get: {
        summary: 'One library object',
        tags: ['Library (Local)'],
        description: 'The same row GET /library/objects returns, with variants merged. Requesting a variant id returns its primary with the variant listed.',
        parameters: [subIdParam('objectId')],
        responses: {
          200: jsonResponse('The object', 'LibraryObject'),
          404: { description: 'NOT_FOUND' },
          500: { description: 'GET_FAILED' },
        },
      },
      delete: {
        summary: 'Delete an object',
        tags: ['Library (Local)'],
        description: 'Admin only. Leaves a tombstone so a re-sync does not bring it back. Originals in a linked folder are kept unless `deleteLinkedFiles=1`.',
        parameters: [
          subIdParam('objectId'),
          { name: 'deleteLinkedFiles', in: 'query', schema: { type: 'string', enum: ['1'] } },
        ],
        responses: {
          200: jsonResponse('Deletion confirmed', 'LibraryObjectDeleted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'LINKED_SOURCE_UNAVAILABLE, or the library is busy' },
          500: { description: 'DELETE_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/restore': {
      post: {
        summary: 'Restore a deleted object',
        tags: ['Library (Local)'],
        description: 'Admin only.',
        parameters: [subIdParam('objectId')],
        responses: {
          200: jsonResponse('Restored', 'LibraryRestored'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/objects/{objectId}/reclassify': {
      post: {
        summary: 'Reclassify an object',
        tags: ['Library (Local)'],
        description: 'Admin only. Renames, or merges when the target catalog id already exists. A merge moves the source folder files and reports any that would have overwritten a file.',
        parameters: [subIdParam('objectId')],
        requestBody: jsonBody('LibraryReclassifyInput'),
        responses: {
          200: jsonResponse('How the object was reclassified', 'LibraryReclassifyResult'),
          400: { description: 'BAD_REQUEST or RECLASSIFY_FAILED' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/objects/{objectId}/location': {
      get: {
        summary: "Where an object's files live",
        tags: ['Library (Local)'],
        description: 'Absolute paths for the object folder and, with `date`, the session folder, plus any linked source folders. Without `date` the whole variant family is included.',
        parameters: [
          subIdParam('objectId'),
          { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: {
          200: jsonResponse('The locations', 'LibraryObjectLocationResult'),
          500: { description: 'LOCATION_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/linked-files': {
      get: {
        summary: 'What deleting would take from a linked folder',
        tags: ['Library (Local)'],
        description: 'Admin only. The delete dialogs ask this so they offer the choice only when there is something to choose.',
        parameters: [
          subIdParam('objectId'),
          { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: {
          200: jsonResponse('File count, bytes and folder labels', 'LibraryLinkedFiles'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/objects/{objectId}/processing-status': {
      put: {
        summary: "Set an object's processing status",
        tags: ['Library (Local)'],
        description: 'Admin only.',
        parameters: [subIdParam('objectId')],
        requestBody: jsonBody('LibraryProcessingStatusInput'),
        responses: {
          200: jsonResponse('The stored status', 'LibraryProcessingStatusResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}': {
      delete: {
        summary: 'Delete one session',
        tags: ['Library (Local)'],
        description: 'Admin only. Deletes the session files and tombstones the date so a re-sync does not bring it back.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        responses: {
          200: { description: 'Deletion confirmed', content: { 'application/json': { schema: { type: 'object', required: ['deleted', 'objectId', 'date'], properties: { deleted: { type: 'boolean', const: true }, objectId: { type: 'string' }, date: { type: 'string' } } } } } },
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'The library is busy' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/restore': {
      post: {
        summary: 'Restore a deleted session',
        tags: ['Library (Local)'],
        description: 'Admin only.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        responses: {
          200: jsonResponse('Restored', 'LibraryRestored'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/subframes': {
      delete: {
        summary: 'Delete a session\u2019s sub-frames',
        tags: ['Library (Local)'],
        description: 'Admin only. Removes only the raw sub-frames; stacked images and everything else stay.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        responses: {
          200: jsonResponse('How many were deleted', 'LibrarySessionSubframesDeleted'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/move': {
      post: {
        summary: 'Move a session to another object',
        tags: ['Library (Local)'],
        description: 'Admin only. Moves the session\u2019s files and records.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        requestBody: jsonBody('LibrarySessionMoveInput'),
        responses: {
          200: jsonResponse('What moved', 'LibrarySessionMoveResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/telescope': {
      put: {
        summary: 'Reassign a session\u2019s telescope',
        tags: ['Library (Local)'],
        description: 'Admin only.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        requestBody: jsonBody('LibraryTelescopeInput'),
        responses: {
          200: jsonResponse('Updated', 'LibrarySessionUpdated'),
          400: { description: 'BAD_REQUEST' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/optics': {
      put: {
        summary: "Set a session's optical configuration",
        tags: ['Library (Local)'],
        description: 'Admin only. `null` goes back to the configuration matched from the FITS focal length.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        requestBody: jsonBody('LibraryOpticsInput'),
        responses: {
          200: jsonResponse('Updated', 'LibrarySessionUpdated'),
          400: { description: 'BAD_REQUEST' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
          422: { description: 'That configuration does not belong to the session\u2019s telescope' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/site': {
      put: {
        summary: "Reassign a session's observing site",
        tags: ['Library (Local)'],
        description: 'Admin only. `null` clears the tag. Weather is refetched at the new coordinates before the response.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        requestBody: jsonBody('LibrarySiteInput'),
        responses: {
          200: jsonResponse('Updated', 'LibrarySessionUpdated'),
          400: { description: 'BAD_REQUEST' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND or SITE_NOT_FOUND' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/sync': {
      post: {
        summary: 'Sync one session from the telescope',
        tags: ['Library (Local)'],
        description: 'Admin only. Runs in the background and uses the telescope that captured the session.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        responses: {
          200: jsonResponse('Sync started', 'LibrarySyncStarted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'An import is already running' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/sync-subframes': {
      post: {
        summary: 'Sync one session\u2019s sub-frames',
        tags: ['Library (Local)'],
        description: 'Admin only. Fetches only the raw sub-frames matching that night.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        responses: {
          200: jsonResponse('Sync started', 'LibrarySyncStarted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'An import is already running' },
        },
      },
    },
    '/library/objects/{objectId}/sync-subframes': {
      post: {
        summary: "Sync every night's sub-frames for an object",
        tags: ['Library (Local)'],
        description: 'Admin only. Runs the per-session sync once per night, each against its own telescope.',
        parameters: [subIdParam('objectId')],
        responses: {
          200: jsonResponse('Sync started', 'LibrarySyncStarted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'An import is already running' },
        },
      },
    },
    '/library/objects/{objectId}/capture': {
      get: {
        summary: 'Recorded capture runs for an object',
        tags: ['Library (Local)'],
        description: 'Every capture run the telescope\u2019s sidecar recorded, newest session first.',
        parameters: [subIdParam('objectId')],
        responses: {
          200: {
            description: 'Per observing night, the rolled-up capture summary',
            content: { 'application/json': { schema: { type: 'object', additionalProperties: { $ref: '#/components/schemas/ObservationCaptureSummary' } } } },
          },
        },
      },
    },
    '/library/objects/{objectId}/stacked-images': {
      get: {
        summary: 'Stacked images of an object',
        tags: ['Library (Local)'],
        parameters: [subIdParam('objectId')],
        responses: { 200: jsonResponse('The stacked images', 'LibraryStackedImage', true) },
      },
    },
    '/library/object-filters': {
      get: {
        summary: 'Library type filter chips',
        tags: ['Library (Local)'],
        description: 'The chips the library grid offers, with the type strings each one matches.',
        responses: { 200: jsonResponse('The filters', 'LibraryObjectFilter', true) },
      },
    },
    '/library/cluster': {
      get: {
        summary: 'Desktop cluster view',
        tags: ['Library (Local)'],
        description: 'Per-object work done and the best own picture.',
        responses: {
          200: jsonResponse('The cluster items', 'LibraryClusterResult'),
          500: { description: 'CLUSTER_FAILED' },
        },
      },
    },
    '/library/archive': {
      get: {
        summary: 'Archived folders',
        tags: ['Library (Local)'],
        description: 'What the copy import kept from the telescope, by top-level folder. Omit `telescopeId` for the shared bucket.',
        parameters: [{ name: 'telescopeId', in: 'query', schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('The archive path and its folders', 'LibraryArchiveResult'),
          500: { description: 'ARCHIVE_LIST_FAILED' },
        },
      },
    },
    '/library/archive/scopes': {
      get: {
        summary: 'Telescopes with archived data',
        tags: ['Library (Local)'],
        description: 'Each scope is a telescope id, or null for the shared unscoped bucket.',
        responses: {
          200: { description: 'The scopes, each a telescope id or null', content: { 'application/json': { schema: { type: 'array', items: { type: ['string', 'null'] } } } } },
          500: { description: 'ARCHIVE_SCOPES_FAILED' },
        },
      },
    },
    '/library/sample-object': {
      post: {
        summary: 'Plant the tour sample object',
        tags: ['Library (Local)'],
        description: 'Admin only. A no-op when the library already holds real objects.',
        responses: {
          200: jsonResponse('What was planted', 'LibrarySampleState'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
      delete: {
        summary: 'Remove the tour sample object',
        tags: ['Library (Local)'],
        description: 'Admin only. A no-op when nothing is planted.',
        responses: {
          200: jsonResponse('What was removed', 'LibrarySampleState'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },

    // ── Library: files, images and downloads ─────────────────────────
    '/library/file/thumbnail': {
      get: {
        summary: 'Bounded JPEG thumbnail of a library picture',
        tags: ['Library (Local)'],
        description: 'The only renderable form for some formats (a raw TIFF, a 16-bit PNG). Cached on disk and served as JPEG.',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'w', in: 'query', schema: { type: 'integer', minimum: 32, maximum: 1200 } },
          { name: 'h', in: 'query', schema: { type: 'integer', minimum: 32, maximum: 1200 } },
        ],
        responses: {
          200: { description: 'The JPEG', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } },
          404: { description: 'No image available' },
          500: { description: 'Render failed' },
        },
      },
    },
    '/library/fits-thumbnail': {
      get: {
        summary: 'Server-rendered preview of a FITS file',
        tags: ['Library (Local)'],
        description: 'A colorized, autostretched JPEG so clients never decode the raw FITS just to show it. `size=preview` asks for the larger tier.',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'size', in: 'query', schema: { type: 'string', enum: ['preview'] } },
        ],
        responses: {
          200: { description: 'The JPEG', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } },
          404: { description: 'File not found' },
        },
      },
    },
    '/library/tiff-thumbnail': {
      get: {
        summary: 'Server-rendered preview of a TIFF file',
        tags: ['Library (Local)'],
        description: 'Decodes the true samples and autostretches them before encoding, because a 32-bit float TIFF read as scRGB clips to a blank square. `size=preview` asks for the larger tier.',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'size', in: 'query', schema: { type: 'string', enum: ['preview'] } },
        ],
        responses: {
          200: { description: 'The JPEG', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } },
          404: { description: 'File not found' },
        },
      },
    },
    '/library/file-original': {
      get: {
        summary: 'The saved original of an edited picture',
        tags: ['Library (Local)'],
        description: 'The bytes kept before an in-place edit replaced the picture.',
        parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'The original file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          400: { description: 'MISSING_PATH' },
          404: { description: 'NO_ORIGINAL' },
        },
      },
    },
    '/library/builtin-art': {
      get: {
        summary: 'Built-in artwork ids',
        tags: ['Library (Local)'],
        responses: { 200: jsonResponse('The ids', 'LibraryBuiltinArt') },
      },
    },
    '/library/builtin-art/{id}': {
      get: {
        summary: 'Built-in artwork',
        tags: ['Library (Local)'],
        description: 'An SVG from the fixed artwork set, never a path built from the request.',
        parameters: [subIdParam('id')],
        responses: {
          200: { description: 'The SVG', content: { 'image/svg+xml': { schema: { type: 'string', format: 'binary' } } } },
          404: { description: 'Unknown artwork' },
        },
      },
    },
    '/library/all-images': {
      get: {
        summary: 'Every image in the library',
        tags: ['Library (Local)'],
        description: 'Raw telescope files and processed results together, with favorite state and a next offset for paging.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          200: jsonResponse('The images and the total', 'LibraryAllImages'),
          500: { description: 'LIST_FAILED' },
        },
      },
    },
    '/library/headers': {
      get: {
        summary: 'FITS header of one library file',
        tags: ['Library (Local)'],
        description: 'The cards, a key/value map, and the same cards grouped into essential, observation, coordinates, sensor, quality, other and comments.',
        parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('The header', 'LibraryFitsHeader'),
          400: { description: 'MISSING_PATH' },
          404: { description: 'NOT_FOUND' },
        },
      },
    },
    '/library/observations': {
      get: {
        summary: 'Every imported observation (deprecated)',
        tags: ['Library (Local)'],
        description: 'Deprecated in favor of GET /observations, which this mirrors. Sends Deprecation and Link response headers.',
        responses: {
          200: jsonResponse('The observations', 'ObservationListItem', true),
          500: { description: 'LIST_FAILED' },
        },
      },
    },
    '/library/observations/{objectId}/{date}': {
      get: {
        summary: 'One observation (deprecated)',
        tags: ['Library (Local)'],
        description: 'Deprecated in favor of GET /observations/{objectId}/{date}.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        responses: {
          200: jsonResponse('The observation detail', 'ObservationDetail'),
          500: { description: 'FETCH_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/media': {
      get: {
        summary: 'The object media browser',
        tags: ['Library (Local)'],
        description: 'Every picture of the object and its variants, grouped and sorted for the media view. `favorites=1` keeps only favorites.',
        parameters: [
          subIdParam('objectId'),
          { name: 'favorites', in: 'query', schema: { type: 'string', enum: ['1'] } },
        ],
        responses: {
          200: jsonResponse('The media', 'LibraryMediaResult'),
          422: { description: 'VALIDATION_ERROR' },
          500: { description: 'LIST_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/integration': {
      get: {
        summary: 'Integration time of managed sub-frames',
        tags: ['Library (Local)'],
        description: 'Managed files only, per night. For linked folders and per-filter goals, use /objects/{objectId}/integration/filters.',
        parameters: [subIdParam('objectId')],
        responses: {
          200: jsonResponse('The integration stats', 'IntegrationStats'),
          500: { description: 'STATS_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/gallery-image': {
      get: {
        summary: "The object's gallery image",
        tags: ['Library (Local)'],
        description: 'The user-set picture when there is one, else the catalog, telescope or built-in fallback the gallery source setting picks.',
        parameters: [subIdParam('objectId')],
        responses: { 200: jsonResponse('The chosen image and crop', 'LibraryGalleryImageResult') },
      },
      put: {
        summary: "Choose the object's gallery image",
        tags: ['Library (Local)'],
        description: 'Admin only. `null` clears the choice. A chosen picture must live in the library. `auto: true` clears the choice and any crop, follows the gallery source setting, and ignores `imagePath`.',
        parameters: [subIdParam('objectId')],
        requestBody: jsonBody('LibraryGalleryImageInput'),
        responses: {
          200: jsonResponse('The chosen image', 'LibraryGalleryImageResult'),
          400: { description: 'The path is not a library image' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/objects/{objectId}/gallery-crop': {
      put: {
        summary: "Set the object's gallery crop",
        tags: ['Library (Local)'],
        description: 'Admin only. `crop: null` clears it. Only applies once a user-chosen gallery image is set.',
        parameters: [subIdParam('objectId')],
        requestBody: jsonBody('LibraryGalleryCropInput'),
        responses: {
          200: jsonResponse('The stored crop', 'LibraryGalleryCropResult'),
          400: { description: 'No user-chosen gallery image, or an invalid crop' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/objects/{objectId}/gallery-image/upload': {
      post: {
        summary: 'Upload a gallery image',
        tags: ['Library (Local)'],
        description: 'Admin only. multipart/form-data with one picture in the `image` field.',
        parameters: [subIdParam('objectId')],
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: { type: 'object', required: ['image'], properties: { image: { type: 'string', format: 'binary' } } } } },
        },
        responses: {
          200: jsonResponse('The chosen image', 'LibraryGalleryImageResult'),
          400: { description: 'No picture, or an unsupported type' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/session-image': {
      get: {
        summary: 'The chosen picture for one session',
        tags: ['Library (Local)'],
        parameters: [subIdParam('objectId'), subIdParam('date')],
        responses: { 200: jsonResponse('The session image path, or null', 'LibrarySessionImageResult') },
      },
      put: {
        summary: 'Choose the picture for one session',
        tags: ['Library (Local)'],
        description: 'Admin only. `null` clears it. The path must resolve inside the library.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        requestBody: jsonBody('LibrarySessionImageInput'),
        responses: {
          200: jsonResponse('The stored session image', 'LibrarySessionImageResult'),
          400: { description: 'The path is not inside the library' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/library/download/objects/{objectId}/link': {
      post: {
        summary: 'Mint a whole-object ZIP link',
        tags: ['Library (Local)'],
        description: 'Returns a short-lived signed URL for a browser download. `fileType`, `date` and `includeVariants` narrow what is zipped.',
        parameters: [subIdParam('objectId')],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { type: 'object', properties: { fileType: { type: 'string' }, date: { type: 'string', format: 'date' }, includeVariants: { type: 'boolean' } } } } },
        },
        responses: {
          200: jsonResponse('The signed URL', 'LibraryDownloadLink'),
          400: { description: 'INVALID_BODY' },
        },
      },
    },
    '/library/download/objects/{objectId}/summary': {
      get: {
        summary: 'How big a whole-object ZIP would be',
        tags: ['Library (Local)'],
        parameters: [
          subIdParam('objectId'),
          { name: 'fileType', in: 'query', schema: { type: 'string' } },
          { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'includeVariants', in: 'query', schema: { type: 'string', enum: ['true'] } },
        ],
        responses: {
          200: jsonResponse('File count and bytes', 'LibraryDownloadSummary'),
          500: { description: 'DOWNLOAD_SUMMARY_FAILED' },
        },
      },
    },
    '/library/download/objects/{objectId}': {
      get: {
        summary: 'Download an object as a ZIP',
        tags: ['Library (Local)'],
        description: 'Consumes the signed link and streams the ZIP. 404 when the filters leave no files.',
        parameters: [
          subIdParam('objectId'),
          { name: 'fileType', in: 'query', schema: { type: 'string' } },
          { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'includeVariants', in: 'query', schema: { type: 'string', enum: ['true'] } },
          { name: 't', in: 'query', schema: { type: 'string' }, description: 'Signed download token' },
        ],
        responses: {
          200: { description: 'The ZIP', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } },
          404: { description: 'NO_FILES' },
        },
      },
    },
    '/library/download/objects/{objectId}/subframe-filters': {
      post: {
        summary: 'Filters present in the selected nights',
        tags: ['Library (Local)'],
        description: 'Lets the sub-frame download dialog offer only filters that actually appear.',
        parameters: [subIdParam('objectId')],
        requestBody: jsonBody('LibrarySubframeFiltersInput'),
        responses: {
          200: jsonResponse('The filter names', 'LibrarySubframeFilters'),
          400: { description: 'INVALID_DATES' },
        },
      },
    },
    '/library/download/objects/{objectId}/subframes': {
      post: {
        summary: 'Start a sub-frame ZIP job',
        tags: ['Library (Local)'],
        description: 'Phase 1: answers immediately with a job id. Poll /download/status/{jobId}, then fetch /download/tmp/{token}.',
        parameters: [subIdParam('objectId')],
        requestBody: jsonBody('LibrarySubframesInput'),
        responses: {
          200: jsonResponse('The job id and file count', 'LibraryDownloadStarted'),
          400: { description: 'INVALID_DATES' },
          404: { description: 'NOT_FOUND or NO_FILES' },
        },
      },
    },
    '/library/download/status/{jobId}': {
      get: {
        summary: 'ZIP job status',
        tags: ['Library (Local)'],
        description: 'When done, carries the one-time download token; the job is then forgotten.',
        parameters: [subIdParam('jobId')],
        responses: {
          200: jsonResponse('The job status', 'LibraryDownloadStatus'),
          404: { description: 'NOT_FOUND. Unknown or expired job.' },
        },
      },
    },
    '/library/download/status/{jobId}/cancel': {
      post: {
        summary: 'Cancel a ZIP job',
        tags: ['Library (Local)'],
        description: 'Idempotent: an unknown or already-finished job is a successful no-op.',
        parameters: [subIdParam('jobId')],
        responses: {
          200: { description: 'Cancelled', content: { 'application/json': { schema: { type: 'object', required: ['cancelled'], properties: { cancelled: { type: 'boolean', const: true } } } } } },
        },
      },
    },
    '/library/download/tmp/{token}': {
      get: {
        summary: 'Fetch a built ZIP',
        tags: ['Library (Local)'],
        description: 'The one-time token from the job status is the credential. The link expires and the temp file is deleted after use.',
        parameters: [subIdParam('token')],
        responses: {
          200: { description: 'The ZIP', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } },
          404: { description: 'EXPIRED' },
          500: { description: 'SERVE_FAILED' },
        },
      },
    },
    '/library/favorites': {
      get: {
        summary: 'Favorite object ids',
        tags: ['Library (Local)'],
        responses: { 200: { description: 'The object ids', content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } } },
      },
    },
    '/library/image-favorites': {
      get: {
        summary: 'Favorite image paths',
        tags: ['Library (Local)'],
        responses: { 200: { description: 'The library-relative image paths', content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } } },
      },
    },
    '/library/objects/{objectId}/favorite': {
      post: {
        summary: 'Favorite an object',
        tags: ['Library (Local)'],
        parameters: [subIdParam('objectId')],
        responses: { 200: jsonResponse('Favorite state', 'LibraryFavoriteResult') },
      },
      delete: {
        summary: 'Unfavorite an object',
        tags: ['Library (Local)'],
        parameters: [subIdParam('objectId')],
        responses: { 200: jsonResponse('Favorite state', 'LibraryFavoriteResult') },
      },
    },
    '/library/images/favorite': {
      post: {
        summary: 'Favorite an image',
        tags: ['Library (Local)'],
        requestBody: jsonBody('LibraryFavoriteInput'),
        responses: { 200: jsonResponse('Favorite state', 'LibraryImageFavoriteResult') },
      },
      delete: {
        summary: 'Unfavorite an image',
        tags: ['Library (Local)'],
        requestBody: jsonBody('LibraryFavoriteInput'),
        responses: { 200: jsonResponse('Favorite state', 'LibraryImageFavoriteResult') },
      },
    },
    // ── Library: processed images, projects and analysis ─────────────
    '/library/file/replace': {
      post: {
        summary: 'Replace a picture in place',
        tags: ['Library (Local)'],
        description: 'Admin only. multipart/form-data with one picture in the `image` field. Keeps the original for /file-original and marks the geometry edited.',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'confirmLinked', in: 'query', schema: { type: 'string', enum: ['1'] } },
        ],
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['image'], properties: { image: { type: 'string', format: 'binary' } } } } } },
        responses: {
          200: jsonResponse('Replaced', 'LibraryFileReplaceResult'),
          400: { description: 'NO_IMAGE or MISSING_PATH' },
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'The linked original needs confirmation' },
          500: { description: 'REPLACE_FAILED' },
        },
      },
    },
    '/library/image-edit': {
      post: {
        summary: 'Edit a picture on the server (image editor Save)',
        tags: ['Library (Local)'],
        description: 'Admin only. The picture never leaves the server: the body says which library file or processed image to edit, what to do to it (crop, flip, turn, brightness, contrast, saturation) and where the result goes. EXIF orientation is applied first, then crop, flip and clockwise turn, then color, then the text overlay. Overwriting a library picture keeps its first original (restore it with `/library/file/restore-original`) and moves its plate solution with the edit. A PNG stays a PNG when overwritten; a new version is a JPEG.',
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: { type: 'object', required: ['request'], properties: {
            request: { type: 'string', description: 'JSON text of an ImageEditRequest.', contentMediaType: 'application/json', contentSchema: jsonSchemaOf(imageEditRequestSchema, 'input') },
            overlay: { type: 'string', format: 'binary', description: 'Optional transparent PNG of the text layers, any size with the result\'s aspect ratio. Scaled to the result.' },
          } } } },
        },
        responses: {
          200: { description: 'What was written: `telescope` (overwritten library file), `telescopeNew` (new edited variant) or `processed` (processed image id).', content: { 'application/json': { schema: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['telescope', 'telescopeNew', 'processed'] }, path: { type: 'string' }, bytes: { type: 'integer' }, objectId: { type: 'string' }, date: { type: 'string' }, filename: { type: 'string' }, id: { type: 'string' } } } } } },
          400: { description: 'INVALID_REQUEST' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'FILE_NOT_FOUND or NOT_FOUND' },
          409: { description: 'LINKED_REPLACE_UNCONFIRMED. Send `save.confirmLinked` to rewrite a file in a linked folder.' },
          415: { description: 'UNSUPPORTED_FORMAT, or FORMAT_MISMATCH' },
        },
      },
    },
    '/library/image-edit/preview': {
      get: {
        summary: 'Screen-sized copy of a picture for the image editor',
        tags: ['Library (Local)'],
        description: 'A JPEG no larger than 2048 px on its long edge with EXIF orientation applied, so the browser never decodes the full file. Requires a login.',
        parameters: [
          { name: 'kind', in: 'query', required: true, schema: { type: 'string', enum: ['telescope', 'processed'] } },
          { name: 'key', in: 'query', required: true, schema: { type: 'string' }, description: 'The library-relative path (`telescope`) or the processed image id (`processed`).' },
        ],
        responses: {
          200: { description: 'JPEG', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } },
          400: { description: 'INVALID_REQUEST' },
          404: { description: 'NOT_FOUND' },
        },
      },
    },
    '/library/file/restore-original': {
      post: {
        summary: 'Restore a picture\u2019s original',
        tags: ['Library (Local)'],
        description: 'Admin only. Puts the kept original back and forgets the backup.',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'confirmLinked', in: 'query', schema: { type: 'string', enum: ['1'] } },
        ],
        responses: {
          200: jsonResponse('Restored', 'LibraryFileRestoreResult'),
          400: { description: 'MISSING_PATH' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NO_ORIGINAL' },
          500: { description: 'RESTORE_FAILED' },
        },
      },
    },
    '/library/manual-observations': {
      post: {
        summary: 'File a manual observation',
        tags: ['Library (Local)'],
        description: 'Admin only. multipart/form-data: one picture in `image`, plus `objectName` and `date`; `notes` and `telescopeId` are optional.',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['image', 'objectName', 'date'],
                properties: {
                  image:      { type: 'string', format: 'binary' },
                  objectName: { type: 'string' },
                  date:       { type: 'string', format: 'date' },
                  notes:      { type: 'string' },
                  telescopeId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('The created observation', 'LibraryManualObservationResult'),
          400: { description: 'MISSING_OBJECT or INVALID_DATE' },
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'CREATE_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/processed-images': {
      get: {
        summary: 'Processed images of an object',
        tags: ['Library (Local)'],
        description: 'Across every session, with favorite state.',
        parameters: [
          subIdParam('objectId'),
          { $ref: '#/components/parameters/format' },
        ],
        responses: {
          200: jsonResponse('The processed images', 'LibraryProcessedImage', true),
          500: { description: 'LIST_FAILED' },
        },
      },
      post: {
        summary: 'Upload an object-level processed image',
        tags: ['Library (Local)'],
        description: 'Admin only. multipart/form-data with the picture in `image` and optional `title` and `notes`. Stored with no session date.',
        parameters: [subIdParam('objectId')],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['image'],
                properties: { image: { type: 'string', format: 'binary' }, title: { type: 'string' }, notes: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('The new record', 'LibraryProcessedImage'),
          400: { description: 'NO_IMAGE' },
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'UPLOAD_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/processed-images/{id}': {
      put: {
        summary: 'Replace a processed image file',
        tags: ['Library (Local)'],
        description: 'Admin only. multipart/form-data with the replacement in `image`, plus optional `title` and `notes`.',
        parameters: [subIdParam('objectId'), subIdParam('id')],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['image'],
                properties: { image: { type: 'string', format: 'binary' }, title: { type: 'string' }, notes: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('The updated record', 'LibraryProcessedImage'),
          400: { description: 'NO_IMAGE' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
          500: { description: 'UPLOAD_FAILED' },
        },
      },
      delete: {
        summary: 'Delete a processed image',
        tags: ['Library (Local)'],
        description: 'Admin only. Object-scoped: works for images from any session.',
        parameters: [subIdParam('objectId'), subIdParam('id')],
        responses: {
          200: jsonResponse('Deleted', 'LibraryDeletedId'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/processed-images': {
      get: {
        summary: 'Processed images of one session',
        tags: ['Library (Local)'],
        parameters: [subIdParam('objectId'), subIdParam('date')],
        responses: { 200: jsonResponse('The processed images', 'LibraryProcessedImage', true) },
      },
      post: {
        summary: 'Upload a session processed image',
        tags: ['Library (Local)'],
        description: 'Admin only. multipart/form-data with the picture in `image`, optional `title`, `notes` and `runId` (must belong to the object).',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['image'],
                properties: { image: { type: 'string', format: 'binary' }, title: { type: 'string' }, notes: { type: 'string' }, runId: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('The new record', 'LibraryProcessedImage'),
          400: { description: 'NO_IMAGE' },
          403: { description: 'FORBIDDEN. Admin only.' },
          422: { description: 'runId does not belong to this object' },
          500: { description: 'UPLOAD_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/processed-images/from-file': {
      post: {
        summary: 'Mark an existing file as processed',
        tags: ['Library (Local)'],
        description: 'Admin only. Files a picture already in the library as a processed result for this session, optionally moving the original.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['path'],
                properties: { path: { type: 'string' }, title: { type: 'string' }, notes: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('The record, plus whether the original moved', 'LibraryProcessedImage'),
          400: { description: 'MISSING_PATH or INVALID_PATH' },
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'UPLOAD_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/processed-images/{id}/unmark': {
      post: {
        summary: 'Unmark a processed image as processed',
        tags: ['Library (Local)'],
        description: 'Admin only. Moves the picture back into the session\u2019s files and forgets the processed record.',
        parameters: [subIdParam('objectId'), subIdParam('date'), subIdParam('id')],
        responses: {
          200: jsonResponse('The new library path', 'LibraryUnmarkResult'),
          400: { description: 'Only a renderable picture can be moved back' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/processed-images/{id}': {
      delete: {
        summary: 'Delete a session processed image',
        tags: ['Library (Local)'],
        description: 'Admin only.',
        parameters: [subIdParam('objectId'), subIdParam('date'), subIdParam('id')],
        responses: {
          200: jsonResponse('Deleted', 'LibraryDeletedId'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
        },
      },
    },
    '/library/processed-images/{id}': {
      get: {
        summary: 'Serve a processed image',
        tags: ['Library (Local)'],
        parameters: [subIdParam('id')],
        responses: {
          200: { description: 'The image', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          404: { description: 'Not found' },
        },
      },
    },
    '/library/objects/{objectId}/processing-runs': {
      get: {
        summary: 'Processing runs of an object',
        tags: ['Library (Local)'],
        description: 'Newest first.',
        parameters: [subIdParam('objectId')],
        responses: { 200: jsonResponse('The runs', 'LibraryProcessingRun', true) },
      },
      post: {
        summary: 'Create a processing run',
        tags: ['Library (Local)'],
        description: 'Admin only. A run ties processed images to the nights they combine.',
        parameters: [subIdParam('objectId')],
        requestBody: jsonBody('LibraryProcessingRunInput'),
        responses: {
          200: jsonResponse('The new run', 'LibraryProcessingRun'),
          403: { description: 'FORBIDDEN. Admin only.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/library/objects/{objectId}/project-archives': {
      get: {
        summary: 'Project archives of an object',
        tags: ['Library (Local)'],
        parameters: [subIdParam('objectId')],
        responses: { 200: jsonResponse('The archives', 'LibraryProjectArchive', true) },
      },
      post: {
        summary: 'Upload a project archive',
        tags: ['Library (Local)'],
        description: 'Admin only. multipart/form-data with the project in `archive` (zip, xpsm or pxiproject, up to 20 GB), plus optional `title`, `notes` and `software`. Refused with 507 when temp or library storage is short.',
        parameters: [subIdParam('objectId')],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['archive'],
                properties: {
                  archive:  { type: 'string', format: 'binary' },
                  title:    { type: 'string' },
                  notes:    { type: 'string' },
                  software: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('The new archive', 'LibraryProjectArchive'),
          400: { description: 'NO_ARCHIVE' },
          403: { description: 'FORBIDDEN. Admin only.' },
          507: { description: 'INSUFFICIENT_STORAGE' },
          500: { description: 'UPLOAD_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/project-archives/{id}': {
      delete: {
        summary: 'Delete a project archive',
        tags: ['Library (Local)'],
        description: 'Admin only.',
        parameters: [subIdParam('objectId'), subIdParam('id')],
        responses: {
          200: jsonResponse('Deleted', 'LibraryDeletedId'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
        },
      },
    },
    '/library/project-archives/{id}': {
      get: {
        summary: 'Download a project archive',
        tags: ['Library (Local)'],
        description: 'Streams the archive as an attachment.',
        parameters: [subIdParam('id')],
        responses: {
          200: { description: 'The archive', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          404: { description: 'Not found' },
          500: { description: 'Failed to send file' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/frame-analysis': {
      get: {
        summary: 'Sub-frame analysis for one night',
        tags: ['Library (Local)'],
        description: 'Every raw frame with what has been measured, its verdict and the user review. Unmeasured frames have `metrics: null`.',
        parameters: [
          subIdParam('objectId'),
          subIdParam('date'),
          { name: 'includeVariants', in: 'query', schema: { type: 'string', enum: ['1'] } },
        ],
        responses: {
          200: jsonResponse('The report and queue counts', 'LibraryFrameAnalysisResult'),
          500: { description: 'FRAME_ANALYSIS_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/frame-analysis.csv': {
      get: {
        summary: 'Frame analysis as CSV',
        tags: ['Library (Local)'],
        description: 'One row per frame with an `accepted` column a PixInsight or Siril script can filter on.',
        parameters: [
          subIdParam('objectId'),
          subIdParam('date'),
          { name: 'includeVariants', in: 'query', schema: { type: 'string', enum: ['1'] } },
        ],
        responses: {
          200: { description: 'The CSV', content: { 'text/csv': { schema: { type: 'string' } } } },
          500: { description: 'FRAME_ANALYSIS_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/frame-analysis/measure': {
      post: {
        summary: 'Queue a night\u2019s frames for measuring',
        tags: ['Library (Local)'],
        description: 'Admin only. Idempotent: frames already measured or queued are skipped.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        requestBody: { required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/LibraryFrameQueueInput' } } } },
        responses: {
          200: jsonResponse('What was queued', 'LibraryFrameQueueResult'),
          400: { description: 'INVALID_BODY' },
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'FRAME_ANALYSIS_FAILED' },
        },
      },
    },
    '/library/frame-analysis/measure': {
      post: {
        summary: 'Measure one frame now',
        tags: ['Library (Local)'],
        description: 'Admin only. CPU-heavy, so one at a time. Returns the stored measurement unless `force` is set.',
        requestBody: jsonBody('LibraryFrameMeasureInput'),
        responses: {
          200: jsonResponse('The measurement', 'LibraryFrameMeasureResult'),
          400: { description: 'MISSING_PATH' },
          403: { description: 'FORBIDDEN. Admin only, or the path is outside the library.' },
          404: { description: 'NOT_FOUND' },
          422: { description: 'FRAME_UNREADABLE' },
          500: { description: 'FRAME_ANALYSIS_FAILED' },
        },
      },
    },
    '/library/frame-analysis/review': {
      put: {
        summary: 'Keep or reject a measured frame',
        tags: ['Library (Local)'],
        description: 'Admin only. The review wins over the analyzer\u2019s grade in stacking exports; `keep: null` goes back to the grade.',
        requestBody: jsonBody('LibraryFrameReviewInput'),
        responses: {
          200: jsonResponse('The saved review', 'LibraryFrameReviewResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
          422: { description: 'VALIDATION_ERROR' },
          500: { description: 'FRAME_ANALYSIS_FAILED' },
        },
      },
    },
    '/library/objects/{objectId}/stacking-export/plan': {
      post: {
        summary: 'What a stacking export would contain',
        tags: ['Library (Local)'],
        description: 'Lights and matched calibration, with totals. Which lights are kept follows Frame Analysis: the user review first, then the grade.',
        parameters: [subIdParam('objectId')],
        requestBody: jsonBody('LibraryStackingExportInput'),
        responses: {
          200: jsonResponse('The export plan', 'LibraryStackingExportPlan'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/library/objects/{objectId}/stacking-export': {
      post: {
        summary: 'Start a stacking export ZIP',
        tags: ['Library (Local)'],
        description: 'Builds the plan and starts the same async ZIP job flow as the sub-frame download. 507 when temp space is short.',
        parameters: [subIdParam('objectId')],
        requestBody: jsonBody('LibraryStackingExportInput'),
        responses: {
          200: jsonResponse('The job id and file count', 'LibraryDownloadStarted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND or NO_FILES' },
          422: { description: 'VALIDATION_ERROR' },
          507: { description: 'INSUFFICIENT_SPACE' },
        },
      },
    },
    '/library/objects/{objectId}/sessions/{date}/library-files': {
      post: {
        summary: 'Save an edited picture beside the telescope files',
        tags: ['Library (Local)'],
        description: 'Admin only. multipart/form-data with the picture in `image`. It lands in the object folder so it shows under Telescope Images, not Processed. With `overwritePath` it replaces that file instead. `edit` tells the server what the editor did to the frame, so the picture keeps its plate solution (Annotate) instead of being solved again.',
        parameters: [subIdParam('objectId'), subIdParam('date')],
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: { type: 'object', required: ['image'], properties: {
            image: { type: 'string', format: 'binary' },
            overwritePath: { type: 'string', description: 'Library-relative path of the existing JPEG to replace.' },
            edit: { type: 'string', description: 'JSON text of a GeometryEdit, used with `overwritePath`.', contentMediaType: 'application/json', contentSchema: jsonSchemaOf(geometryEditSchema, 'input') },
          } } } },
        },
        responses: {
          200: { description: 'The stored filename', content: { 'application/json': { schema: { type: 'object', required: ['objectId', 'date', 'filename'], properties: { objectId: { type: 'string' }, date: { type: 'string' }, filename: { type: 'string' } } } } } },
          400: { description: 'NO_IMAGE, or an invalid object id, session date or `edit`' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    // ── DSO catalog ───────────────────────────────────────────────────

    '/dso': {
      get: {
        summary: 'Browse or search DSO catalog',
        tags: ['DSO Catalog'],
        description: 'OpenNGC-derived catalog of ~3,200 Seestar-appropriate deep-sky objects. Pass `?q=` to search, or filter with type/constellation/maxMag/minSize.',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Free-text search (name, Messier ID, NGC ID, common name)' },
          { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Filter by type code or label, e.g. "G", "PN", "Galaxy"' },
          { name: 'constellation', in: 'query', schema: { type: 'string' }, description: 'Filter by constellation name' },
          { name: 'maxMag', in: 'query', schema: { type: 'number' }, description: 'Maximum (faintest) magnitude' },
          { name: 'minSize', in: 'query', schema: { type: 'number' }, description: 'Minimum angular size in arcminutes' },
          { $ref: '#/components/parameters/limit' },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: {
            description: 'Search or browse results',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    results: { type: 'array', items: { $ref: '#/components/schemas/DsoEntry' } },
                    total:   { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    // ── Explore ───────────────────────────────────────────────────────
    '/explore/search': {
      get: {
        summary: 'Typeahead search over the whole catalog',
        tags: ['Explore'],
        description: 'Matches common names and every designation (M, NGC, IC, Caldwell, Sharpless, Barnard). Each row carries visibility from the resolved site. A constellation name also returns a `constellation` hint.',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 8, maximum: 20 } },
          { name: 'siteId', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'results, total, constellation, locationSet' } },
      },
    },
    '/explore/categories': {
      get: {
        summary: 'Browse tiles with counts for this site',
        tags: ['Explore'],
        description: 'Per category: total objects, how many ever clear the site minimum altitude, and how many are up tonight.',
        parameters: [{ name: 'siteId', in: 'query', schema: { type: 'string' } }],
        responses: { 200: { description: 'categories[] of {id,total,visibleHere,goodTonight}' } },
      },
    },
    '/explore/browse': {
      get: {
        summary: 'Ranked, filtered, paged objects',
        tags: ['Explore'],
        description: 'Default order is the showpiece score. `category` is `all` or one of the ids from /explore/categories.',
        parameters: [
          { name: 'category', in: 'query', schema: { type: 'string', default: 'all' } },
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'constellation', in: 'query', schema: { type: 'string' } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['best', 'tonight', 'bright', 'large', 'name'], default: 'best' } },
          { name: 'visibility', in: 'query', schema: { type: 'string', enum: ['all', 'here', 'tonight'], default: 'here' } },
          { name: 'notImaged', in: 'query', schema: { type: 'boolean' } },
          { $ref: '#/components/parameters/limit' },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'siteId', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'results[] (ExploreRow), total, locationSet' } },
      },
    },
    '/explore/best-tonight': {
      get: {
        summary: 'Rewarding targets that are up tonight',
        tags: ['Explore'],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 30 } },
          { name: 'siteId', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'results[] (ExploreRow), locationSet' } },
      },
    },
    '/explore/next-good-nights/{objectId}': {
      get: {
        summary: 'Upcoming nights ranked for one object',
        tags: ['Explore'],
        description: 'Per night: peak altitude, hours above the site minimum, moon illumination and proximity verdict, and a 0-1 score. The three best are flagged `isBest`. Geometry only; cloud forecast is not factored in.',
        parameters: [
          { name: 'objectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'days', in: 'query', schema: { type: 'integer', default: 30, maximum: 60 } },
          { name: 'siteId', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'nights[]' }, 404: { description: 'Unknown object' } },
      },
    },
    '/dso/{id}': {
      get: {
        summary: 'Get single DSO entry',
        tags: ['DSO Catalog'],
        description: 'Includes live alt/az if observer location is set.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'e.g. M81, NGC3031' }],
        responses: {
          200: { description: 'DSO entry with optional current alt/az', content: { 'application/json': { schema: { $ref: '#/components/schemas/DsoEntry' } } } },
          404: { description: 'Not found' },
        },
      },
    },
    '/dso/tonight': {
      get: {
        summary: "Tonight's visible targets",
        tags: ['DSO Catalog'],
        description: 'The same handler as GET /planner/tonight. Returns `locationSet: false` with empty targets when no observer location is configured.',
        parameters: [
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'minAlt', in: 'query', schema: { type: 'number' } },
          { name: 'date', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Night to plan; defaults to tonight' },
          { name: 'siteId', in: 'query', schema: { type: 'string' } },
          { name: 'lat', in: 'query', schema: { type: 'number' } },
          { name: 'lon', in: 'query', schema: { type: 'number' } },
        ],
        responses: {
          200: jsonResponse('Targets and night conditions', 'PlannerResponse'),
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/dso/curve/{objectId}': {
      get: {
        summary: 'Altitude curve for tonight',
        tags: ['DSO Catalog'],
        description: 'The same handler as GET /planner/curve/{objectId}. Samples every 15 minutes through the sunset-to-sunrise window.',
        parameters: [
          { name: 'objectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'siteId', in: 'query', schema: { type: 'string' } },
          { name: 'lat', in: 'query', schema: { type: 'number' } },
          { name: 'lon', in: 'query', schema: { type: 'number' } },
        ],
        responses: {
          200: jsonResponse('The entry and its curve', 'DsoCurveResult'),
          400: { description: 'NO_LOCATION' },
          404: { description: 'NOT_FOUND' },
          422: { description: 'NO_PLANNING_WINDOW or VALIDATION_ERROR' },
        },
      },
    },
    '/dso/plan': {
      post: {
        summary: 'Plan a night',
        tags: ['DSO Catalog'],
        description: 'The same handler as POST /planner/plan. The envelope `meta` carries the weather, narrowband and goals detail.',
        requestBody: jsonBody('PlannerPlanInput'),
        responses: {
          200: jsonResponse('The scheduled blocks', 'PlannerPlanBlock', true),
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/dso/verdict': {
      post: {
        summary: 'Judge placed blocks',
        tags: ['DSO Catalog'],
        description: 'The same handler as POST /planner/verdict.',
        requestBody: jsonBody('PlannerVerdictInput'),
        responses: {
          200: jsonResponse('One verdict per item', 'PlannerVerdict', true),
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },

    // ── Gear ──────────────────────────────────────────────────────────
    '/gear': {
      get: {
        summary: 'List gear',
        tags: ['Gear'],
        description: [
          'Filters, cameras, lenses, power, dew heaters and the rest of what is brought to a night, other than the telescopes',
          '(those are telescope profiles). Archived gear is left out unless `archived=1`.',
          '',
          'Each item carries `specs`, the figures that belong to its kind (for example `capacityWh` for power, `type` for a filter,',
          '`drawW` for anything that draws power). Unknown or out-of-range figures are dropped on write, never coerced.',
        ].join('\n'),
        parameters: [{ name: 'archived', in: 'query', schema: { type: 'string', enum: ['1'] }, description: 'Include archived gear' }],
        responses: { 200: jsonResponse('Array of gear items', 'GearItem', true) },
      },
      post: {
        summary: 'Add gear',
        tags: ['Gear'],
        description: 'Admin only.',
        requestBody: jsonBody('GearItemInput'),
        responses: { 200: jsonResponse('The new gear item', 'GearItem'), 422: { description: 'VALIDATION_ERROR' } },
      },
    },
    '/gear/{id}': {
      get: { summary: 'One gear item', tags: ['Gear'], parameters: [idParam], responses: { 200: jsonResponse('The gear item', 'GearItem'), 404: { description: 'Not found' } } },
      put: {
        summary: 'Change gear',
        tags: ['Gear'],
        description: 'Admin only. Any of the fields from add. A new `kind` re-validates the specs against it.',
        parameters: [idParam],
        requestBody: jsonBody('GearItemPatch'),
        responses: { 200: jsonResponse('The updated item', 'GearItem'), 404: { description: 'Not found' }, 422: { description: 'VALIDATION_ERROR' } },
      },
      delete: { summary: 'Delete gear', tags: ['Gear'], description: 'Admin only. Also removes it from every kit.', parameters: [idParam], responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } } },
    },
    '/gear/{id}/archive': {
      post: { summary: 'Archive gear', tags: ['Gear'], description: 'Admin only. Hides it from the list without losing it. `/unarchive` reverses it.', parameters: [idParam], responses: { 200: jsonResponse('The archived item', 'GearItem'), 404: { description: 'Not found' } } },
    },
    '/gear/kits': {
      get: { summary: 'List packing lists', tags: ['Gear'], responses: { 200: jsonResponse('Array of kits', 'GearKit', true) } },
      post: {
        summary: 'Add a packing list',
        tags: ['Gear'],
        description: 'Admin only.',
        requestBody: jsonBody('GearKitInput'),
        responses: { 200: jsonResponse('The new kit', 'GearKit'), 422: { description: 'VALIDATION_ERROR' } },
      },
    },
    '/gear/kits/{id}': {
      put: {
        summary: 'Change a packing list',
        tags: ['Gear'],
        description: 'Admin only.',
        parameters: [idParam],
        requestBody: jsonBody('GearKitPatch'),
        responses: { 200: jsonResponse('The updated kit', 'GearKit'), 404: { description: 'Not found' }, 422: { description: 'VALIDATION_ERROR' } },
      },
      delete: { summary: 'Delete a packing list', tags: ['Gear'], description: 'Admin only. Also removes its ticks.', parameters: [idParam], responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } } },
    },
    '/gear/kits/{id}/checks': {
      get: {
        summary: 'Ticked lines for a night',
        tags: ['Gear'],
        parameters: [idParam, { name: 'night', in: 'query', required: true, schema: { type: 'string', format: 'date' } }],
        responses: { 200: { description: '`{ night, checked: string[] }`, the keys of the ticked lines' } },
      },
      put: {
        summary: 'Tick or untick a line',
        tags: ['Gear'],
        description: 'Admin only. Ticks older than 30 days are dropped.',
        parameters: [idParam, { name: 'night', in: 'query', required: true, schema: { type: 'string', format: 'date' } }],
        requestBody: jsonBody('GearKitCheckInput'),
        responses: { 200: { description: 'The ticked lines for that night' }, 404: { description: 'Not found' }, 422: { description: 'VALIDATION_ERROR' } },
      },
      delete: {
        summary: 'Untick everything for a night',
        tags: ['Gear'],
        description: 'Admin only.',
        parameters: [idParam, { name: 'night', in: 'query', required: true, schema: { type: 'string', format: 'date' } }],
        responses: { 200: { description: 'An empty list' }, 404: { description: 'Not found' } },
      },
    },

    // ── Journal ───────────────────────────────────────────────────────
    '/journal': {
      get: {
        summary: 'Journal entries',
        tags: ['Journal'],
        description: [
          'What the user wrote about their nights: notes, checklists, comments on one picture, and attached files.',
          'Every entry has a `night`; `objectId` narrows it to one object imaged that night and `filePath` (library-relative) to one file of it.',
          'Newest night first, and oldest entry first inside a night.',
        ].join('\n'),
        parameters: [
          { name: 'night', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'objectId', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: jsonResponse('Array of entries, each with its attachments and checklist', 'JournalEntry', true) },
      },
      post: {
        summary: 'Add an entry',
        tags: ['Journal'],
        description: 'Admin only.',
        requestBody: jsonBody('JournalEntryInput'),
        responses: { 200: jsonResponse('The new entry', 'JournalEntry'), 422: { description: 'VALIDATION_ERROR' } },
      },
    },
    '/journal/{id}': {
      get: { summary: 'One entry', tags: ['Journal'], parameters: [idParam], responses: { 200: jsonResponse('The entry', 'JournalEntry'), 404: { description: 'Not found' } } },
      put: {
        summary: 'Change an entry',
        tags: ['Journal'],
        description: 'Admin only. Any of the fields from add.',
        parameters: [idParam],
        requestBody: jsonBody('JournalEntryPatch'),
        responses: { 200: jsonResponse('The updated entry', 'JournalEntry'), 404: { description: 'Not found' }, 422: { description: 'VALIDATION_ERROR' } },
      },
      delete: { summary: 'Delete an entry', tags: ['Journal'], description: 'Admin only. Also deletes its files.', parameters: [idParam], responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } } },
    },
    '/journal/{id}/attachments': {
      post: {
        summary: 'Attach a file',
        tags: ['Journal'],
        description: 'Admin only. One file in the `file` field, up to 100 MB; at most 30 files an entry.',
        parameters: [idParam],
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } } } },
        responses: { 200: jsonResponse('The attachment', 'JournalAttachment'), 404: { description: 'Not found' }, 413: { description: 'FILE_TOO_LARGE' } },
      },
    },
    '/journal/attachments/{id}': {
      get: { summary: 'An attached file', tags: ['Journal'], description: 'Pictures, PDFs and plain text are served inline; anything else, or any file with `download=1`, as a download.', parameters: [idParam], responses: { 200: { description: 'The file' }, 404: { description: 'Not found' } } },
      delete: { summary: 'Remove an attached file', tags: ['Journal'], description: 'Admin only.', parameters: [idParam], responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } } },
    },
    // ── Alerts ────────────────────────────────────────────────────────
    '/alerts': {
      get: {
        summary: 'Alert settings overview',
        tags: ['Alerts'],
        description: [
          'Every channel, every phone, the alert options, the events a destination can subscribe to, and when the evening clear-night check next runs.',
          'Admin only. A channel URL is a credential, so responses carry a masked preview and whether a secret is set, never the values.',
        ].join('\n'),
        responses: {
          200: jsonResponse('The alert overview', 'AlertOverview'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/alerts/channels': {
      post: {
        summary: 'Add an alert channel',
        tags: ['Alerts'],
        description: 'Admin only. A generic webhook, an ntfy topic, or a Discord or Slack incoming webhook. The URL is stored encrypted and only ever returned masked.',
        requestBody: jsonBody('AlertChannelInput'),
        responses: {
          201: jsonResponse('The new channel', 'AlertChannel'),
          403: { description: 'FORBIDDEN. Admin only.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/alerts/channels/{id}': {
      put: {
        summary: 'Change an alert channel',
        tags: ['Alerts'],
        description: 'Admin only. Only the fields sent change. Omitting `url` or `secret` keeps the stored value; `secret: null` clears it.',
        parameters: [idParam],
        requestBody: jsonBody('AlertChannelPatch'),
        responses: {
          200: jsonResponse('The updated channel', 'AlertChannel'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Alert channel not found.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
      delete: {
        summary: 'Remove an alert channel',
        tags: ['Alerts'],
        description: 'Admin only. Also forgets which night it was last warned of dew.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Deletion confirmed', 'AlertDeleted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Alert channel not found.' },
        },
      },
    },
    '/alerts/channels/{id}/test': {
      post: {
        summary: 'Send a test alert to one channel',
        tags: ['Alerts'],
        description: 'Admin only. Sends a test event whatever the channel is subscribed to, records the result, and returns it with the channel as it now stands.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Delivery result and the channel', 'AlertChannelTestResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Alert channel not found.' },
        },
      },
    },
    '/alerts/push-info': {
      get: {
        summary: 'What a phone needs before it registers',
        tags: ['Alerts'],
        description: 'The push relay URL, the events a new phone starts on, and every event it can choose. Admin only. Answers 404 until phone alerts are released on this install.',
        responses: {
          200: jsonResponse('Relay URL and default subscriptions', 'AlertPushInfo'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Phone alerts are not enabled on this install.' },
        },
      },
    },
    '/alerts/devices': {
      post: {
        summary: 'Register a phone',
        tags: ['Alerts'],
        description: 'Admin only. Registering again with the same Apple token refreshes the existing row and keeps the events and on/off switch the admin set. Answers 404 until phone alerts are released on this install.',
        requestBody: jsonBody('AlertDeviceRegistration'),
        responses: {
          200: jsonResponse('The refreshed phone', 'AlertDevice'),
          201: jsonResponse('The new phone', 'AlertDevice'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Phone alerts are not enabled on this install.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/alerts/devices/{id}': {
      get: {
        summary: 'One phone',
        tags: ['Alerts'],
        description: 'So a phone can tell whether the server still knows it. Admin only.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('The phone', 'AlertDevice'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Phone not found.' },
        },
      },
      put: {
        summary: 'Change a phone',
        tags: ['Alerts'],
        description: 'Admin only. Its name, subscribed events, clear-night lines and on/off switch.',
        parameters: [idParam],
        requestBody: jsonBody('AlertDevicePatch'),
        responses: {
          200: jsonResponse('The updated phone', 'AlertDevice'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Phone not found.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
      delete: {
        summary: 'Remove a phone',
        tags: ['Alerts'],
        description: 'Admin only. The phone registers again when it next opens.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Deletion confirmed', 'AlertDeleted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Phone not found.' },
        },
      },
    },
    '/alerts/devices/{id}/test': {
      post: {
        summary: 'Send a test push to one phone',
        tags: ['Alerts'],
        description: 'Admin only. Sends a test notification through the relay and says whether the phone is still accepted; a phone Apple no longer accepts is removed.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Delivery result and the phone, or null once removed', 'AlertDeviceTestResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Phone not found.' },
        },
      },
    },
    '/alerts/config': {
      put: {
        summary: 'Change the alert options',
        tags: ['Alerts'],
        description: 'Admin only. The message language and the evening clear-night check: when it runs, how many clear dark hours count, and the cloud limit.',
        requestBody: jsonBody('AlertConfigInput'),
        responses: {
          200: jsonResponse('The updated options', 'AlertConfig'),
          403: { description: 'FORBIDDEN. Admin only.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/alerts/clear-night/preview': {
      post: {
        summary: "What tonight's clear-night check would say",
        tags: ['Alerts'],
        description: 'Admin only. Evaluates the active site against the forecast without sending anything.',
        responses: {
          200: jsonResponse('The check result and why it would or would not send', 'AlertClearNightCheck'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/alerts/clear-night/send-to-phones': {
      post: {
        summary: "Send tonight's clear-night alert to every phone",
        tags: ['Alerts'],
        description: 'Admin only. Sends the alert as it would go out, whether or not tonight qualifies, so its look can be judged on a real lock screen. It does not count as tonight having been sent. Answers 404 until phone alerts are released.',
        responses: {
          200: jsonResponse('How many were sent, which failed, and the check behind them', 'AlertPhonesResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Phone alerts are not enabled on this install.' },
        },
      },
    },
    '/alerts/dew/send-to-phones': {
      post: {
        summary: 'Send a dew warning to every phone that asked for one',
        tags: ['Alerts'],
        description: 'Admin only. Uses tonight\'s real dew forecast when there is a risk; with none it sends example times and sets `sample`. It does not count as tonight\'s warning having gone. Answers 404 until phone alerts are released.',
        responses: {
          200: jsonResponse('How many were sent, which failed, and whether the times were a sample', 'AlertDewPhonesResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Phone alerts are not enabled on this install.' },
        },
      },
    },

    // ── Observing sites ───────────────────────────────────────────────
    '/sites': {
      get: {
        summary: 'List observing sites',
        tags: ['Sites'],
        description: 'Every site in display order. The active site is reported separately by /sites/active.',
        responses: { 200: jsonResponse('Array of sites', 'ObservingSite', true) },
      },
      post: {
        summary: 'Add an observing site',
        tags: ['Sites'],
        description: 'Admin only. Coordinates are optional; a site without them cannot drive the planner until they are set.',
        requestBody: jsonBody('ObservingSiteInput'),
        responses: {
          200: jsonResponse('The new site', 'ObservingSite'),
          403: { description: 'FORBIDDEN. Admin only.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/sites/active': {
      get: {
        summary: 'The active observing site',
        tags: ['Sites'],
        description: 'The site the planner, forecast and alerts compute for.',
        responses: { 200: jsonResponse('The active site', 'ObservingSite') },
      },
      put: {
        summary: 'Choose the active site',
        tags: ['Sites'],
        description: 'Admin only. Send `siteId: null` to clear it.',
        requestBody: jsonBody('ActiveSiteInput'),
        responses: {
          200: jsonResponse('The active site after the change', 'ObservingSite'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Unknown site.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/sites/{id}': {
      get: {
        summary: 'One observing site',
        tags: ['Sites'],
        parameters: [idParam],
        responses: {
          200: jsonResponse('The site', 'ObservingSite'),
          404: { description: 'NOT_FOUND. Observing site not found.' },
        },
      },
      put: {
        summary: 'Change an observing site',
        tags: ['Sites'],
        description: 'Admin only. Only the fields sent change. `isDefault` is not accepted here; use PUT /sites/{id}/default.',
        parameters: [idParam],
        requestBody: jsonBody('ObservingSiteUpdate'),
        responses: {
          200: jsonResponse('The updated site', 'ObservingSite'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Observing site not found.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
      delete: {
        summary: 'Remove an observing site',
        tags: ['Sites'],
        description: 'Admin only. Its pictures are removed too. The last remaining site cannot be deleted.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Deletion confirmed', 'SiteDeletedWithId'),
          400: { description: 'LAST_SITE. Add another site before removing this one.' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Observing site not found.' },
        },
      },
    },
    '/sites/{id}/default': {
      put: {
        summary: 'Make a site the default',
        tags: ['Sites'],
        description: 'Admin only. Clearing the previous default and setting the new one is one transaction. The default is mirrored onto the legacy location fields on GET /settings.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('The site now default', 'ObservingSite'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Observing site not found.' },
        },
      },
    },
    '/sites/{id}/photos': {
      get: {
        summary: 'Pictures of an observing site',
        tags: ['Sites'],
        description: 'Oldest first.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Array of pictures', 'SitePhoto', true),
          404: { description: 'NOT_FOUND. Observing site not found.' },
        },
      },
      post: {
        summary: 'Add a picture to a site',
        tags: ['Sites'],
        description: 'Admin only. multipart/form-data with one picture in the `file` field (JPEG, PNG, WebP, GIF or HEIC, up to 30 MB) and an optional `caption`. At most 40 pictures a site.',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: { type: 'string', format: 'binary' },
                  caption: { type: 'string', maxLength: 300 },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('The picture', 'SitePhoto'),
          400: { description: 'UPLOAD_FAILED or VALIDATION_ERROR. No picture was sent.' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Observing site not found.' },
          413: { description: 'FILE_TOO_LARGE' },
          422: { description: 'VALIDATION_ERROR. Not a picture, or the site already holds 40.' },
        },
      },
    },
    '/sites/{id}/bortle-lookup': {
      post: {
        summary: 'Look up the light pollution at a site',
        tags: ['Sites'],
        description: [
          'Admin only. Proxies darkskysites.com site intelligence for the site coordinates, turning the VIIRS satellite composite into a Bortle class and an SQM reading.',
          'Results are cached for a day, keyed on coordinates rounded to four decimals. The site must have a latitude and longitude.',
        ].join('\n'),
        parameters: [idParam],
        responses: {
          200: jsonResponse('The Bortle class, SQM reading and whether it was cached', 'BortleLookup'),
          400: { description: 'NO_COORDINATES. Set a latitude and longitude first.' },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Observing site not found.' },
          502: { description: 'UPSTREAM_ERROR. The light pollution service did not answer or returned something unexpected.' },
        },
      },
    },
    '/sites/photos/{photoId}': {
      get: {
        summary: 'A site picture',
        tags: ['Sites'],
        description: 'The file itself. `w=<pixels>` returns a JPEG preview no wider than that. Readable without a token so an <img> tag can show it.',
        parameters: [
          subIdParam('photoId'),
          { name: 'w', in: 'query', schema: { type: 'integer', minimum: 64, maximum: 2400 } },
        ],
        responses: {
          200: { description: 'The picture', content: { 'image/*': { schema: { type: 'string', format: 'binary' } } } },
          404: { description: 'NOT_FOUND. Picture not found.' },
        },
      },
      put: {
        summary: 'Change a picture caption',
        tags: ['Sites'],
        description: 'Admin only.',
        parameters: [subIdParam('photoId')],
        requestBody: jsonBody('SitePhotoCaptionInput'),
        responses: {
          200: jsonResponse('The picture', 'SitePhoto'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Picture not found.' },
          422: { description: 'VALIDATION_ERROR' },
        },
      },
      delete: {
        summary: 'Remove a picture',
        tags: ['Sites'],
        description: 'Admin only. Deletes the file too.',
        parameters: [subIdParam('photoId')],
        responses: {
          200: jsonResponse('Deletion confirmed', 'SiteDeleted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND. Picture not found.' },
        },
      },
    },
    '/forecast/recorded': {
      get: {
        summary: "A past night's recorded weather",
        tags: ['Forecast'],
        description: 'The hourly conditions kept for one night at a place (the forecast snapshot, which alone has seeing, else an archive row). `conditions` is null when nothing was kept.',
        parameters: [
          { name: 'night', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'lat', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'lon', in: 'query', required: true, schema: { type: 'number' } },
        ],
        responses: { 200: { description: '`{ conditions: NightConditions | null }`' } },
      },
    },

    // ── Sky events ────────────────────────────────────────────────────
    '/sky-events': {
      get: {
        summary: 'Sky events judged from an observing site',
        tags: ['Sky'],
        description: [
          'Moon phases, meteor showers, eclipses, planet oppositions, conjunctions, greatest elongations, equinoxes and solstices',
          'from 2026 to 2036, each judged from the observing site: whether it is up in the dark, how high, the best time to look,',
          'how much the Moon interferes, and the forecast score when the night is inside the forecast range.',
          '',
          'Read-only and answered from a bundled table; nothing is fetched from an outside service. Solar eclipses are judged only by',
          'Sun altitude and distance from the point of greatest eclipse, not by local circumstances.',
        ].join('\n'),
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'First local date. Defaults to today at the site.' },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Last local date. Defaults to 180 days after `from`; at most 1100 days apart.' },
          { name: 'siteId', in: 'query', schema: { type: 'string' }, description: 'Observing site. Defaults to the active site.' },
          { name: 'lat', in: 'query', schema: { type: 'number' }, description: 'Use with `lon` instead of a site.' },
          { name: 'lon', in: 'query', schema: { type: 'number' }, description: 'Use with `lat` instead of a site.' },
          { name: 'kinds', in: 'query', schema: { type: 'string' }, description: 'Comma-separated: moonPhase, meteorShower, lunarEclipse, solarEclipse, opposition, conjunction, elongation, season.' },
        ],
        responses: {
          200: { description: 'The site, the range, the date the table runs to, and the events in date order' },
          400: { description: 'INVALID_QUERY, INVALID_KINDS, INVALID_RANGE, RANGE_TOO_LARGE or INVALID_COORDS' },
        },
      },
    },

    // ── Annotate ──────────────────────────────────────────────────────
    '/annotate': {
      get: {
        summary: 'Objects in one picture',
        tags: ['Annotate'],
        description: 'Annotations for a library picture, with a quality tier: solved (plate solved), header (WCS from the FITS header), approximate (telescope field), or unavailable with a reason code. Does not start a solve.',
        parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'Library-relative path' }],
        responses: {
          200: jsonResponse('Annotations, quality and solver state', 'AnnotateResult'),
          400: { description: 'MISSING_PATH or INVALID_INPUT' },
          404: { description: 'NOT_FOUND' },
          415: { description: 'INVALID_INPUT. Unsupported file type.' },
          500: { description: 'ANNOTATE_FAILED' },
        },
      },
    },
    '/annotate/solve': {
      post: {
        summary: 'Plate solve one picture',
        tags: ['Annotate'],
        description: 'Starts a background solve and returns its initial state. The solver must already be installed.',
        parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('The solve job state', 'AnnotateSolveState'),
          400: { description: 'MISSING_PATH or INVALID_INPUT' },
          404: { description: 'NOT_FOUND' },
          409: { description: 'SOLVER_NOT_INSTALLED' },
          415: { description: 'INVALID_INPUT' },
          500: { description: 'ANNOTATE_FAILED' },
        },
      },
    },
    '/annotate/solver': {
      get: {
        summary: 'Plate solver availability',
        tags: ['Annotate'],
        description: 'Whether ASTAP is supported on this platform, which pieces are installed, and the install progress.',
        responses: { 200: jsonResponse('The solver status', 'AnnotateSolverStatus') },
      },
    },
    '/annotate/solver/install': {
      post: {
        summary: 'Install the plate solver',
        tags: ['Annotate'],
        description: 'Admin only. Downloads ASTAP and its star database in the background; poll /annotate/solver for progress.',
        responses: {
          200: jsonResponse('The solver status after the request', 'AnnotateSolverStatus'),
          403: { description: 'FORBIDDEN. Admin only.' },
          422: { description: 'UNSUPPORTED_PLATFORM' },
        },
      },
    },
    '/annotate/auto-solve': {
      get: {
        summary: 'Background solving status',
        tags: ['Annotate'],
        description: 'Whether automatic solving of new pictures is on, and how many are waiting, solved or failed.',
        responses: { 200: jsonResponse('The auto-solve status', 'AnnotateAutoSolveStatus') },
      },
    },
    '/annotate/auto-solve/run': {
      post: {
        summary: 'Solve what is waiting now',
        tags: ['Annotate'],
        description: 'Admin only. Runs one background pass and returns the status. Respects the automatic-solving switch.',
        responses: {
          200: jsonResponse('The auto-solve status after the request', 'AnnotateAutoSolveStatus'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },

    // ── Satellite trails ──────────────────────────────────────────────
    '/satellite/detect': {
      post: {
        summary: 'Detect a satellite trail in one frame',
        tags: ['Satellite'],
        description: 'Admin only. Reads the FITS header for the plate scale, detects a trail, and with `identifyOnly` matches it against the TLE catalog. Cached unless `skipCache`; a result without observer coordinates is not cached.',
        requestBody: jsonBody('SatelliteDetectInput'),
        responses: {
          200: {
            description: 'No trail, or the trail and its satellite candidates',
            content: {
              'application/json': {
                schema: { oneOf: [{ $ref: '#/components/schemas/SatelliteNoTrail' }, { $ref: '#/components/schemas/SatelliteTrailResult' }] },
              },
            },
          },
          400: { description: 'MISSING_PATH' },
          403: { description: 'FORBIDDEN. Admin only, or the path is outside the library.' },
          500: { description: 'DETECTION_FAILED' },
        },
      },
    },
    '/satellite/results': {
      post: {
        summary: 'Cached results for some files',
        tags: ['Satellite'],
        description: 'Admin only. Returns only the paths that have a cached result.',
        requestBody: jsonBody('SatelliteResultsInput'),
        responses: {
          200: jsonResponse('Path to cached result', 'SatelliteResults'),
          400: { description: 'MISSING_PATHS' },
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'CACHE_ERROR' },
        },
      },
    },
    '/satellite/catalog/status': {
      get: {
        summary: 'TLE catalog status',
        tags: ['Satellite'],
        description: 'How many satellites are loaded, where the catalog came from, whether it is stale or the bundled seed, and the archived date range.',
        responses: {
          200: jsonResponse('The catalog status', 'SatelliteCatalogStatus'),
          500: { description: 'CATALOG_ERROR' },
        },
      },
    },
    '/satellite/catalog/refresh': {
      post: {
        summary: 'Refresh the TLE catalog',
        tags: ['Satellite'],
        description: 'Admin only. Fetches current elements from Celestrak.',
        responses: {
          200: jsonResponse('The refreshed count', 'SatelliteRefreshResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'REFRESH_FAILED' },
        },
      },
    },
    '/satellite/cache': {
      delete: {
        summary: 'Clear the detection cache',
        tags: ['Satellite'],
        description: 'Admin only.',
        responses: {
          200: jsonResponse('Cleared', 'SatelliteCacheCleared'),
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'CACHE_ERROR' },
        },
      },
    },

    // ── Planner ───────────────────────────────────────────────────────
    '/planner': {
      get: {
        summary: 'Browse or search the DSO catalog',
        tags: ['Planner'],
        description: 'The same handler as GET /dso. With `q` it searches with relevance order; without it, it browses with catalog order. `lat` with `minAlt` drops objects that can never clear that altitude from the site.',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'constellation', in: 'query', schema: { type: 'string' } },
          { name: 'maxMag', in: 'query', schema: { type: 'number' } },
          { name: 'minSize', in: 'query', schema: { type: 'number' } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['name', 'magnitude'] } },
          { name: 'lat', in: 'query', schema: { type: 'number' } },
          { name: 'minAlt', in: 'query', schema: { type: 'number' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
        ],
        responses: {
          200: jsonResponse('Matching entries and the total', 'DsoBrowseResult'),
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/planner/{id}': {
      get: {
        summary: 'One DSO catalog entry',
        tags: ['Planner'],
        description: 'The same handler as GET /dso/{id}. Adds today\u2019s altitude and azimuth when the active site has coordinates.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('The entry', 'DsoEntry'),
          404: { description: 'NOT_FOUND' },
        },
      },
    },
    '/planner/plan': {
      post: {
        summary: 'Plan a night',
        tags: ['Planner'],
        description: [
          'Runs the canonical auto-scheduler over the candidate list the client already holds.',
          'The response data is the array of blocks. The envelope `meta` carries `weather` (whether a forecast was requested and used, its fetch time, the cloud limit, and the slots it skipped), `narrowbandCapable`, and `goals` (whether goal-favoring was requested and which targets are complete).',
        ].join('\n'),
        requestBody: jsonBody('PlannerPlanInput'),
        responses: {
          200: jsonResponse('The scheduled blocks', 'PlannerPlanBlock', true),
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/planner/verdict': {
      post: {
        summary: 'Judge placed blocks',
        tags: ['Planner'],
        description: 'Batch Moon-proximity and sky-visibility verdicts for already-placed blocks, so a dragged or resized block gets the same answer the auto-scheduler would give.',
        requestBody: jsonBody('PlannerVerdictInput'),
        responses: {
          200: jsonResponse('One verdict per item', 'PlannerVerdict', true),
          422: { description: 'VALIDATION_ERROR' },
        },
      },
    },
    '/planner/tonight': {
      get: {
        summary: "Tonight's visible targets",
        tags: ['Planner'],
        description: [
          'Returns all DSO catalog objects that are above the configured minimum altitude',
          '(and horizon obstruction profile) during tonight\'s astronomical night window.',
          'Sorted by peak altitude descending. Requires observer location to be set in Settings.',
          '',
          'Returns `locationSet: false` (with empty targets) when no location is configured.',
        ].join('\n'),
        parameters: [
          { name: 'minAlt', in: 'query', schema: { type: 'number' }, description: 'Override the saved minAlt setting (degrees)' },
          { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Filter by DSO type code or label' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 200, maximum: 500 } },
        ],
        responses: {
          200: {
            description: 'Planner response with target list and night conditions',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PlannerResponse' } } },
          },
        },
      },
    },
    '/planner/curve/{objectId}': {
      get: {
        summary: 'Altitude curve for tonight',
        tags: ['Planner'],
        description: 'Returns altitude and azimuth sampled every 15 minutes throughout tonight\'s night window.',
        parameters: [{ name: 'objectId', in: 'path', required: true, schema: { type: 'string' }, description: 'DSO catalog ID, e.g. M81' }],
        responses: {
          200: {
            description: 'Entry metadata and curve points',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    entry:      { $ref: '#/components/schemas/DsoEntry' },
                    curve:      { type: 'array', items: { $ref: '#/components/schemas/AltitudeCurvePoint' } },
                    nightStart: { ...isoDate },
                    nightEnd:   { ...isoDate },
                  },
                },
              },
            },
          },
          400: { description: 'Observer location not set' },
          404: { description: 'Object not in DSO catalog' },
        },
      },
    },

    // ── Wishlist ──────────────────────────────────────────────────────
    '/wishlist': {
      get: {
        summary: 'List wishlist',
        tags: ['Wishlist'],
        responses: { 200: { description: 'Array of wishlist items', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/WishlistItem' } } } } } },
      },
      post: {
        summary: 'Add to wishlist',
        tags: ['Wishlist'],
        description: 'Accepts a `objectId` (DSO catalog ID). Other fields are filled from the catalog. Prevents duplicates.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['objectId'],
                properties: {
                  objectId: strEx('M81'),
                  priority: { type: 'string', enum: [...WISHLIST_PRIORITIES], default: 'medium' },
                  notes:    { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Created wishlist item', content: { 'application/json': { schema: { $ref: '#/components/schemas/WishlistItem' } } } },
          409: { description: 'Object already on wishlist' },
        },
      },
    },
    '/wishlist/{id}': {
      patch: {
        summary: 'Update wishlist item',
        tags: ['Wishlist'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  priority: { type: 'string', enum: [...WISHLIST_PRIORITIES] },
                  notes:    { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Updated item' }, 404: { description: 'Not found' } },
      },
      delete: {
        summary: 'Remove wishlist item by ID',
        tags: ['Wishlist'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Removed' }, 404: { description: 'Not found' } },
      },
    },
    '/wishlist/object/{objectId}': {
      delete: {
        summary: 'Remove wishlist item by catalog ID',
        tags: ['Wishlist'],
        parameters: [{ name: 'objectId', in: 'path', required: true, schema: { type: 'string' }, description: 'e.g. M81' }],
        responses: { 200: { description: 'Removed' }, 404: { description: 'Not on wishlist' } },
      },
    },

    // ── Reports ───────────────────────────────────────────────────────
    '/reports/integration/{objectId}': {
      get: {
        summary: 'Total integration time for an object',
        tags: ['Reports'],
        description: 'Reads FITS headers from all sub-frames for this object and aggregates exposure time per session.',
        parameters: [{ $ref: '#/components/parameters/objectId' }],
        responses: {
          200: {
            description: 'Integration stats',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/IntegrationStats' } } },
          },
        },
      },
    },
    '/reports/session/{objectId}/{sessionDate}': {
      get: {
        summary: 'HTML session report',
        tags: ['Reports'],
        description: 'Returns a self-contained dark-themed HTML page with thumbnail, frame quality breakdown, integration time, FITS metadata, and moon conditions. Suitable for saving, printing, or sharing.',
        parameters: [
          { $ref: '#/components/parameters/objectId' },
          { name: 'sessionDate', in: 'path', required: true, schema: { ...isoDateD }, description: 'Session date YYYY-MM-DD' },
        ],
        responses: {
          200: { description: 'Self-contained HTML report', content: { 'text/html': { schema: { type: 'string' } } } },
        },
      },
    },

    // ── Storage ───────────────────────────────────────────────────────
    '/storage': {
      get: {
        summary: 'SeeStar storage breakdown',
        tags: ['Storage'],
        description: 'Per-object file sizes and counts from the SMB share. Computed in the background and cached for 5 minutes.',
        responses: {
          200: {
            description: 'Array of per-object stats plus a summary in meta',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/StorageObject' } } } },
          },
        },
      },
    },
    '/storage/system': {
      get: {
        summary: 'Host system disk usage',
        tags: ['Storage'],
        description: 'Returns disk usage for the partition where the app runs, plus size of the app data directory.',
        responses: {
          200: {
            description: 'System storage stats',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SystemStorage' } } },
          },
        },
      },
    },
    '/storage/library': {
      get: {
        summary: 'Library disk usage per object',
        tags: ['Storage'],
        description: 'Per-object sizes on the library disk, computed in the background and cached for 5 minutes. Skips the walk while the library is migrating or unreachable.',
        responses: { 200: jsonResponse('Per-object library usage', 'StorageLibrary') },
      },
    },
    '/storage/client-locality': {
      get: {
        summary: 'Is the browser on the server machine',
        tags: ['Storage'],
        description: 'Admin only. Lets the import dialog stop asking people to tell "this device" from "the server" when those are one machine.',
        responses: {
          200: jsonResponse('Locality and the server host name', 'StorageClientLocality'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/storage/volumes': {
      get: {
        summary: 'Mounted volumes',
        tags: ['Storage'],
        description: 'Admin only. Drives the library and import folder pickers can use, with free space and whether the service account can write there.',
        responses: {
          200: jsonResponse('The mounted volumes', 'StorageVolumes'),
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'VOLUMES_FAILED' },
        },
      },
    },
    '/storage/browse': {
      get: {
        summary: 'Subdirectories of a folder',
        tags: ['Storage'],
        description: 'Admin only. Hidden folders are left out. The path must be absolute; Windows drive letters and UNC paths are both accepted.',
        parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'Absolute path to list' }],
        responses: {
          200: jsonResponse('The normalized path and its subdirectories', 'StorageBrowse'),
          400: { description: 'INVALID_PATH or BROWSE_FAILED' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/storage/locate-folder': {
      post: {
        summary: 'Find a dropped folder on the server disk',
        tags: ['Storage'],
        description: 'Admin only. Given a folder name and a sample of its files, checks whether that exact folder exists on this machine so the import can read it in place instead of uploading. A miss returns `path: null`.',
        requestBody: jsonBody('StorageLocateInput'),
        responses: {
          200: jsonResponse('The located path, or null', 'StorageLocateResult'),
          400: { description: 'INVALID_LOCATE_INPUT' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/storage/library-location': {
      get: {
        summary: 'Where the library lives',
        tags: ['Storage'],
        description: 'The resolved library location, whether it is available, the last automatic recovery, and the current migration state.',
        responses: { 200: jsonResponse('Location and migration state', 'StorageLibraryLocationState') },
      },
    },
    '/storage/library-location/network/test': {
      post: {
        summary: 'Test an unsaved network library share',
        tags: ['Storage'],
        description: 'Admin only. Tries the credentials without persisting anything. An empty password uses the stored one.',
        requestBody: { required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/StorageNetworkConfigInput' } } } },
        responses: {
          200: jsonResponse('Whether the share could be read', 'StorageNetworkTest'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/storage/library-location/reset': {
      post: {
        summary: 'Forget the library location without moving files',
        tags: ['Storage'],
        description: 'Admin only. For when the old drive or path is gone for good. The library resolves to the default location afterwards; nothing is copied.',
        responses: {
          200: jsonResponse('The new location and the one that was abandoned', 'StorageLibraryResetResult'),
          400: { description: 'LIBRARY_PINNED. LIBRARY_DIR sets the location.' },
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'LIBRARY_BUSY. A migration is running.' },
        },
      },
    },
    '/storage/migrate': {
      post: {
        summary: 'Move the library',
        tags: ['Storage'],
        description: 'Admin only. Starts a background copy to a local folder or a network share. `adopt: true` registers an existing library at the destination without copying.',
        requestBody: jsonBody('StorageMigrateInput'),
        responses: {
          200: jsonResponse('The migration that was started', 'StorageMigrationWrapper'),
          400: { description: 'LIBRARY_PINNED, UNSUPPORTED_PLATFORM, INVALID_NETWORK_CONFIG, NETWORK_TO_NETWORK_UNSUPPORTED or INVALID_PATH' },
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'MIGRATION_FAILED' },
        },
      },
    },
    '/storage/migrate/status': {
      get: {
        summary: 'Library migration progress',
        tags: ['Storage'],
        responses: { 200: jsonResponse('The current migration state', 'StorageMigrationWrapper') },
      },
    },
    '/storage/renest/status': {
      get: {
        summary: 'Flat-to-nested reorganize status',
        tags: ['Storage'],
        description: 'Progress of the library-wide reorganize and how many objects are still flat.',
        responses: { 200: jsonResponse('Reorganize progress and the flat object count', 'StorageRenestState') },
      },
    },
    '/storage/renest': {
      post: {
        summary: 'Reorganize flat objects into session folders',
        tags: ['Storage'],
        description: 'Admin only. With `objectId` it reorganizes one object and answers with the result; without it, starts the library-wide run and answers immediately, tracked through /renest/status.',
        requestBody: { required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/StorageRenestInput' } } } },
        responses: {
          200: { description: '`{ result }` for one object, or `{ started: true }` for the whole library' },
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'LIBRARY_BUSY, RENEST_RUNNING or IMPORT_RUNNING' },
          500: { description: 'RENEST_FAILED' },
          503: { description: 'LIBRARY_UNAVAILABLE' },
        },
      },
    },
    '/storage/cleanup': {
      get: {
        summary: 'Space held by sub-frames',
        tags: ['Storage'],
        description: 'Admin only. How much the removable raw sub-frames occupy, with the biggest objects first. Refuses when the library is unreachable, because every file would look missing.',
        responses: {
          200: { description: '`{ subframes }` usage', content: { 'application/json': { schema: { type: 'object', required: ['subframes'], properties: { subframes: { $ref: '#/components/schemas/StorageSubframeUsage' } } } } } },
          403: { description: 'FORBIDDEN. Admin only.' },
          503: { description: 'LIBRARY_UNAVAILABLE' },
        },
      },
    },
    '/storage/cleanup/subframes': {
      delete: {
        summary: 'Purge every managed sub-frame',
        tags: ['Storage'],
        description: 'Admin only and destructive. Stacked images, thumbnails, previews and everything else are left alone.',
        responses: {
          200: jsonResponse('What was deleted and what was freed', 'StoragePurgeResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'An import is running (library busy)' },
          500: { description: 'PURGE_FAILED' },
          503: { description: 'LIBRARY_UNAVAILABLE' },
        },
      },
    },
    '/storage/analyze': {
      get: {
        summary: 'Scan for records that no longer match disk',
        tags: ['Storage'],
        description: 'Admin only. Read-only. Reports stale file rows, missing object folders, layout drift, duplicate session files and processed-image records whose file is gone.',
        responses: {
          200: jsonResponse('What the scan found', 'StorageAnalysis'),
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'ANALYZE_FAILED' },
          503: { description: 'LIBRARY_UNAVAILABLE' },
        },
      },
    },
    '/storage/analyze/duplicates': {
      get: {
        summary: 'List the duplicate session files a repair would remove',
        tags: ['Storage'],
        description: 'Admin only. Read-only. Returns each duplicate pair (the copy kept and the copy removed, with its size) after confirming the two files agree on sampled blocks, and writes the same list to the server log. The list is capped, with `truncated` set when it is.',
        responses: {
          200: { description: 'count, objects, bytes, pairs[] ({ objectId, keep, remove, bytes }) and truncated' },
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'DUPLICATES_FAILED' },
          503: { description: 'LIBRARY_UNAVAILABLE' },
        },
      },
    },
    '/storage/analyze/fix': {
      post: {
        summary: 'Repair one analysis category',
        tags: ['Storage'],
        description: 'Admin only. Fixes exactly the category named in the body. Refuses when some paths could not be checked, since "missing" cannot be told from "unreadable".',
        requestBody: jsonBody('StorageAnalyzeFixInput'),
        responses: {
          200: jsonResponse('The category and its repair counts', 'StorageRepairResult'),
          400: { description: 'BAD_CATEGORY' },
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'LIBRARY_UNREADABLE or library busy' },
          500: { description: 'REPAIR_FAILED' },
          503: { description: 'LIBRARY_UNAVAILABLE' },
        },
      },
    },
    '/storage/db-backups': {
      get: {
        summary: 'Database snapshots',
        tags: ['Storage'],
        description: 'Admin only. Retained pre-upgrade and manual snapshots, the last automatic attempt, and the retention limit.',
        responses: {
          200: jsonResponse('Snapshots and backup settings', 'StorageBackups'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
      post: {
        summary: 'Take a database snapshot now',
        tags: ['Storage'],
        description: 'Admin only. Uses VACUUM INTO, so the copy is safe while WAL is in use, then prunes older snapshots of the same kind.',
        responses: {
          200: jsonResponse('The new snapshot and how many were pruned', 'StorageBackupCreated'),
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'BACKUP_FAILED' },
        },
      },
    },
    '/storage/db-backups/{name}/download': {
      get: {
        summary: 'Download a database snapshot',
        tags: ['Storage'],
        description: 'Admin only. Streams the snapshot gzipped as an attachment.',
        parameters: [subIdParam('name')],
        responses: {
          200: { description: 'The gzipped snapshot', content: { 'application/gzip': { schema: { type: 'string', format: 'binary' } } } },
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
          500: { description: 'STREAM_ERROR' },
        },
      },
    },
    '/storage/db-backups/{name}': {
      delete: {
        summary: 'Delete a database snapshot',
        tags: ['Storage'],
        description: 'Admin only.',
        parameters: [subIdParam('name')],
        responses: {
          200: jsonResponse('Deletion confirmed', 'StorageDeleted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          404: { description: 'NOT_FOUND' },
          500: { description: 'DELETE_FAILED' },
        },
      },
    },
    '/storage/archive': {
      get: {
        summary: 'Archive configuration and destination state',
        tags: ['Storage'],
        description: 'Read-only, so no admin is needed. Reports whether the destination is unconfigured, absent, ours, or another install\u2019s archive.',
        responses: { 200: jsonResponse('Config and the destination state', 'StorageArchiveState') },
      },
      put: {
        summary: 'Save the archive settings',
        tags: ['Storage'],
        description: 'Admin only. Validates the whole patch before storing any of it and writes nothing to the destination disk. Only the fields sent change.',
        requestBody: jsonBody('StorageArchiveConfigInput'),
        responses: {
          200: jsonResponse('The saved config and the destination state', 'StorageArchiveState'),
          400: { description: 'ARCHIVE_INVALID_CONFIG or ARCHIVE_INVALID_DESTINATION' },
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'ARCHIVE_SAVE_FAILED' },
        },
      },
    },
    '/storage/archive/adopt': {
      post: {
        summary: 'Adopt a disk as the archive destination',
        tags: ['Storage'],
        description: 'Admin only. The only action that writes a marker, so saving a preference can never claim a disk. Takes over a foreign archive only when its id is echoed in `confirmArchiveId`.',
        requestBody: { required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/StorageArchiveAdoptInput' } } } },
        responses: {
          200: jsonResponse('The adopted config and destination state', 'StorageArchiveState'),
          400: { description: 'ARCHIVE_NO_DESTINATION, ARCHIVE_INVALID_DESTINATION, ARCHIVE_DESTINATION_UNUSABLE or ARCHIVE_DESTINATION_MISSING' },
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'ARCHIVE_MARKER_UNREADABLE, ARCHIVE_FOREIGN_CONFIRMATION_REQUIRED or ARCHIVE_DISABLED' },
          500: { description: 'ARCHIVE_ADOPT_FAILED' },
        },
      },
    },
    '/storage/archive/destination/test': {
      post: {
        summary: 'Test an unsaved archive share',
        tags: ['Storage'],
        description: 'Admin only. Tries a network destination with credentials that are not saved yet. Writes nothing.',
        requestBody: jsonBody('StorageArchiveTestInput'),
        responses: {
          200: jsonResponse('Whether the share answered, and why not', 'StorageArchiveTestResult'),
          400: { description: 'ARCHIVE_INVALID_CONFIG' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/storage/archive/destination/browse': {
      post: {
        summary: 'Browse folders inside an archive share',
        tags: ['Storage'],
        description: 'Admin only. A POST that only reads, because it may carry a password. Without `network` it browses the saved destination; `path` must stay inside the share root.',
        requestBody: { required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/StorageArchiveBrowseInput' } } } },
        responses: {
          200: jsonResponse('The requested folder and its subdirectories', 'StorageArchiveBrowse'),
          400: { description: 'ARCHIVE_NOT_NETWORK, ARCHIVE_INVALID_DESTINATION or ARCHIVE_PATH_OUTSIDE_SHARE' },
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'ARCHIVE_BROWSE_FAILED' },
          503: { description: 'ARCHIVE_DESTINATION_UNUSABLE' },
        },
      },
    },
    '/storage/archive/run/status': {
      get: {
        summary: 'Archive run progress',
        tags: ['Storage'],
        description: 'The run in progress, and how the last completed run ended.',
        responses: { 200: jsonResponse('Progress and the last run', 'StorageArchiveRunStatus') },
      },
    },
    '/storage/archive/run': {
      post: {
        summary: 'Archive now',
        tags: ['Storage'],
        description: 'Admin only. Answers 202 once the run is accepted and continues in the background; poll /archive/run/status. Up-front refusals are still 4xx.',
        responses: {
          202: jsonResponse('The run was accepted', 'StorageArchiveStarted'),
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'ARCHIVE_DISABLED, ARCHIVE_ALREADY_RUNNING, ARCHIVE_LIBRARY_BUSY, ARCHIVE_NO_DESTINATION or ARCHIVE_DESTINATION_UNUSABLE' },
          503: { description: 'LIBRARY_UNAVAILABLE' },
        },
      },
    },
    '/storage/archive/run/cancel': {
      post: {
        summary: 'Cancel the archive run',
        tags: ['Storage'],
        description: 'Admin only. Takes effect at the next file boundary. Files already copied stay on disk and in the record.',
        responses: {
          202: jsonResponse('The run is stopping', 'StorageArchiveCancelling'),
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'ARCHIVE_NOT_RUNNING' },
        },
      },
    },
    '/storage/archive/retention': {
      get: {
        summary: 'What retention would remove',
        tags: ['Storage'],
        description: 'Read-only dry run. Empty items means nothing is due, or nothing may be pruned; the warnings say which.',
        responses: { 200: jsonResponse('The retention plan', 'StorageRetentionPlan', false) },
      },
    },
    '/storage/archive/retention/apply': {
      post: {
        summary: 'Prune the archive',
        tags: ['Storage'],
        description: 'Admin only. Refuses when the archive or retention switch is off, and re-checks the destination before deleting anything.',
        responses: {
          200: jsonResponse('What was removed, with the plan it followed', 'StorageRetentionApplyResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'ARCHIVE_DISABLED, ARCHIVE_RETENTION_DISABLED or ARCHIVE_LIBRARY_BUSY' },
        },
      },
    },
    '/storage/archive/contents': {
      get: {
        summary: 'Browse the archive',
        tags: ['Storage'],
        description: 'Without `folder` it lists archived objects; with it, the files of that object and whether each is still present locally.',
        parameters: [{ name: 'folder', in: 'query', schema: { type: 'string' }, description: 'Archive folder name, which may contain spaces' }],
        responses: {
          200: {
            description: '`{ objects, warnings }` without folder, `{ files, warnings }` with it',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/StorageArchiveContentsObjects' },
                    { $ref: '#/components/schemas/StorageArchiveContentsFiles' },
                  ],
                },
              },
            },
          },
        },
      },
    },
    '/storage/archive/restore': {
      post: {
        summary: 'Restore archived files',
        tags: ['Storage'],
        description: 'Admin only. Writes the named files back into the library and runs the post-import pipeline for the objects that received files. Local files whose contents differ are left alone unless `overwrite` is true.',
        requestBody: jsonBody('StorageArchiveRestoreInput'),
        responses: {
          200: jsonResponse('What was restored, skipped or refused', 'StorageArchiveRestoreResult'),
          400: { description: 'ARCHIVE_INVALID_REQUEST' },
          403: { description: 'FORBIDDEN. Admin only.' },
          409: { description: 'ARCHIVE_DISABLED or ARCHIVE_LIBRARY_BUSY' },
          503: { description: 'LIBRARY_UNAVAILABLE' },
        },
      },
    },

    // ── Built-in catalog ──────────────────────────────────────────────
    '/catalog': {
      get: {
        summary: 'List built-in catalog entries',
        tags: ['Catalog (Built-in)'],
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/limit' },
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'constellation', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Catalog entries' } },
      },
    },
    '/catalog/search': {
      get: {
        summary: 'Search built-in catalog',
        tags: ['Catalog (Built-in)'],
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/limit' },
        ],
        responses: { 200: { description: 'Matching entries' } },
      },
    },
    '/catalog/{id}': {
      get: {
        summary: 'Get built-in catalog entry',
        tags: ['Catalog (Built-in)'],
        description: 'Falls back to the library object when the id has no static catalog entry, for example a Caldwell or custom object the user imported.',
        parameters: [idParam],
        responses: { 200: { description: 'Entry' }, 404: { description: 'NOT_FOUND' } },
      },
    },
    '/catalog/{id}/image': {
      get: {
        summary: 'Catalog image',
        tags: ['Catalog (Built-in)'],
        description: [
          'Streams the best cached master, in Hubble then Wikipedia then DSS2 priority unless `source` pins one.',
          'With `w` and `h` it returns a Sharp-resized JPEG, cached per size, source and fit; otherwise the native master.',
          'A cold cache tries a live DSS2 fetch first. Public, so an `<img>` tag can load it without a token.',
        ].join('\n'),
        parameters: [
          idParam,
          { name: 'w', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1920 }, description: 'Requested width. Needs h too; omitted means the native master size.' },
          { name: 'h', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1920 } },
          { name: 'fill', in: 'query', schema: { type: 'string', enum: ['inside', 'cover'], default: 'inside' }, description: 'cover center-crops to exactly w by h; inside preserves the aspect ratio' },
          { name: 'source', in: 'query', schema: { type: 'string', enum: ['hubble', 'wiki', 'dss2'] }, description: 'Pin a cached master instead of using the priority order' },
          { name: 'fov', in: 'query', schema: { type: 'number' }, description: 'Field of view in degrees for a cold DSS2 fetch' },
        ],
        responses: {
          200: { description: 'The image', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } },
          304: { description: 'Not modified since If-Modified-Since' },
          404: { description: 'NOT_CACHED. No image available for this id.' },
          500: { description: 'RESIZE_FAILED' },
        },
      },
    },
    '/catalog/{id}/sky': {
      get: {
        summary: 'Square sky cutout for framing',
        tags: ['Catalog (Built-in)'],
        description: 'DSS2 cutout centered on the object, spanning `fov` degrees, cached per FOV bucket. Public so the framing background can load it without a token.',
        parameters: [
          idParam,
          { name: 'fov', in: 'query', required: true, schema: { type: 'number' }, description: 'Field of view in degrees, positive' },
          { name: 'size', in: 'query', schema: { type: 'integer', default: 800 }, description: 'Output size in pixels' },
        ],
        responses: {
          200: { description: 'The cutout', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } },
          400: { description: 'BAD_FOV. fov is missing or not positive.' },
          404: { description: 'NO_COORDS or NOT_CACHED' },
        },
      },
    },
    '/catalog/{id}/sources': {
      get: {
        summary: 'Cached masters for one object',
        tags: ['Catalog (Built-in)'],
        description: 'Which of the Hubble, Wikipedia and DSS2 masters are on disk, with their size and pixel dimensions. Used by the gallery image picker.',
        parameters: [idParam],
        responses: { 200: jsonResponse('The canonical id and its cached sources', 'CatalogSources') },
      },
    },
    '/catalog/{id}/prefetch': {
      post: {
        summary: 'Re-fetch the imagery for one object',
        tags: ['Catalog (Built-in)'],
        description: 'Admin only. Force-fetches the DSS2, Wikipedia and Hubble sources for one object and blocks until they finish, so a single missed object can be recovered without rerunning the whole prefetch.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Which sources were fetched', 'CatalogPrefetchResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
          500: { description: 'PREFETCH_FAILED' },
        },
      },
    },
    '/catalog/{id}/info': {
      get: {
        summary: 'Object info for the object page',
        tags: ['Catalog (Built-in)'],
        description: [
          'The library row when the object has been imported, otherwise the static catalog entry, with user overrides winning over both.',
          'Description priority: override, curated text, cached Wikipedia extract, then the library or catalog description.',
        ].join('\n'),
        parameters: [idParam],
        responses: {
          200: jsonResponse('The merged object info', 'CatalogInfo'),
          404: { description: 'NOT_FOUND. Neither the library nor the catalog knows this id.' },
        },
      },
    },
    '/catalog/{id}/override': {
      put: {
        summary: 'Set catalog overrides',
        tags: ['Catalog (Built-in)'],
        description: 'Admin only. A field left out or blank becomes null, so the automatic source flows through again. Overrides apply to every read path that goes through the catalog lookup.',
        parameters: [idParam],
        requestBody: jsonBody('CatalogOverrideInput'),
        responses: {
          200: jsonResponse('The stored override', 'CatalogOverrideRecord'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
      delete: {
        summary: 'Remove catalog overrides',
        tags: ['Catalog (Built-in)'],
        description: 'Admin only.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Whether an override was removed', 'CatalogOverrideDeleted'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/catalog/credits/{id}': {
      get: {
        summary: 'Image credit for one object',
        tags: ['Catalog (Built-in)'],
        description: 'Reads the credits file of the first installed catalog tier that lists the object.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Source, credit line and license URL', 'CatalogCredit'),
          404: { description: 'NOT_FOUND. No credits found for this object.' },
        },
      },
    },
    '/catalog/prefetch/pack-debug': {
      get: {
        summary: 'Diagnose the catalog pack install path',
        tags: ['Catalog (Built-in)'],
        description: 'Runs each pack install step without changing state and reports where it fails: cache inventory, installed packs, index fetch, index signature, index parse, then each tier manifest.',
        responses: { 200: jsonResponse('Per-step outcomes', 'CatalogPackDebug') },
      },
    },
    '/catalog/prefetch/status': {
      get: {
        summary: 'Catalog prefetch status',
        tags: ['Catalog (Built-in)'],
        description: 'The job state, cache statistics and the installed pack versions.',
        responses: { 200: jsonResponse('Prefetch state, cache stats and pack states', 'CatalogPrefetchOverview') },
      },
    },
    '/catalog/prefetch/start': {
      post: {
        summary: 'Start the catalog prefetch',
        tags: ['Catalog (Built-in)'],
        description: 'Admin only. Starts the bulk imagery and Wikipedia prefetch. `phase` runs one phase alone; `scope=full` covers the whole catalog instead of the curated set.',
        parameters: [
          { name: 'force', in: 'query', schema: { type: 'boolean', default: false }, description: 'Restart even when a job is already running' },
          { name: 'packsOnly', in: 'query', schema: { type: 'boolean', default: false } },
          { name: 'phase', in: 'query', schema: { type: 'string', enum: ['images', 'wikipedia', 'caldwell'] } },
          { name: 'scope', in: 'query', schema: { type: 'string', enum: ['curated', 'full'], default: 'curated' } },
        ],
        responses: {
          200: jsonResponse('Whether it started, and the status after the attempt', 'CatalogPrefetchStartResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/catalog/prefetch/cancel': {
      post: {
        summary: 'Cancel the catalog prefetch',
        tags: ['Catalog (Built-in)'],
        description: 'Admin only.',
        responses: {
          200: jsonResponse('Whether a job was cancelled, and the status', 'CatalogPrefetchCancelResult'),
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/catalog/prefetch/cache': {
      delete: {
        summary: 'Wipe the catalog cache',
        tags: ['Catalog (Built-in)'],
        description: 'Admin only and destructive. The client must echo `confirmation: "reinitialize"` in the request body.',
        requestBody: jsonBody('CatalogCacheWipeInput'),
        responses: {
          200: jsonResponse('The cache was wiped, with fresh statistics', 'CatalogPrefetchWipeResult'),
          400: { description: 'CONFIRMATION_REQUIRED' },
          403: { description: 'FORBIDDEN. Admin only.' },
        },
      },
    },
    '/catalog/geocode/reverse': {
      get: {
        summary: 'Name a location from coordinates',
        tags: ['Catalog (Built-in)'],
        description: 'Reverse geocodes through Nominatim, cached on disk by coordinates rounded to two decimals, and resolves the IANA timezone.',
        parameters: [
          { name: 'lat', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'lon', in: 'query', required: true, schema: { type: 'number' } },
        ],
        responses: {
          200: jsonResponse('A display name and timezone, either may be null', 'GeocodeReverse'),
          400: { description: 'INVALID_PARAMS. lat and lon are required.' },
        },
      },
    },
    '/catalog/geocode/search': {
      get: {
        summary: 'Search for a place',
        tags: ['Catalog (Built-in)'],
        description: 'Forward geocodes through Open-Meteo. Queries shorter than two characters return an empty array.',
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('Matching places, at most eight', 'GeocodePlace', true),
        },
      },
    },
  },
};

router.get('/', (_req: Request, res: Response) => {
  res.json(spec);
});

export { router as openapiRouter };
