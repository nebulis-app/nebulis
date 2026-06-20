import { Router, Request, Response } from 'express';

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
          type:        { type: 'string', enum: ['image', 'fits', 'video', 'thumbnail', 'other'] },
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
          priority:        { type: 'string', enum: ['high', 'medium', 'low'], default: 'medium' },
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
          kind:      { type: 'string', enum: ['seestar-s50', 'seestar-s30', 'dwarf-3', 'dwarf-2', 'dwarf-mini', 'other'] },
          color:     strEx('#3b82f6'),
          autoImportEnabled: { type: 'boolean', description: 'Whether the auto-import scheduler polls this telescope' },
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

      // Settings
      Settings: {
        type: 'object',
        properties: {
          hostname:        strEx('192.168.1.100'),
          shareName:       strEx('EMMC Images'),
          username:        strEx('guest'),
          password:        { type: 'string', description: 'Masked in responses — send unchanged mask to keep current value' },
          model:           strEx('SeeStar S50'),
          hasApiKey:       { type: 'boolean' },
          hasPassword:     { type: 'boolean' },
          latitude:        nullable({ type: 'number', example: 40.7128, description: 'Observer latitude, decimal degrees north' }),
          longitude:       nullable({ type: 'number', example: -74.006, description: 'Observer longitude, decimal degrees east' }),
          timezone:        strEx('America/New_York'),
          minAlt:          { type: 'integer', default: 20, description: 'Minimum altitude in degrees for planner visibility filter (0–45)' },
          horizonProfile:  {
            type: 'array',
            items: { type: 'integer', minimum: 0, maximum: 85 },
            minItems: 36,
            maxItems: 36,
            description: '36 blocked-altitude values (degrees), one per 10° azimuth bucket starting at 0° (North) clockwise',
          },
          syncEnabled:     { type: 'boolean' },
          syncJpg:         { type: 'boolean' },
          syncFits:        { type: 'boolean' },
          syncThumbnails:  { type: 'boolean' },
          syncSubFrames:   { type: 'boolean' },
          syncVideos:      { type: 'boolean' },
          autoImportInterval: { type: 'integer', description: 'Minutes between auto-imports' },
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
        description: 'Probes TCP port 445 (SMB) on the configured hostname to determine reachability. Result is cached for 30 seconds.',
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
          { name: 'fileType', in: 'query', schema: { type: 'string', enum: ['image', 'fits', 'video', 'thumbnail', 'other'] } },
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
    '/library/import': {
      post: {
        summary: 'Trigger library import',
        tags: ['Library (Local)'],
        description: 'Starts a background import from the telescope SMB share into local storage.',
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
                  priority: { type: 'string', enum: ['high', 'medium', 'low'], default: 'medium' },
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
                  priority: { type: 'string', enum: ['high', 'medium', 'low'] },
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
