/**
 * Shared mock data and API route helpers for e2e tests.
 *
 * All tests mock the backend via Playwright's page.route() so they run
 * without a live server, a real SMB share, or any FITS files.
 *
 * Usage:
 *   import { mockAllRoutes, MOCK } from './fixtures/mocks';
 *   await mockAllRoutes(page);
 */
import type { Page, Route } from '@playwright/test';

// ─── Envelope helper ─────────────────────────────────────────────────────────

export function ok<T>(data: T) {
  return { ok: true, data };
}

// ─── Mock data ────────────────────────────────────────────────────────────────

export const MOCK = {
  // Open-access by default: no stored token + hasUsers:false means App.tsx
  // never shows the login modal, so content specs render the app directly.
  // Specs that exercise the login gate (auth.spec) opt in via mockHasUsers().
  authStatus: { hasUsers: false, requiresSetup: false },

  loginResponse: {
    token: 'test-jwt-token',
    user: { id: 'user-1', username: 'testuser', displayName: 'Test User', email: 'test@example.com', role: 'admin' as const },
  },

  viewerUser: {
    id: 'user-3', username: 'viewer', displayName: 'Viewer User', email: 'viewer@example.com', role: 'viewer' as const,
  },

  users: [
    { id: 'user-1', username: 'testuser', displayName: 'Test User', email: 'test@example.com', role: 'admin' as const, createdAt: '2024-01-01T00:00:00Z' },
    { id: 'user-2', username: 'admin', displayName: 'Admin User', email: 'admin@example.com', role: 'admin' as const, createdAt: '2024-01-02T00:00:00Z' },
  ],

  settings: {
    hostname: '192.168.1.100',
    shareName: 'Seestar',
    username: 'seestar',
    password: '',
    model: 'S50',
    catalogSource: 'builtin',
    customCatalogUrl: '',
    apiKey: '',
    hasApiKey: false,
    hasPassword: false,
    latitude: 37.77,
    longitude: -122.42,
    timezone: 'America/Los_Angeles',
    minAlt: 20,
    horizonProfile: Array(36).fill(10),
    syncEnabled: true,
    syncJpg: true,
    syncFits: true,
    syncThumbnails: true,
    syncSubFrames: false,
    syncVideos: false,
    includeSubFrames: false,
    autoImport: false,
    autoImportInterval: 30,
    importJpg: true,
    importFits: true,
    importThumbnails: true,
    importSubFrames: false,
    importVideos: false,
  },

  objects: [
    {
      id: 'M42',
      catalogId: 'M42',
      folderName: 'M42',
      name: 'Orion Nebula',
      type: 'Emission Nebula',
      constellation: 'Orion',
      description: 'The Orion Nebula is a diffuse nebula in Orion.',
      magnitude: 4.0,
      ra: '05h 35m 17s',
      dec: '-05° 23′ 28″',
      hasSubFrames: true,
      thumbnailUrl: '/api/library/objects/M42/thumbnail',
      sessionsUrl: '/api/library/objects/M42/sessions',
      filesUrl: '/api/library/objects/M42/files',
      subFramesUrl: '/api/library/objects/M42/subs',
      sessionCount: 3,
      lastImport: '2024-03-15T22:00:00Z',
      source: 'local' as const,
      isFavorite: false,
    },
    {
      id: 'M31',
      catalogId: 'M31',
      folderName: 'M31',
      name: 'Andromeda Galaxy',
      type: 'Galaxy',
      constellation: 'Andromeda',
      description: 'The Andromeda Galaxy is the nearest major galaxy.',
      magnitude: 3.4,
      ra: '00h 42m 44s',
      dec: '+41° 16′ 09″',
      hasSubFrames: false,
      thumbnailUrl: '/api/library/objects/M31/thumbnail',
      sessionsUrl: '/api/library/objects/M31/sessions',
      filesUrl: '/api/library/objects/M31/files',
      subFramesUrl: null,
      sessionCount: 2,
      lastImport: '2024-02-20T21:00:00Z',
      source: 'local' as const,
      isFavorite: true,
    },
    {
      id: 'NGC7000',
      catalogId: 'NGC7000',
      folderName: 'NGC7000',
      name: 'North America Nebula',
      type: 'Emission Nebula',
      constellation: 'Cygnus',
      description: 'Large emission nebula resembling North America.',
      magnitude: 4.0,
      ra: '20h 59m 17s',
      dec: '+44° 31′ 44″',
      hasSubFrames: false,
      thumbnailUrl: '/api/library/objects/NGC7000/thumbnail',
      sessionsUrl: '/api/library/objects/NGC7000/sessions',
      filesUrl: '/api/library/objects/NGC7000/files',
      subFramesUrl: null,
      sessionCount: 1,
      lastImport: '2024-01-10T20:00:00Z',
      source: 'local' as const,
      isFavorite: false,
    },
  ],

  sessions: [
    {
      id: '2024-03-15',
      date: '2024-03-15',
      objectId: 'M42',
      fileCount: 12,
      stackedCount: 1,
      fitsCount: 10,
      imageCount: 1,
      thumbnailUrl: '/api/library/objects/M42/thumbnail',
      filesUrl: '/api/library/objects/M42/sessions/2024-03-15/files',
    },
    {
      id: '2024-02-10',
      date: '2024-02-10',
      objectId: 'M42',
      fileCount: 8,
      stackedCount: 1,
      fitsCount: 6,
      imageCount: 1,
      thumbnailUrl: '/api/library/objects/M42/thumbnail',
      filesUrl: '/api/library/objects/M42/sessions/2024-02-10/files',
    },
  ],

  sessionFiles: [
    {
      name: 'Stacked_M42_2024-03-15.fit',
      size: 15728640,
      type: 'fits' as const,
      fileType: 'stacked' as const,
      path: '/data/library/M42/2024-03-15/Stacked_M42_2024-03-15.fit',
      exposure: '600',
      filter: 'LP',
      timestamp: '2024-03-15T22:30:00Z',
      date: '2024-03-15',
      frameCount: 120,
      isThumbnail: false,
      downloadUrl: '/api/library/file?path=/data/library/M42/2024-03-15/Stacked_M42_2024-03-15.fit',
    },
    {
      name: 'M42_2024-03-15.jpg',
      size: 524288,
      type: 'image' as const,
      fileType: 'stacked' as const,
      path: '/data/library/M42/2024-03-15/M42_2024-03-15.jpg',
      exposure: null,
      filter: null,
      timestamp: '2024-03-15T22:30:00Z',
      date: '2024-03-15',
      frameCount: null,
      isThumbnail: false,
      downloadUrl: '/api/library/file?path=/data/library/M42/2024-03-15/M42_2024-03-15.jpg',
    },
    {
      name: 'sub_001.fit',
      size: 1048576,
      type: 'fits' as const,
      fileType: 'sub' as const,
      path: '/data/library/M42/2024-03-15/sub_001.fit',
      exposure: '5',
      filter: 'LP',
      timestamp: '2024-03-15T21:00:00Z',
      date: '2024-03-15',
      frameCount: 1,
      isThumbnail: false,
      downloadUrl: '/api/library/file?path=/data/library/M42/2024-03-15/sub_001.fit',
      subIndex: 1,
    },
  ],

  observations: [
    {
      id: 'obs-1',
      objectId: 'M42',
      objectName: 'Orion Nebula',
      catalogId: 'M42',
      type: 'Emission Nebula',
      constellation: 'Orion',
      date: '2024-03-15',
      startTime: '2024-03-15T21:00:00Z',
      endTime: '2024-03-15T23:00:00Z',
      fileCount: 12,
      stackedCount: 1,
      fitsCount: 10,
      thumbnailUrl: '/api/library/objects/M42/thumbnail',
      ra: '05h 35m 17s',
      dec: '-05° 23′ 28″',
      hasNotes: true,
    },
    {
      id: 'obs-2',
      objectId: 'M31',
      objectName: 'Andromeda Galaxy',
      catalogId: 'M31',
      type: 'Galaxy',
      constellation: 'Andromeda',
      date: '2024-02-20',
      startTime: '2024-02-20T20:00:00Z',
      endTime: '2024-02-20T22:30:00Z',
      fileCount: 8,
      stackedCount: 1,
      fitsCount: 6,
      thumbnailUrl: '/api/library/objects/M31/thumbnail',
      ra: '00h 42m 44s',
      dec: '+41° 16′ 09″',
      hasNotes: false,
    },
  ],

  observationDetail: {
    objectId: 'M42',
    date: '2024-03-15',
    objectName: 'Orion Nebula',
    catalogId: 'M42',
    type: 'Emission Nebula',
    constellation: 'Orion',
    files: [],
    stackedFiles: [],
    subFiles: [],
    imageFiles: [],
    ra: '05h 35m 17s',
    dec: '-05° 23′ 28″',
    startTime: '2024-03-15T21:00:00Z',
    endTime: '2024-03-15T23:00:00Z',
  },

  catalogEntry: {
    id: 'M42',
    name: 'Orion Nebula',
    type: 'Emission Nebula',
    constellation: 'Orion',
    magnitude: 4.0,
    description: 'The Orion Nebula is the nearest region of massive star formation.',
    ra: '05h 35m 17s',
    dec: '-05° 23′ 28″',
  },

  importStatus: {
    running: false,
    currentObject: null,
    objectsTotal: 0,
    objectsDone: 0,
    filesTotal: 0,
    filesDone: 0,
    lastRun: '2024-03-15T23:00:00Z',
    error: null,
  },

  importRunning: {
    running: true,
    currentObject: 'M42',
    telescopeId: 'scope-1',
    telescopeName: 'Seestar S50',
    transportKind: 'smb' as const,
    objectsTotal: 3,
    objectsDone: 1,
    filesTotal: 30,
    filesDone: 12,
    currentObjectFilesTotal: 30,
    currentObjectFilesDone: 12,
    bytesTotal: 104857600,
    bytesDone: 52428800,
    skippedFiles: 0,
    lastRun: null,
    error: null,
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    warmingThumbnails: null,
  },

  wishlist: [
    {
      id: 'wl-1',
      objectId: 'M51',
      objectName: 'Whirlpool Galaxy',
      catalogId: 'M51',
      type: 'Galaxy',
      constellation: 'Canes Venatici',
      magnitude: 8.4,
      priority: 'high' as const,
      notes: 'Great spring target',
      addedAt: '2024-03-01T00:00:00Z',
    },
    {
      id: 'wl-2',
      objectId: 'M81',
      objectName: 'Bode\'s Galaxy',
      catalogId: 'M81',
      type: 'Galaxy',
      constellation: 'Ursa Major',
      magnitude: 6.9,
      priority: 'medium' as const,
      notes: '',
      addedAt: '2024-02-15T00:00:00Z',
    },
  ],

  // Tonight's observable targets, in the current PlannerTarget shape returned
  // by GET /planner/tonight (see src/lib/api/planner.ts). The planner library
  // pane renders these; the timeline/night-window fields are added by the route
  // handler since they're computed relative to "now".
  plannerTargets: [
    {
      id: 'M42',
      ngcName: 'NGC 1976',
      name: 'Orion Nebula',
      type: 'Emission Nebula',
      typeCode: 'Neb',
      constellation: 'Orion',
      magnitude: 4.0,
      majorAxisArcmin: 85,
      ra: 5.58,
      dec: -5.39,
      commonNames: ['Orion Nebula'],
      messier: 42,
      altNow: 35,
      azNow: 150,
      maxAlt: 55,
      maxAltTime: null,
      risesAt: null,
      setsAt: null,
      isInWishlist: false,
      isAlreadyImaged: true,
      libraryObjectId: 'obj-m42',
    },
    {
      id: 'M45',
      ngcName: '',
      name: 'Pleiades',
      type: 'Open Cluster',
      typeCode: 'OCl',
      constellation: 'Taurus',
      magnitude: 1.6,
      majorAxisArcmin: 110,
      ra: 3.79,
      dec: 24.12,
      commonNames: ['Pleiades'],
      messier: 45,
      altNow: 40,
      azNow: 200,
      maxAlt: 68,
      maxAltTime: null,
      risesAt: null,
      setsAt: null,
      isInWishlist: true,
      isAlreadyImaged: false,
      libraryObjectId: null,
    },
    {
      id: 'M51',
      ngcName: 'NGC 5194',
      name: 'Whirlpool Galaxy',
      type: 'Galaxy',
      typeCode: 'Gx',
      constellation: 'Canes Venatici',
      magnitude: 8.4,
      majorAxisArcmin: 11,
      ra: 13.49,
      dec: 47.19,
      commonNames: ['Whirlpool Galaxy'],
      messier: 51,
      altNow: 50,
      azNow: 90,
      maxAlt: 72,
      maxAltTime: null,
      risesAt: null,
      setsAt: null,
      isInWishlist: false,
      isAlreadyImaged: false,
      libraryObjectId: null,
    },
  ],

  // A DSO-catalog entry that never clears the horizon from the mock observer
  // (lat 37.77, far-southern declination). The planner omits it from
  // /planner/tonight, so a search must surface it from the full /dso catalog as
  // a dimmed, non-draggable "not observable" row.
  dsoBelowHorizon: {
    id: 'NGC104',
    ngcName: 'NGC 104',
    name: '47 Tucanae',
    type: 'Globular Cluster',
    typeCode: 'GCl',
    constellation: 'Tucana',
    magnitude: 4.0,
    majorAxisArcmin: 50,
    ra: 0.4,
    dec: -72.08,
    commonNames: ['47 Tucanae'],
    messier: null,
  },

  altitudeCurve: {
    objectId: 'M42',
    points: Array.from({ length: 48 }, (_, i) => ({
      time: new Date(Date.now() + i * 30 * 60 * 1000).toISOString(),
      alt: Math.max(0, 55 * Math.sin((i / 48) * Math.PI)),
      az: (i / 48) * 360,
    })),
    maxAlt: 55,
    transitTime: '2024-03-15T23:00:00Z',
    risesAt: '2024-03-15T20:00:00Z',
    setsAt: '2024-03-16T02:00:00Z',
  },

  storageStats: {
    telescopeOnline: false,
    objects: [
      {
        id: 'M42',
        name: 'Orion Nebula',
        totalSize: 524288000,
        fileCount: 45,
        subFrameCount: 30,
        subFrameSize: 31457280,
        imageCount: 3,
        fitsCount: 12,
        oldestFile: '2024-01-15T00:00:00Z',
        newestFile: '2024-03-15T00:00:00Z',
      },
      {
        id: 'M31',
        name: 'Andromeda Galaxy',
        totalSize: 209715200,
        fileCount: 22,
        subFrameCount: 0,
        subFrameSize: 0,
        imageCount: 2,
        fitsCount: 8,
        oldestFile: '2024-02-20T00:00:00Z',
        newestFile: '2024-02-20T00:00:00Z',
      },
    ],
  },

  systemStorage: {
    disk: {
      total: 500107862016,
      used: 250053931008,
      free: 250053931008,
      usedPercent: 50,
      totalFormatted: '500 GB',
      usedFormatted: '250 GB',
      freeFormatted: '250 GB',
    },
    dataDir: { path: '/data', size: 734003200, files: 67, sizeFormatted: '700 MB' },
  },

  forecast: {
    location: { lat: 37.77, lon: -122.42, timezone: 'America/Los_Angeles' },
    moon: { phase: 0.25, illumination: 0.5, rise: '2024-03-15T20:00:00Z', set: '2024-03-16T06:00:00Z' },
    tonight: {
      score: 85,
      label: 'Great',
      clouds: 10,
      seeing: 3,
      wind: 5,
      humidity: 40,
      transparency: 8,
    },
    hourly: Array.from({ length: 12 }, (_, i) => ({
      time: new Date(Date.now() + i * 3600 * 1000).toISOString(),
      clouds: 10 + i * 2,
      seeing: 3,
      wind: 5,
      humidity: 40,
      temperature: 15 - i * 0.5,
      precipitation: 0,
    })),
  },

  connectionTest: {
    connected: true,
    objectCount: 15,
    error: null,
  },

  connectionTestFailed: {
    connected: false,
    objectCount: 0,
    error: 'Connection refused: no route to host',
  },

  note: {
    id: 'note-1',
    objectId: 'M42',
    date: '2024-03-15',
    bortleClass: 5,
    seeingRating: 3,
    transparencyRating: 4,
    moonPhase: 'waxing crescent',
    moonIllumination: 0.2,
    equipment: 'Seestar S50',
    notes: 'Good session, nice transparency.',
    rating: 4,
    location: 'Backyard',
    createdAt: '2024-03-15T23:00:00Z',
    updatedAt: '2024-03-15T23:00:00Z',
  },

  telescopes: [
    { id: 'scope-1', name: 'Seestar S50', model: 'S50', hostname: '192.168.1.100', isActive: true },
  ],

  telescopeStatus: {
    configured: true,
    hostname: '192.168.1.100',
    online: false,
    latencyMs: null,
    checkedAt: null,
  },

  allTelescopeStatusList: [
    {
      id: 'scope-1',
      name: 'Seestar S50',
      color: '#22c55e',
      kind: 'seestar',
      hostname: '192.168.1.100',
      configured: true,
      online: false,
      latencyMs: null,
      checkedAt: null,
      transportKind: 'smb' as const,
    },
  ],

  importHistory: {
    entries: [
      {
        id: 1,
        startedAt: '2024-03-15T22:00:00Z',
        finishedAt: '2024-03-15T23:00:00Z',
        objectsTotal: 2,
        filesTotal: 20,
        newFiles: 18,
        bytesTotal: 524288000,
        bytesNew: 471859200,
        error: null,
        files: null,
        telescopeId: 'scope-1',
        telescopeName: 'Seestar S50',
        transportKind: 'smb' as const,
      },
    ],
    total: 1,
  },

  libraryImages: [
    {
      name: 'M42_2024-03-15.jpg',
      path: '/data/library/M42/2024-03-15/M42_2024-03-15.jpg',
      date: '2024-03-15',
      objectId: 'M42',
      objectName: 'Orion Nebula',
      objectType: 'Emission Nebula',
      distanceLy: 1344,
      downloadUrl: '/api/library/file?path=/data/library/M42/2024-03-15/M42_2024-03-15.jpg',
      isFavorite: false,
    },
    {
      name: 'M31_2024-02-20.jpg',
      path: '/data/library/M31/2024-02-20/M31_2024-02-20.jpg',
      date: '2024-02-20',
      objectId: 'M31',
      objectName: 'Andromeda Galaxy',
      objectType: 'Galaxy',
      distanceLy: 2537000,
      downloadUrl: '/api/library/file?path=/data/library/M31/2024-02-20/M31_2024-02-20.jpg',
      isFavorite: true,
    },
  ],

  dsoSearchResults: [
    {
      id: 'M63',
      name: 'Sunflower Galaxy',
      type: 'Galaxy',
      constellation: 'Canes Venatici',
      magnitude: 8.6,
      ra: '13h 15m 49s',
      dec: '+42° 01′ 45″',
    },
  ],
};

// ─── Route matchers ───────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Parameters<Route['fulfill']>[0] {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}

/**
 * Register all API mocks. Call in beforeEach or at the start of each test.
 */
export async function mockAllRoutes(page: Page) {
  // Auth
  await page.route('**/api/auth/status', r => r.fulfill(json(ok(MOCK.authStatus))));
  await page.route('**/api/auth/login', r => r.fulfill(json(ok(MOCK.loginResponse))));
  await page.route('**/api/auth/me', r => r.fulfill(json(ok(MOCK.loginResponse.user))));
  await page.route('**/api/auth/users', async r => {
    if (r.request().method() === 'POST') {
      r.fulfill(json(ok([...MOCK.users, { id: 'new-user', username: 'newuser', displayName: 'New User', email: 'new@example.com', createdAt: new Date().toISOString() }])));
    } else {
      r.fulfill(json(ok(MOCK.users)));
    }
  });
  await page.route('**/api/auth/users/**', async r => {
    const method = r.request().method();
    if (method === 'DELETE') {
      r.fulfill(json(ok(MOCK.users.slice(0, 1))));
    } else if (method === 'PUT') {
      r.fulfill(json(ok({ updated: true })));
    } else {
      r.fulfill(json(ok(MOCK.users)));
    }
  });

  // Settings
  await page.route('**/api/settings', async r => {
    if (r.request().method() === 'PUT') {
      r.fulfill(json(ok(MOCK.settings)));
    } else {
      r.fulfill(json(ok(MOCK.settings)));
    }
  });
  await page.route('**/api/settings/generate-api-key', r =>
    r.fulfill(json(ok({ ...MOCK.settings, apiKey: 'new-api-key-123', hasApiKey: true }))));
  await page.route('**/api/settings/api-key', r =>
    r.fulfill(json(ok({ ...MOCK.settings, apiKey: '', hasApiKey: false }))));

  // Library objects. Registered least-specific first so the specific endpoints
  // win (Playwright runs the most recently registered matching handler first).
  // Otherwise the `objects/**` catch-all would intercept the sessions/files
  // endpoints and return a single object instead.
  await page.route('**/api/library/objects', r => r.fulfill(json(ok(MOCK.objects))));
  await page.route('**/api/library/objects/**', r => r.fulfill(json(ok(MOCK.objects[0]))));
  await page.route('**/api/library/objects/*/favorite', r => r.fulfill(json(ok({ objectId: 'M42', isFavorite: true }))));
  await page.route('**/api/library/objects/M31/sessions', r =>
    r.fulfill(json(ok([MOCK.sessions[0]]))));
  await page.route('**/api/library/objects/M42/integration', r =>
    r.fulfill(json(ok({ totalExposure: 600, stackedFrames: 120, sessions: 3 }))));
  await page.route('**/api/library/objects/M42/sessions', r => r.fulfill(json(ok(MOCK.sessions))));
  await page.route('**/api/library/objects/M42/sessions/2024-03-15/files', r =>
    r.fulfill(json(ok(MOCK.sessionFiles))));

  // Import
  await page.route('**/api/library/import/history**', r => r.fulfill(json(ok(MOCK.importHistory))));
  await page.route('**/api/library/import/status', r => r.fulfill(json(ok(MOCK.importStatus))));
  await page.route('**/api/library/import', async r => {
    if (r.request().method() === 'POST') {
      r.fulfill(json(ok({ started: true, objectId: null })));
    } else {
      r.fulfill(json(ok(MOCK.importStatus)));
    }
  });

  // Library images (photo gallery)
  await page.route('**/api/library/all-images**', r =>
    r.fulfill(json(ok({ items: MOCK.libraryImages, total: MOCK.libraryImages.length, nextOffset: null }))));
  await page.route('**/api/library/images/favorite**', r =>
    r.fulfill(json(ok({ ...MOCK.libraryImages[0], isFavorite: true }))));

  // Observations
  await page.route('**/api/library/observations', r => r.fulfill(json(ok(MOCK.observations))));
  await page.route('**/api/library/observations/**', r => r.fulfill(json(ok(MOCK.observationDetail))));

  // Catalog. Registered least-specific first so the specific endpoints win
  // (Playwright runs the most recently registered matching handler first).
  // Otherwise the `**/api/catalog/**` catch-all would intercept `/M42/info`
  // and `/M42/image` and return the plain catalog entry.
  await page.route('**/api/catalog', r => r.fulfill(json(ok([MOCK.catalogEntry]))));
  await page.route('**/api/catalog/**', r => r.fulfill(json(ok(MOCK.catalogEntry))));
  await page.route('**/api/catalog/search**', r => r.fulfill(json(ok(MOCK.dsoSearchResults))));
  await page.route('**/api/catalog/M42', r => r.fulfill(json(ok(MOCK.catalogEntry))));
  await page.route('**/api/catalog/M42/image**', r =>
    r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('') }));
  await page.route('**/api/catalog/M42/info', r =>
    r.fulfill(json(ok({ ...MOCK.catalogEntry, wikiSummary: 'The Orion Nebula (also known as Messier 42) is a diffuse nebula.' }))));

  // Notes. Least-specific first so specific endpoints win (Playwright runs the
  // most recently registered matching handler first).
  await page.route('**/api/notes/**', async r => {
    if (r.request().method() === 'DELETE') {
      r.fulfill(json(ok({ deleted: true })));
    } else if (r.request().method() === 'PUT') {
      r.fulfill(json(ok(MOCK.note)));
    } else {
      r.fulfill(json(ok(MOCK.note)));
    }
  });
  await page.route('**/api/notes', async r => {
    if (r.request().method() === 'POST') {
      r.fulfill(json(ok(MOCK.note)));
    } else {
      r.fulfill(json(ok([MOCK.note])));
    }
  });
  await page.route('**/api/notes/object/**', r => r.fulfill(json(ok(MOCK.note))));
  await page.route('**/api/notes/object/M42/2024-03-15', r => r.fulfill(json(ok(MOCK.note))));

  // Wishlist. Least-specific first so specific endpoints win.
  await page.route('**/api/wishlist/**', async r => {
    const method = r.request().method();
    if (method === 'PATCH') {
      r.fulfill(json(ok({ ...MOCK.wishlist[0], priority: 'low' })));
    } else if (method === 'DELETE') {
      r.fulfill(json(ok({ deleted: true })));
    } else {
      r.fulfill(json(ok(MOCK.wishlist[0])));
    }
  });
  await page.route('**/api/wishlist/object/**', r => r.fulfill(json(ok({ deleted: true }))));
  await page.route('**/api/wishlist', async r => {
    if (r.request().method() === 'POST') {
      r.fulfill(json(ok([...MOCK.wishlist, { id: 'wl-new', objectId: 'M63', objectName: 'Sunflower Galaxy', catalogId: 'M63', type: 'Galaxy', constellation: 'Canes Venatici', magnitude: 8.6, priority: 'medium' as const, notes: '', addedAt: new Date().toISOString() }])));
    } else {
      r.fulfill(json(ok(MOCK.wishlist)));
    }
  });

  // Planner. The night-window and timeline fields are anchored to "now" so the
  // dusk-to-dawn timeline always renders regardless of when the suite runs.
  await page.route('**/api/planner/tonight**', r => {
    const now = Date.now();
    const iso = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
    r.fulfill(json(ok({
      locationSet: true,
      targets: MOCK.plannerTargets,
      totalVisible: MOCK.plannerTargets.length,
      nightStart: iso(-1),
      nightEnd: iso(8),
      sunset: iso(-2),
      sunrise: iso(9),
      timelineStart: iso(-2),
      timelineEnd: iso(9),
      moonIllumination: 42,
      moonPhase: 'Waxing Crescent',
      observerLat: 37.77,
      observerLon: -122.42,
      observerTimezone: 'America/Los_Angeles',
    })));
  });
  await page.route('**/api/planner/curve/**', r => r.fulfill(json(ok(MOCK.altitudeCurve))));
  await page.route('**/api/planned-sessions**', r => {
    if (r.request().method() === 'GET') r.fulfill(json(ok([])));
    else r.fulfill(json(ok({ id: 1 })));
  });

  // DSO catalog. The browse/search endpoint (GET /dso?q=) drives both wishlist
  // search and the planner's below-horizon backfill, so match the query against
  // the observable targets plus the below-horizon entry.
  await page.route('**/api/dso**', r => {
    const url = new URL(r.request().url());
    const q = (url.searchParams.get('q') ?? '').toLowerCase().replace(/\s+/g, '');
    const catalog = [...MOCK.plannerTargets, MOCK.dsoBelowHorizon];
    const matches = (e: { id: string; ngcName: string; name: string; commonNames: string[] }) =>
      [e.id, e.ngcName, e.name, ...e.commonNames].some(f => (f ?? '').toLowerCase().replace(/\s+/g, '').includes(q));
    const results = q ? catalog.filter(matches) : catalog;
    r.fulfill(json(ok({ results, total: results.length })));
  });

  // Storage
  await page.route('**/api/storage/system', r => r.fulfill(json(ok(MOCK.systemStorage))));
  await page.route('**/api/storage', r => r.fulfill(json(ok(MOCK.storageStats))));

  // Forecast
  await page.route('**/api/forecast**', r => r.fulfill(json(ok(MOCK.forecast))));

  // Telescopes. Playwright checks routes in reverse registration order (the
  // most recently added handler that matches wins), so register from least to
  // most specific: the catch-all first, the exact endpoints last. Otherwise the
  // `**/api/telescopes/**` catch-all would intercept `/status/all` and return a
  // single telescope object, breaking `allStatus.filter` in the Layout shell.
  await page.route('**/api/telescopes/**', r => r.fulfill(json(ok(MOCK.telescopes[0]))));
  await page.route('**/api/telescopes', r => r.fulfill(json(ok(MOCK.telescopes))));
  await page.route('**/api/telescopes/active', r => r.fulfill(json(ok(MOCK.telescopes[0]))));
  await page.route('**/api/telescopes/status', r => r.fulfill(json(ok(MOCK.telescopeStatus))));
  await page.route('**/api/telescopes/status/all', r => r.fulfill(json(ok(MOCK.allTelescopeStatusList))));

  // SMB connection test
  await page.route('**/api/telescope/test', r => r.fulfill(json(ok(MOCK.connectionTest))));

  // Thumbnails — return a tiny blank PNG
  await page.route('**/thumbnail**', r =>
    r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('') }));
  await page.route('**/*.jpg', r =>
    r.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from('') }));

  // Health
  await page.route('**/api/health', r =>
    r.fulfill(json(ok({ status: 'healthy', version: '1.0.0', uptime: 3600, timestamp: new Date().toISOString(), telescopeOnline: false }))));

  // Satellite
  await page.route('**/api/satellite/catalog/status', r =>
    r.fulfill(json(ok({ loaded: true, count: 15000, updatedAt: '2024-03-15T12:00:00Z' }))));
}

/**
 * Override a single route with different data (e.g. for error-state tests).
 */
export async function mockRoute(page: Page, pattern: string, data: unknown, status = 200) {
  await page.route(pattern, r => r.fulfill(json(ok(data), status)));
}

export async function mockRouteError(page: Page, pattern: string, message: string, status = 500) {
  await page.route(pattern, r =>
    r.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'ERROR', message } }),
    }));
}

/**
 * Set up a viewer session: places a fake token in localStorage so AuthContext
 * calls /api/auth/me, then overrides that endpoint to return a viewer user.
 *
 * Call BEFORE page.goto().
 */
export async function mockViewerAuth(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('nebulis_auth_token', 'viewer-test-token');
  });
  await page.route('**/api/auth/me', r => r.fulfill(json(ok(MOCK.viewerUser))));
}

/**
 * Set up an explicit admin session.
 * The default (no token in localStorage) already resolves to admin, but use this
 * when you need to explicitly assert the admin path through /api/auth/me.
 *
 * Call BEFORE page.goto().
 */
export async function mockAdminAuth(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('nebulis_auth_token', 'admin-test-token');
  });
  await page.route('**/api/auth/me', r => r.fulfill(json(ok(MOCK.loginResponse.user))));
}

/**
 * Override auth/status to return hasUsers=false (open-access, no login gate).
 * Use when tests need a clean no-login state without worrying about the login
 * modal appearing once the auth status query resolves.
 *
 * Call BEFORE page.goto() (or before mockAllRoutes to take precedence).
 */
export async function mockOpenAuth(page: Page) {
  await page.route('**/api/auth/status', r =>
    r.fulfill(json(ok({ hasUsers: false, requiresSetup: false }))));
}

/**
 * Override auth/status to return hasUsers=true. With no stored token this makes
 * App.tsx show the login modal, so the auth-gate specs can exercise it.
 *
 * Call AFTER mockAllRoutes so this route registration takes precedence
 * (Playwright runs the most recently registered matching handler first).
 */
export async function mockHasUsers(page: Page) {
  await page.route('**/api/auth/status', r =>
    r.fulfill(json(ok({ hasUsers: true, requiresSetup: false }))));
}
