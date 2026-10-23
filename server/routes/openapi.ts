import { Router, Request, Response } from 'express';
import { TELESCOPE_KINDS } from '../lib/types/telescopeKind.js';
import { TRANSPORT_KINDS } from '../lib/telescopeTransports.js';
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
import { SKY_MAP_AZ_SLICES, SKY_MAP_BANDS, SKY_MAP_CELLS } from '../lib/skyMapConfig.js';

const router = Router();

// ─── Shared schema fragments ─────────────────────────────────────────

const nullable = (schema: Record<string, unknown>) => ({ ...schema, nullable: true });
const strEx    = (example: string) => ({ type: 'string', example });
const isoDate  = { type: 'string', format: 'date-time', example: '2024-01-15T22:30:00.000Z' };
const isoDateD = { type: 'string', format: 'date', example: '2024-01-15' };

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Nebulis API',
    version: '1.1.0',
    description: [
      'REST API for the Nebulis dashboard — browse and manage astronomical images',
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
          data:  { description: 'Response payload — type varies per endpoint' },
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

      // Tonight's planner target — DsoEntry plus visibility window
      PlannerTarget: {
        allOf: [{ $ref: '#/components/schemas/DsoEntry' }],
        type: 'object',
        properties: {
          maxAlt:       { type: 'number', description: 'Peak altitude tonight in degrees', example: 72.4 },
          maxAltTime:   nullable({ ...isoDate, description: 'UTC time of peak altitude' }),
          risesAt:      nullable({ ...isoDate, description: 'Time object rises above min altitude / horizon profile' }),
          setsAt:       nullable({ ...isoDate, description: 'Time object sets below min altitude / horizon profile' }),
          isInWishlist:    { type: 'boolean' },
          isAlreadyImaged: { type: 'boolean' },
        },
      },

      PlannerResponse: {
        type: 'object',
        properties: {
          locationSet:    { type: 'boolean' },
          targets:        { type: 'array', items: { $ref: '#/components/schemas/PlannerTarget' } },
          totalVisible:   { type: 'integer' },
          nightStart:     nullable({ ...isoDate }),
          nightEnd:       nullable({ ...isoDate }),
          sunset:         nullable({ ...isoDate }),
          sunrise:        nullable({ ...isoDate }),
          moonIllumination: { type: 'integer', minimum: 0, maximum: 100, description: 'Moon illumination %' },
          moonPhase:      { type: 'string', example: 'Waxing Crescent' },
          observerLat:    nullable({ type: 'number' }),
          observerLon:    nullable({ type: 'number' }),
          observerTimezone: nullable(strEx('America/Chicago')),
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
      TelescopeProfile: {
        type: 'object',
        properties: {
          id:        strEx('uuid'),
          name:      strEx('My SeeStar'),
          model:     strEx('SeeStar S50'),
          hostname:  strEx('seestar.local'),
          shareName: strEx('EMMC Images'),
          username:  strEx('guest'),
          password:  { type: 'string', description: 'Masked in responses' },
          createdAt: isoDate,
          kind:      { type: 'string', enum: [...TELESCOPE_KINDS] },
          color:     strEx('#3b82f6'),
          autoImportEnabled: { type: 'boolean', description: 'Whether the auto-import scheduler polls this telescope' },
          autoImportInterval: { type: 'integer', description: 'Minutes between auto-imports for this telescope' },
          archivedAt: nullable({ type: 'integer', description: 'Unix ms when the profile was archived, or null if active' }),
          connectionType: {
            type: 'string',
            enum: [...TRANSPORT_KINDS],
            description: '"smb" = LAN share (SeeStar); "local" = direct filesystem path (USB mount); "ftp" = anonymous FTP over Wi-Fi (Dwarf)',
          },
          localPath: { type: 'string', description: 'Absolute filesystem path when connectionType is "local". Empty for SMB and FTP profiles.' },
          deviceId: nullable({ type: 'string', description: 'Physical device UUID read from the device once connected; null until then' }),
          importJpg:        { type: 'boolean', description: 'Per-telescope file-type import filter' },
          importFits:       { type: 'boolean', description: 'Per-telescope file-type import filter' },
          importThumbnails: { type: 'boolean', description: 'Per-telescope file-type import filter' },
          importSubFrames:  { type: 'boolean', description: 'Per-telescope file-type import filter' },
          importVideos:     { type: 'boolean', description: 'Per-telescope file-type import filter' },
          archiveAllFiles:  { type: 'boolean', description: 'Keep files Nebulis has no use for, so this telescope\'s library folder is a complete copy of the device' },
          pinnedTransportId: nullable({ type: 'string', description: 'Transport id to force, overriding the local > ftp > smb heuristic. Null means "Auto".' }),
          activeOpticalConfigId: nullable({ type: 'string', description: 'Currently mounted optical config, for kinds with no fixed field of view. Null means "use the oldest config".' }),
          trackDeviceIdentity: {
            type: 'boolean',
            description: 'When true, the import pipeline reads/writes a device-identity marker so the same physical telescope reached over two transports (e.g. Wi-Fi and USB) resolves to one logical device',
          },
        },
      },

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
            description: 'Elevation-band count the server supports for visibleSkyMap. Native clients gate the finer-grid sky map editor on this — a client built for fewer bands should keep using its own resolution rather than assume this value.',
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
        description: 'Partial update — only send fields you want to change. To keep the current password/API key, omit those fields or send the masked placeholder.',
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

    // ── Telescope profiles & status ───────────────────────────────────
    '/telescopes': {
      get: {
        summary: 'List telescope profiles',
        tags: ['Telescope'],
        responses: { 200: { description: 'Array of profiles with activeId in meta' } },
      },
      post: {
        summary: 'Create telescope profile',
        tags: ['Telescope'],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/TelescopeProfile' } } } },
        responses: { 200: { description: 'New profile' } },
      },
    },
    '/telescopes/active': {
      get: { summary: 'Get active telescope', tags: ['Telescope'], responses: { 200: { description: 'Active telescope profile' }, 404: { description: 'None configured' } } },
    },
    '/telescopes/active/{id}': {
      put: {
        summary: 'Set active telescope',
        tags: ['Telescope'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Updated active profile' }, 404: { description: 'Profile not found' } },
      },
    },
    '/telescopes/{id}': {
      put: {
        summary: 'Update telescope profile',
        tags: ['Telescope'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/TelescopeProfile' } } } },
        responses: { 200: { description: 'Updated profile' } },
      },
      delete: {
        summary: 'Delete telescope profile',
        tags: ['Telescope'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deletion confirmed' }, 400: { description: 'Cannot delete only profile' } },
      },
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
    '/telescope/objects/{objectId}/sessions/{sessionId}/thumbnail': {
      get: {
        summary: 'Session thumbnail',
        tags: ['Library (SMB)'],
        parameters: [
          { $ref: '#/components/parameters/objectId' },
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/format' },
        ],
        responses: { 200: { description: 'JPEG binary or base64 JSON' } },
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
        parameters: [{ $ref: '#/components/parameters/objectId' }],
        responses: { 200: { description: 'Session list' } },
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
        description: 'Starts a background import from the telescope into local storage, over whichever transport the profile resolves to (SMB, FTP, or a USB mount).',
        responses: { 200: { description: 'Import started or already running' } },
      },
    },
    '/library/import/status': {
      get: {
        summary: 'Import status',
        tags: ['Library (Local)'],
        responses: { 200: { description: 'running, progress, and last-import details' } },
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
        responses: { 200: { description: 'Array of gear items' } },
      },
      post: {
        summary: 'Add gear',
        tags: ['Gear'],
        description: 'Admin only. Body: `kind`, `name`, and optionally `brand`, `model`, `specs`, `telescopeId`, `notes`.',
        responses: { 200: { description: 'The new gear item' }, 422: { description: 'VALIDATION_ERROR' } },
      },
    },
    '/gear/{id}': {
      get: { summary: 'One gear item', tags: ['Gear'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The gear item' }, 404: { description: 'Not found' } } },
      put: { summary: 'Change gear', tags: ['Gear'], description: 'Admin only. Any of the fields from add. A new `kind` re-validates the specs against it.', responses: { 200: { description: 'The updated item' } } },
      delete: { summary: 'Delete gear', tags: ['Gear'], description: 'Admin only. Also removes it from every kit.', responses: { 200: { description: 'Deleted' } } },
    },
    '/gear/{id}/archive': { post: { summary: 'Archive gear', tags: ['Gear'], description: 'Admin only. Hides it from the list without losing it. `/unarchive` reverses it.', responses: { 200: { description: 'The archived item' } } } },
    '/gear/kits': {
      get: { summary: 'List packing lists', tags: ['Gear'], responses: { 200: { description: 'Array of kits: `name`, `itemIds` (gear and telescope ids), `extraItems` (free-text lines), `siteId`' } } },
      post: { summary: 'Add a packing list', tags: ['Gear'], description: 'Admin only.', responses: { 200: { description: 'The new kit' } } },
    },
    '/gear/kits/{id}': {
      put: { summary: 'Change a packing list', tags: ['Gear'], description: 'Admin only.', responses: { 200: { description: 'The updated kit' } } },
      delete: { summary: 'Delete a packing list', tags: ['Gear'], description: 'Admin only. Also removes its ticks.', responses: { 200: { description: 'Deleted' } } },
    },
    '/gear/kits/{id}/checks': {
      get: { summary: 'Ticked lines for a night', tags: ['Gear'], parameters: [{ name: 'night', in: 'query', required: true, schema: { type: 'string', format: 'date' } }], responses: { 200: { description: '`{ night, checked: string[] }`, the keys of the ticked lines' } } },
      put: { summary: 'Tick or untick a line', tags: ['Gear'], description: 'Admin only. Body `{ itemKey, checked }`. Ticks older than 30 days are dropped.', responses: { 200: { description: 'The ticked lines for that night' } } },
      delete: { summary: 'Untick everything for a night', tags: ['Gear'], description: 'Admin only.', responses: { 200: { description: 'An empty list' } } },
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
        responses: { 200: { description: 'Array of entries, each with its `attachments` and `checklist`' } },
      },
      post: { summary: 'Add an entry', tags: ['Journal'], description: 'Admin only. Body: `night`, and optionally `objectId`, `filePath`, `title`, `body`, `checklist` (`[{ text, done }]`).', responses: { 200: { description: 'The new entry' }, 422: { description: 'VALIDATION_ERROR' } } },
    },
    '/journal/{id}': {
      get: { summary: 'One entry', tags: ['Journal'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The entry' }, 404: { description: 'Not found' } } },
      put: { summary: 'Change an entry', tags: ['Journal'], description: 'Admin only. Any of the fields from add.', responses: { 200: { description: 'The updated entry' } } },
      delete: { summary: 'Delete an entry', tags: ['Journal'], description: 'Admin only. Also deletes its files.', responses: { 200: { description: 'Deleted' } } },
    },
    '/journal/{id}/attachments': {
      post: { summary: 'Attach a file', tags: ['Journal'], description: 'Admin only. multipart/form-data with one file in the `file` field, up to 100 MB; at most 30 files an entry.', responses: { 200: { description: 'The attachment' }, 413: { description: 'FILE_TOO_LARGE' } } },
    },
    '/journal/attachments/{id}': {
      get: { summary: 'An attached file', tags: ['Journal'], description: 'Pictures, PDFs and plain text are served inline; anything else, or any file with `download=1`, as a download.', responses: { 200: { description: 'The file' }, 404: { description: 'Not found' } } },
      delete: { summary: 'Remove an attached file', tags: ['Journal'], description: 'Admin only.', responses: { 200: { description: 'Deleted' } } },
    },
    '/sites/{id}/photos': {
      get: { summary: 'Pictures of an observing site', tags: ['Sites'], description: 'Oldest first. Each has `id`, `fileName`, `mimeType`, `size`, `caption` and `createdAt`.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Array of pictures' }, 404: { description: 'Site not found' } } },
      post: { summary: 'Add a picture to a site', tags: ['Sites'], description: 'Admin only. multipart/form-data with one picture in the `file` field (JPEG, PNG, WebP, GIF or HEIC, up to 30 MB) and an optional `caption`. At most 40 pictures a site.', responses: { 200: { description: 'The picture' }, 413: { description: 'FILE_TOO_LARGE' }, 422: { description: 'VALIDATION_ERROR' } } },
    },
    '/sites/photos/{photoId}': {
      get: { summary: 'A site picture', tags: ['Sites'], description: 'The file itself. `w=<pixels>` returns a JPEG preview no wider than that. Readable without a token so an <img> tag can show it.', parameters: [{ name: 'photoId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'w', in: 'query', schema: { type: 'integer', minimum: 64, maximum: 2400 } }], responses: { 200: { description: 'The picture' }, 404: { description: 'Not found' } } },
      put: { summary: 'Change a picture caption', tags: ['Sites'], description: 'Admin only. Body: `{ caption }`.', responses: { 200: { description: 'The picture' } } },
      delete: { summary: 'Remove a picture', tags: ['Sites'], description: 'Admin only. Deletes the file too.', responses: { 200: { description: 'Deleted' } } },
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

    // ── Planner ───────────────────────────────────────────────────────
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
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Entry' }, 404: { description: 'Not found' } },
      },
    },
  },
};

router.get('/', (_req: Request, res: Response) => {
  res.json(spec);
});

export { router as openapiRouter };
