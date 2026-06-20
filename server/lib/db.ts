/**
 * SQLite database connection and initialization.
 * Single source of truth for the database — import `db` from here everywhere.
 *
 * Schema creation runs inline so that tables exist before any other module
 * tries to prepare statements (ES module imports are hoisted).
 */
import Database from 'better-sqlite3';
import path from 'path';
import { DATA_DIR } from './paths.js';
import { encrypt as encryptSecret, decrypt as decryptSecret } from './crypto/secretBox.js';

const DB_PATH = path.join(DATA_DIR, 'nebulis.db');

// When running as a pkg-bundled exe, load the prebuilt native binding from
// alongside the exe (better_sqlite3.node is copied there by the build script).
// `pkg` injects a `process.pkg` flag at runtime; the `in` guard narrows
// without a cast.
const isPkgBundled = 'pkg' in process;
const nativeBinding = isPkgBundled
  ? path.join(path.dirname(process.execPath), 'better_sqlite3.node')
  : undefined;

const db = new Database(DB_PATH, nativeBinding ? { nativeBinding } : undefined);

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ─── Schema creation (runs on first import) ─────────────────────────────────
// NOTE: db.exec() here is safe — it runs static DDL with no user input.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email        TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
    passwordHash TEXT NOT NULL,
    displayName  TEXT NOT NULL,
    createdAt    TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'admin'
  );

  -- Legacy JSON blob table (kept for migration; no longer written to)
  CREATE TABLE IF NOT EXISTS settings (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL DEFAULT '{}'
  );
  INSERT OR IGNORE INTO settings (id, data) VALUES (1, '{}');

  -- ─── App Settings (columnar, singleton) ───────────────────────
  CREATE TABLE IF NOT EXISTS appSettings (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    catalogSource       TEXT    NOT NULL DEFAULT 'builtin',
    customCatalogUrl    TEXT    NOT NULL DEFAULT '',
    apiKey              TEXT    NOT NULL DEFAULT '',
    latitude            REAL,
    longitude           REAL,
    locationName        TEXT    NOT NULL DEFAULT '',
    timezone            TEXT    NOT NULL DEFAULT '',
    minAlt              INTEGER NOT NULL DEFAULT 20,
    horizonProfile      TEXT    NOT NULL DEFAULT '[]',
    syncEnabled         INTEGER NOT NULL DEFAULT 1,
    syncJpg             INTEGER NOT NULL DEFAULT 1,
    syncFits            INTEGER NOT NULL DEFAULT 1,
    syncThumbnails      INTEGER NOT NULL DEFAULT 0,
    syncSubFrames       INTEGER NOT NULL DEFAULT 0,
    syncVideos          INTEGER NOT NULL DEFAULT 0,
    includeSubFrames    INTEGER NOT NULL DEFAULT 1,
    autoImport          INTEGER NOT NULL DEFAULT 0,
    autoImportInterval  INTEGER NOT NULL DEFAULT 60,
    importJpg           INTEGER NOT NULL DEFAULT 1,
    importFits          INTEGER NOT NULL DEFAULT 0,
    importThumbnails    INTEGER NOT NULL DEFAULT 0,
    importSubFrames     INTEGER NOT NULL DEFAULT 0,
    importVideos        INTEGER NOT NULL DEFAULT 0,
    onboardingCompleted INTEGER NOT NULL DEFAULT 0,
    prefetchCatalogAssets INTEGER NOT NULL DEFAULT 1,
    planetariumShowInfo INTEGER NOT NULL DEFAULT 1,
    galleryImageSource TEXT NOT NULL DEFAULT 'sky-survey',
    visibleSkyMap       TEXT    NOT NULL DEFAULT '[]',
    -- Absolute path to the relocated library directory. Empty = use the
    -- built-in default ({DATA_DIR}/library). See server/lib/libraryPath.ts.
    libraryPath         TEXT    NOT NULL DEFAULT '',
    -- Stable UUID written into the marker file at the library root so a
    -- reconnected drive can be matched to this install. Empty = not yet set.
    libraryId           TEXT    NOT NULL DEFAULT '',
    -- Desktop auto-update channel: 'stable' (default) or 'beta'. Selects which
    -- signed manifest the background updater polls. See server/lib/appUpdate/.
    updateChannel       TEXT    NOT NULL DEFAULT 'stable',
    -- Whether the background updater checks + pre-downloads automatically.
    -- OFF by default: the user must opt in. Manual "Check for updates" works
    -- regardless. Install is always an explicit click, never silent.
    autoUpdateEnabled   INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO appSettings (id) VALUES (1);

  -- ─── Catalog asset cache (pre-downloaded Wikipedia data) ───────
  -- Images live on disk in sky-cache/. This table only stores the
  -- lighter textual metadata fetched from Wikipedia.
  CREATE TABLE IF NOT EXISTS catalogCache (
    objectId   TEXT PRIMARY KEY,       -- 'M31', 'NGC7000', etc.
    extract    TEXT NOT NULL DEFAULT '', -- Wikipedia summary (1-3 sentences)
    wikiUrl    TEXT NOT NULL DEFAULT '', -- Canonical Wikipedia page URL
    source     TEXT NOT NULL DEFAULT 'wikipedia',
    fetchedAt  INTEGER NOT NULL,        -- Unix ms
    status     TEXT NOT NULL            -- 'ok' | 'not_found' | 'error'
  );

  -- ─── Catalog prefetch job status (single-row) ─────────────────
  CREATE TABLE IF NOT EXISTS catalogPrefetchStatus (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    running     INTEGER NOT NULL DEFAULT 0,
    phase       TEXT    NOT NULL DEFAULT 'idle',  -- idle|images|wikipedia|done|cancelled|error
    processed   INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    errors      INTEGER NOT NULL DEFAULT 0,
    startedAt   INTEGER,
    finishedAt  INTEGER,
    lastError   TEXT    NOT NULL DEFAULT ''
  );
  INSERT OR IGNORE INTO catalogPrefetchStatus (id) VALUES (1);

  -- ─── Installed catalog asset packs ────────────────────────────────
  CREATE TABLE IF NOT EXISTS catalogPackState (
    tier         TEXT PRIMARY KEY,    -- 'messier' | 'caldwell' | 'popular' | 'extended'
    version      TEXT    NOT NULL,
    installedAt  INTEGER NOT NULL,    -- Unix ms
    objectCount  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telescopeProfiles (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    model     TEXT NOT NULL DEFAULT 'SeeStar S50',
    hostname  TEXT NOT NULL DEFAULT '',
    shareName TEXT NOT NULL DEFAULT 'EMMC Images',
    username  TEXT NOT NULL DEFAULT 'guest',
    password  TEXT NOT NULL DEFAULT '',
    isActive  INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    kind              TEXT    NOT NULL DEFAULT 'other',
    color             TEXT    NOT NULL DEFAULT '#8b5cf6',
    autoImportEnabled INTEGER NOT NULL DEFAULT 1,
    archivedAt        INTEGER                              -- nullable; Unix ms set on archive
  );

  -- Per-import audit trail. Used for incremental dedup (telescopeId+remotePath)
  -- and for debugging "why did I get a duplicate" cases.
  CREATE TABLE IF NOT EXISTS sessionImportLog (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telescopeId TEXT NOT NULL,
    remotePath  TEXT NOT NULL,
    importedAt  TEXT NOT NULL,
    objectId    TEXT,
    sessionDate TEXT,
    outcome     TEXT NOT NULL,
    message     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessionImportLog_telescope_path
    ON sessionImportLog(telescopeId, remotePath);

  -- One profile can carry multiple transports (e.g. one Seestar reachable via
  -- both SMB and USB). Active transport is picked at run time by
  -- selectActiveTransport(): local mount present wins over SMB reachable;
  -- tiebreak by priority asc, then lastSeenAt desc.
  CREATE TABLE IF NOT EXISTS telescopeTransports (
    id          TEXT PRIMARY KEY,
    profileId   TEXT NOT NULL REFERENCES telescopeProfiles(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,                          -- 'smb' | 'local'
    priority    INTEGER NOT NULL DEFAULT 100,
    hostname    TEXT NOT NULL DEFAULT '',
    shareName   TEXT NOT NULL DEFAULT 'EMMC Images',
    username    TEXT NOT NULL DEFAULT 'guest',
    password    TEXT NOT NULL DEFAULT '',               -- encrypted via secretBox
    localPath   TEXT NOT NULL DEFAULT '',
    lastSeenAt  INTEGER,
    createdAt   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_telescopeTransports_profile
    ON telescopeTransports(profileId);

  CREATE TABLE IF NOT EXISTS notes (
    id                  TEXT PRIMARY KEY,
    objectId            TEXT NOT NULL,
    date                TEXT NOT NULL,
    bortleClass         INTEGER,
    seeingRating        INTEGER,
    transparencyRating  INTEGER,
    moonPhase           TEXT,
    moonIllumination    INTEGER,
    equipment           TEXT NOT NULL DEFAULT '',
    notes               TEXT NOT NULL DEFAULT '',
    rating              INTEGER,
    location            TEXT NOT NULL DEFAULT '',
    createdAt           TEXT NOT NULL,
    updatedAt           TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notes_objectId ON notes(objectId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_objectId_date ON notes(objectId, date);

  CREATE TABLE IF NOT EXISTS wishlist (
    id               TEXT PRIMARY KEY,
    objectId         TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    type             TEXT NOT NULL DEFAULT '',
    constellation    TEXT,
    magnitude        REAL,
    majorAxisArcmin  REAL,
    priority         TEXT NOT NULL DEFAULT 'medium',
    notes            TEXT NOT NULL DEFAULT '',
    addedAt          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS libraryObjects (
    objectId      TEXT PRIMARY KEY,
    folderName    TEXT NOT NULL,
    fileCount     INTEGER NOT NULL DEFAULT 0,
    lastImport    TEXT NOT NULL,
    deleted       INTEGER NOT NULL DEFAULT 0,
    deletedAt     TEXT,
    galleryImage  TEXT,
    catalogId     TEXT,
    objectName    TEXT,
    objectType    TEXT,
    constellation TEXT,
    description   TEXT,
    magnitude     REAL,
    ra            TEXT,
    dec           TEXT,
    distanceLy    REAL,
    wikiUrl       TEXT,
    sizeArcmin    TEXT,
    primaryTelescopeId TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_libraryObjects_deleted ON libraryObjects(deleted);

  CREATE TABLE IF NOT EXISTS librarySessions (
    objectId TEXT NOT NULL REFERENCES libraryObjects(objectId) ON DELETE CASCADE,
    date     TEXT NOT NULL,
    telescopeId TEXT,
    PRIMARY KEY (objectId, date)
  );
  -- Note: idx_librarySessions_telescope is created after the column migration
  -- runs, since legacy databases reach this block before telescopeId exists.

  CREATE TABLE IF NOT EXISTS libraryDeletedSessions (
    objectId TEXT NOT NULL REFERENCES libraryObjects(objectId) ON DELETE CASCADE,
    date     TEXT NOT NULL,
    PRIMARY KEY (objectId, date)
  );

  CREATE TABLE IF NOT EXISTS libraryMeta (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    version   INTEGER NOT NULL DEFAULT 1,
    lastImport TEXT
  );
  INSERT OR IGNORE INTO libraryMeta (id, version) VALUES (1, 1);

  CREATE TABLE IF NOT EXISTS favorites (
    objectId TEXT NOT NULL,
    userId   TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (objectId, userId)
  );

  CREATE TABLE IF NOT EXISTS imageFavorites (
    imagePath TEXT NOT NULL,
    userId    TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (imagePath, userId)
  );

  -- ─── TV / device pairing (RFC 8628 device-grant style) ────────
  -- Short-lived. Rows expire after 10 minutes; lazily ignored once
  -- past expiresAt and swept on each /pair/start call.
  CREATE TABLE IF NOT EXISTS devicePairings (
    userCode    TEXT PRIMARY KEY,        -- 8-char unambiguous, displayed on TV
    deviceCode  TEXT NOT NULL UNIQUE,    -- 32-char secret, polled by TV
    tvName      TEXT NOT NULL DEFAULT 'TV',
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|consumed
    userId      TEXT,                    -- set once a user approves the code
    createdAt   INTEGER NOT NULL,        -- Unix ms
    expiresAt   INTEGER NOT NULL         -- Unix ms
  );

  -- ─── Long-lived connected devices (paired TVs etc.) ──────────
  -- One row per active device. JWT issued at pair time carries jti=id;
  -- auth middleware rejects tokens whose row is missing or revokedAt is set.
  CREATE TABLE IF NOT EXISTS connectedDevices (
    id          TEXT PRIMARY KEY,         -- uuid; also the JWT jti
    userId      TEXT NOT NULL,
    name        TEXT NOT NULL,
    createdAt   INTEGER NOT NULL,
    lastSeenAt  INTEGER NOT NULL,
    revokedAt   INTEGER                   -- nullable; set on user revoke
  );
  CREATE INDEX IF NOT EXISTS idx_connectedDevices_user ON connectedDevices(userId);

  -- ─── User overrides for catalog metadata ─────────────────────
  -- Per-field override layered on top of the static catalog + library DB.
  -- NULL on a column means "no override for this field" — falls through to
  -- the normal source. Non-NULL wins. objectId is the normalized key
  -- (uppercased, whitespace stripped) matching getCatalogEntry's lookup key.
  CREATE TABLE IF NOT EXISTS catalogOverrides (
    objectId      TEXT PRIMARY KEY,
    name          TEXT,
    type          TEXT,
    constellation TEXT,
    magnitude     REAL,
    description   TEXT,
    ra            TEXT,
    dec           TEXT,
    distanceLy    REAL,
    updatedAt     INTEGER NOT NULL,
    updatedBy     TEXT
  );

  CREATE TABLE IF NOT EXISTS userPreferences (
    userId             TEXT PRIMARY KEY,
    watermarkPresets   TEXT NOT NULL DEFAULT '[]',
    updatedAt          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ─── Planned imaging sessions (planner v2) ───────────────────
  -- One row per scheduled block on the planner timeline. ra/dec are
  -- denormalized so a catalog rename does not orphan a plan. start_time
  -- and end_time are ISO 8601 UTC.
  CREATE TABLE IF NOT EXISTS plannedSessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    objectId    TEXT NOT NULL,
    objectName  TEXT NOT NULL,
    ra          REAL NOT NULL,
    dec         REAL NOT NULL,
    startTime   TEXT NOT NULL,
    endTime     TEXT NOT NULL,
    notes       TEXT NOT NULL DEFAULT '',
    createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_plannedSessions_start ON plannedSessions(startTime);
`);

// ─── Column migrations for existing databases ────────────────────────────────
{
  // Add role column to users — existing users default to 'admin' so they retain
  // full access after the migration.
  const userColsStmt = db.prepare<[], { name: string }>('PRAGMA table_info(users)');
  const userCols = userColsStmt.all();
  if (!userCols.some(c => c.name === 'role')) {
    db.prepare("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'").run();
  }
}
{
  // PRAGMA table_info returns rows with at least { name: string }. SQL trust
  // boundary: SQLite's PRAGMA shape is documented and stable.
  const colsStmt = db.prepare<[], { name: string }>('PRAGMA table_info(appSettings)');
  const cols = colsStmt.all();
  if (!cols.some(c => c.name === 'onboardingCompleted')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN onboardingCompleted INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!cols.some(c => c.name === 'prefetchCatalogAssets')) {
    // Existing installs default to 0 (off) so nothing suddenly starts a large
    // background download. Fresh installs use the CREATE TABLE default of 1.
    db.prepare('ALTER TABLE appSettings ADD COLUMN prefetchCatalogAssets INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!cols.some(c => c.name === 'planetariumShowInfo')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN planetariumShowInfo INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!cols.some(c => c.name === 'galleryImageSource')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN galleryImageSource TEXT NOT NULL DEFAULT 'sky-survey'").run();
  }
  if (!cols.some(c => c.name === 'slideshowRotateCCW')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN slideshowRotateCCW INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!cols.some(c => c.name === 'temperatureUnit')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN temperatureUnit TEXT NOT NULL DEFAULT 'fahrenheit'").run();
  }
  if (!cols.some(c => c.name === 'locationName')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN locationName TEXT NOT NULL DEFAULT ''").run();
  }
  if (!cols.some(c => c.name === 'visibleSkyMap')) {
    // 144-element boolean array (36 azimuth slices × 4 elevation bands),
    // serialized as JSON. Default '[]' means "no map set yet — treat whole
    // sky as visible." The planner UI flips that into a length-144 array
    // when the user opens the Set Visible Sky editor.
    db.prepare("ALTER TABLE appSettings ADD COLUMN visibleSkyMap TEXT NOT NULL DEFAULT '[]'").run();
  }
  if (!cols.some(c => c.name === 'libraryPath')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN libraryPath TEXT NOT NULL DEFAULT ''").run();
  }
  if (!cols.some(c => c.name === 'libraryId')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN libraryId TEXT NOT NULL DEFAULT ''").run();
  }
  if (!cols.some(c => c.name === 'updateChannel')) {
    // Existing installs join the stable channel; opt into beta from Settings.
    db.prepare("ALTER TABLE appSettings ADD COLUMN updateChannel TEXT NOT NULL DEFAULT 'stable'").run();
  }
  if (!cols.some(c => c.name === 'autoUpdateEnabled')) {
    // OFF by default for new and existing installs — the user opts in.
    db.prepare('ALTER TABLE appSettings ADD COLUMN autoUpdateEnabled INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!cols.some(c => c.name === 'plannerPrefetchEnabled')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN plannerPrefetchEnabled INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!cols.some(c => c.name === 'plannerPrefetchTime')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN plannerPrefetchTime TEXT NOT NULL DEFAULT '03:00'").run();
  }
  if (!cols.some(c => c.name === 'plannerPrefetchLastRun')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN plannerPrefetchLastRun INTEGER').run();
  }
  if (!cols.some(c => c.name === 'nightlyCatalogPackCheckEnabled')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN nightlyCatalogPackCheckEnabled INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!cols.some(c => c.name === 'nightlyHousekeepingEnabled')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN nightlyHousekeepingEnabled INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!cols.some(c => c.name === 'nightlyForecastPrefetchEnabled')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN nightlyForecastPrefetchEnabled INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!cols.some(c => c.name === 'nightlyHousekeepingLastRun')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN nightlyHousekeepingLastRun INTEGER').run();
  }
  if (!cols.some(c => c.name === 'nightlyForecastLastRun')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN nightlyForecastLastRun INTEGER').run();
  }
}

// ─── Multi-telescope columns (added in Phase 1 of multi-telescope-support) ──
// telescopeProfiles: kind / color / autoImportEnabled
// librarySessions:   telescopeId (which scope captured this session)
// libraryObjects:    primaryTelescopeId (computed from session counts at backfill)
{
  const tpCols = db.prepare<[], { name: string }>('PRAGMA table_info(telescopeProfiles)').all();
  if (!tpCols.some(c => c.name === 'kind')) {
    db.prepare("ALTER TABLE telescopeProfiles ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'").run();
  }
  if (!tpCols.some(c => c.name === 'color')) {
    db.prepare("ALTER TABLE telescopeProfiles ADD COLUMN color TEXT NOT NULL DEFAULT '#8b5cf6'").run();
  }
  if (!tpCols.some(c => c.name === 'autoImportEnabled')) {
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN autoImportEnabled INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!tpCols.some(c => c.name === 'archivedAt')) {
    // Unix ms timestamp, NULL = active. Lets users retire a scope without
    // breaking historical session attribution. Active pickers (auto-import,
    // discovery defaults) filter on `archivedAt IS NULL`; the per-session
    // reassign target picker also filters it out so users don't accidentally
    // move sessions to a retired scope.
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN archivedAt INTEGER').run();
  }
  if (!tpCols.some(c => c.name === 'autoImportInterval')) {
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN autoImportInterval INTEGER NOT NULL DEFAULT 60').run();
  }
  if (!tpCols.some(c => c.name === 'connectionType')) {
    // 'smb' (default, SeeStar) or 'local' (Dwarf USB mount). Decides which
    // I/O path smb.ts dispatches to for this profile. Existing rows stay on
    // SMB without intervention.
    db.prepare("ALTER TABLE telescopeProfiles ADD COLUMN connectionType TEXT NOT NULL DEFAULT 'smb'").run();
  }
  if (!tpCols.some(c => c.name === 'localPath')) {
    // Absolute filesystem path to the device's storage root (e.g.
    // /Volumes/DWARF_3 on macOS, D:\ on Windows). Only meaningful when
    // connectionType = 'local'. Empty string for SMB profiles.
    db.prepare("ALTER TABLE telescopeProfiles ADD COLUMN localPath TEXT NOT NULL DEFAULT ''").run();
  }

  // Per-telescope file-type filters. Each profile carries its own preferences
  // about what to pull — a Seestar with a big eMMC might import everything;
  // a Dwarf on a small disk might skip subframes. Defaults match the previous
  // global `appSettings` shape so new rows behave like the legacy global setup.
  if (!tpCols.some(c => c.name === 'importJpg')) {
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN importJpg INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!tpCols.some(c => c.name === 'importFits')) {
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN importFits INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!tpCols.some(c => c.name === 'importThumbnails')) {
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN importThumbnails INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!tpCols.some(c => c.name === 'importSubFrames')) {
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN importSubFrames INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!tpCols.some(c => c.name === 'importVideos')) {
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN importVideos INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!tpCols.some(c => c.name === 'trackDeviceIdentity')) {
    // When 1 (default), the import pipeline reads/writes `.nebulis.dat` on
    // the device's storage root so we can recognise the same physical
    // telescope reached over both SMB and USB. Power users can opt out — e.g.
    // firmware that rejects unknown files at the share root, or simply not
    // wanting us to write to the device.
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN trackDeviceIdentity INTEGER NOT NULL DEFAULT 1').run();
  }

  // Per-user release-notes dismissal. NULL means "never acknowledged" —
  // first login shows the popup with whatever is current in /meta/version.
  // Updated to the current app version whenever the user clicks "Got it".
  const upCols = db.prepare<[], { name: string }>('PRAGMA table_info(userPreferences)').all();
  if (!upCols.some(c => c.name === 'lastSeenVersion')) {
    db.prepare('ALTER TABLE userPreferences ADD COLUMN lastSeenVersion TEXT').run();
  }

  const lsCols = db.prepare<[], { name: string }>('PRAGMA table_info(librarySessions)').all();
  if (!lsCols.some(c => c.name === 'telescopeId')) {
    db.prepare('ALTER TABLE librarySessions ADD COLUMN telescopeId TEXT').run();
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_librarySessions_telescope ON librarySessions(telescopeId)').run();

  // Audit 4 (indexes): `getAllFavorites` filters by userId; the table's
  // primary key is (objectId, userId) which doesn't help. Same shape for
  // `getAllImageFavorites`. Both queries fire on every /library/objects load.
  db.prepare('CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(userId)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_imageFavorites_user ON imageFavorites(userId)').run();

  const loCols = db.prepare<[], { name: string }>('PRAGMA table_info(libraryObjects)').all();
  if (!loCols.some(c => c.name === 'primaryTelescopeId')) {
    db.prepare('ALTER TABLE libraryObjects ADD COLUMN primaryTelescopeId TEXT').run();
  }
}

// ─── Device identity + transport unification ────────────────────────────────
// telescopeProfiles.deviceId: UUID generated on first connection, stored in
// the device's `.nebulis.dat` file. Lets us recognise the same physical
// telescope reached via different transports (SMB + USB) and merge them.
// sessionImportLog.deviceId: stamped on import so dedup keys are
// transport-agnostic: `(deviceId, remotePath)` is unique per file regardless
// of whether it came in over SMB or USB.
{
  const tpCols2 = db.prepare<[], { name: string }>('PRAGMA table_info(telescopeProfiles)').all();
  if (!tpCols2.some(c => c.name === 'deviceId')) {
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN deviceId TEXT').run();
  }
  // Unique only when non-null. NULL profiles (never connected yet) don't collide.
  db.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_telescopeProfiles_deviceId
       ON telescopeProfiles(deviceId) WHERE deviceId IS NOT NULL`,
  ).run();

  const silCols = db.prepare<[], { name: string }>('PRAGMA table_info(sessionImportLog)').all();
  if (!silCols.some(c => c.name === 'deviceId')) {
    db.prepare('ALTER TABLE sessionImportLog ADD COLUMN deviceId TEXT').run();
  }
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_sessionImportLog_device_path
       ON sessionImportLog(deviceId, remotePath)`,
  ).run();
}

// ─── Backfill per-telescope import file-type toggles from global appSettings ─
// Existing profiles inherit whatever the user had set as their global file-type
// preferences so the auto-import scheduler keeps importing the same files.
// New profiles fall back to the CREATE TABLE defaults (JPG+thumbnails on,
// everything else off). Idempotent: gated by a one-shot column on libraryMeta
// so reboots don't clobber later per-profile edits.
{
  const lmCols = db.prepare<[], { name: string }>('PRAGMA table_info(libraryMeta)').all();
  if (!lmCols.some(c => c.name === 'perTelescopeImportBackfilled')) {
    db.prepare('ALTER TABLE libraryMeta ADD COLUMN perTelescopeImportBackfilled INTEGER NOT NULL DEFAULT 0').run();
    const settings = db
      .prepare<[], {
        importJpg: number;
        importFits: number;
        importThumbnails: number;
        importSubFrames: number;
        importVideos: number;
      }>(
        'SELECT importJpg, importFits, importThumbnails, importSubFrames, importVideos FROM appSettings WHERE id = 1',
      )
      .get();
    if (settings) {
      db.prepare(
        `UPDATE telescopeProfiles SET
           importJpg = ?, importFits = ?, importThumbnails = ?,
           importSubFrames = ?, importVideos = ?`,
      ).run(
        settings.importJpg, settings.importFits, settings.importThumbnails,
        settings.importSubFrames, settings.importVideos,
      );
    }
    db.prepare('UPDATE libraryMeta SET perTelescopeImportBackfilled = 1 WHERE id = 1').run();
  }
}

// ─── Backfill telescopeTransports from legacy single-transport columns ──────
// Each existing telescopeProfile gets one transport row mirroring its current
// connectionType / hostname / shareName / username / password / localPath.
// Idempotent: profiles that already have a transport row are skipped.
// Passwords are encrypted via secretBox before insertion so rowToTransport can
// decrypt them. The raw SQL copy that preceded this code skipped encryption,
// which caused decrypt() to throw and fall back to '' on existing databases.
{
  const profilesWithoutTransport = db
    .prepare<[], { id: string; connectionType: string; hostname: string; shareName: string; username: string; password: string; localPath: string; createdAt: string }>(
      `SELECT id, connectionType, hostname, shareName, username, password, localPath, createdAt
         FROM telescopeProfiles
        WHERE NOT EXISTS (
          SELECT 1 FROM telescopeTransports t WHERE t.profileId = telescopeProfiles.id
        )`,
    )
    .all();

  const insertTransport = db.prepare(
    `INSERT INTO telescopeTransports
       (id, profileId, kind, priority, hostname, shareName, username, password,
        localPath, createdAt)
     VALUES (lower(hex(randomblob(16))), ?, ?, 100, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of profilesWithoutTransport) {
    // Encrypt only if not already an encrypted blob (3-part secretBox format).
    // Profiles written before encryption was introduced store plaintext here.
    const parts = row.password.split('.');
    const encryptedPw = parts.length === 3
      ? row.password
      : row.password ? encryptSecret(row.password) : '';

    insertTransport.run(
      row.id, row.connectionType, row.hostname, row.shareName,
      row.username, encryptedPw, row.localPath, row.createdAt,
    );
  }
}

// ─── Re-encrypt any plaintext passwords already in telescopeTransports ──────
// Profiles that ran the old raw-SQL backfill have plaintext passwords in the
// transport table. Detect them (not matching the 3-part secretBox format) and
// re-encrypt in place so rowToTransport can decrypt them correctly.
{
  const rows = db
    .prepare<[], { id: string; password: string }>(
      `SELECT id, password FROM telescopeTransports WHERE password != ''`,
    )
    .all();

  const update = db.prepare(`UPDATE telescopeTransports SET password = ? WHERE id = ?`);

  for (const row of rows) {
    const parts = row.password.split('.');
    if (parts.length !== 3) {
      // Plaintext — encrypt it now.
      update.run(encryptSecret(row.password), row.id);
    }
  }
}

// ─── Re-encrypt any plaintext passwords in telescopeProfiles ────────────────
// Profiles created before per-profile encryption was added have raw plaintext
// in the password column. Encrypt them so future reads round-trip correctly.
{
  const rows = db
    .prepare<[], { id: string; password: string }>(
      `SELECT id, password FROM telescopeProfiles WHERE password != ''`,
    )
    .all();

  const update = db.prepare(`UPDATE telescopeProfiles SET password = ? WHERE id = ?`);

  for (const row of rows) {
    const parts = row.password.split('.');
    if (parts.length !== 3) {
      update.run(encryptSecret(row.password), row.id);
    }
  }
}

// ─── One-shot backfill for multi-telescope columns ──────────────────────────
// Runs once when the schema is upgraded. Stamps existing sessions / objects
// with the active telescope's id, infers `kind` from `model`, picks a default
// color per kind. Idempotent — only writes to NULL/default cells.
{
  // Default color palette by kind. Kept here (not in src/) so the backend
  // doesn't reach into frontend code at boot.
  const colorByKind: Record<string, string> = {
    'seestar-s50': '#3b82f6',
    'seestar-s30': '#10b981',
    'dwarf-3':     '#f59e0b',
    'dwarf-2':     '#ef4444',
    'dwarf-mini':  '#f97316',
    'other':       '#8b5cf6',
  };
  const kindFromModel = (model: string): string => {
    switch (model) {
      case 'SeeStar S50': return 'seestar-s50';
      case 'SeeStar S30': return 'seestar-s30';
      case 'Dwarf 3':     return 'dwarf-3';
      case 'Dwarf II':    return 'dwarf-2';
      case 'Dwarf Mini':  return 'dwarf-mini';
      default:            return 'other';
    }
  };

  // Backfill `kind` from `model` for any row still at the default 'other'
  // where the model identifies a known device.
  const profileRows = db
    .prepare<[], { id: string; model: string; kind: string; color: string }>(
      'SELECT id, model, kind, color FROM telescopeProfiles',
    )
    .all();
  const updateProfileMeta = db.prepare(
    'UPDATE telescopeProfiles SET kind = ?, color = ? WHERE id = ?',
  );
  for (const row of profileRows) {
    const inferredKind = kindFromModel(row.model);
    const wantsKind = row.kind === 'other' && inferredKind !== 'other' ? inferredKind : row.kind;
    // Only overwrite the default violet if we actually inferred a kind.
    const wantsColor = row.color === '#8b5cf6' && wantsKind !== 'other'
      ? colorByKind[wantsKind]
      : row.color;
    if (wantsKind !== row.kind || wantsColor !== row.color) {
      updateProfileMeta.run(wantsKind, wantsColor, row.id);
    }
  }

  // Stamp librarySessions.telescopeId for any session that's still NULL.
  // Best-guess attribution: the currently-active telescope. Fine for v1
  // (single-scope users) — multi-scope users can reassign per-session later.
  const activeRow = db
    .prepare<[], { id: string }>('SELECT id FROM telescopeProfiles WHERE isActive = 1 LIMIT 1')
    .get();
  const fallbackRow = activeRow
    ? null
    : db.prepare<[], { id: string }>('SELECT id FROM telescopeProfiles ORDER BY createdAt ASC LIMIT 1').get();
  const stampId = activeRow?.id ?? fallbackRow?.id ?? null;
  if (stampId) {
    const stamped = db
      .prepare('UPDATE librarySessions SET telescopeId = ? WHERE telescopeId IS NULL')
      .run(stampId);
    if (stamped.changes > 0) {
      console.log(`[telescopes] Backfilled telescopeId on ${stamped.changes} session(s) → ${stampId}`);
    }

    // Compute primaryTelescopeId per object as the telescope with the most
    // sessions for that object. With a single telescope, every object resolves
    // to the same id. Only writes rows that are still NULL.
    const objectsNeedingPrimary = db
      .prepare<[], { objectId: string }>(
        'SELECT objectId FROM libraryObjects WHERE primaryTelescopeId IS NULL',
      )
      .all();
    if (objectsNeedingPrimary.length > 0) {
      const pickPrimary = db.prepare<[string], { telescopeId: string | null; n: number }>(
        `SELECT telescopeId, COUNT(*) as n FROM librarySessions
           WHERE objectId = ? AND telescopeId IS NOT NULL
           GROUP BY telescopeId ORDER BY n DESC LIMIT 1`,
      );
      const setPrimary = db.prepare(
        'UPDATE libraryObjects SET primaryTelescopeId = ? WHERE objectId = ?',
      );
      const tx = db.transaction(() => {
        for (const { objectId } of objectsNeedingPrimary) {
          const top = pickPrimary.get(objectId);
          if (top?.telescopeId) setPrimary.run(top.telescopeId, objectId);
          else setPrimary.run(stampId, objectId); // no sessions yet → fall back to active
        }
      });
      tx();
      console.log(`[telescopes] Computed primaryTelescopeId for ${objectsNeedingPrimary.length} object(s)`);
    }
  }
}

// ─── Fix session attribution: reassign backfill-stamped sessions ────────────
// If exactly one telescope profile has entries in sessionImportLog it means
// every real import came from that scope. Any sessions attributed to a
// different profile (e.g. the wrong "active" profile during the Phase-1
// backfill) are corrected here.  When multiple profiles have import log
// entries the migration is skipped — those attributions are legitimately split.
{
  const importerCount = db
    .prepare<[], { n: number }>('SELECT COUNT(DISTINCT telescopeId) as n FROM sessionImportLog')
    .get();
  if (importerCount && importerCount.n === 1) {
    const topImporter = db
      .prepare<[], { telescopeId: string }>('SELECT telescopeId FROM sessionImportLog LIMIT 1')
      .get();
    if (topImporter) {
      const sessionsFixed = db
        .prepare('UPDATE librarySessions SET telescopeId = ? WHERE telescopeId IS NOT NULL AND telescopeId != ?')
        .run(topImporter.telescopeId, topImporter.telescopeId);
      const objectsFixed = db
        .prepare('UPDATE libraryObjects SET primaryTelescopeId = ? WHERE primaryTelescopeId IS NOT NULL AND primaryTelescopeId != ?')
        .run(topImporter.telescopeId, topImporter.telescopeId);
      if (sessionsFixed.changes > 0) {
        console.log(`[telescopes] Reattributed ${sessionsFixed.changes} session(s) and ${objectsFixed.changes} object(s) → ${topImporter.telescopeId}`);
      }
    }
  }
}

// ─── Favorites: add userId for per-user isolation ───────────────────────────
// SQLite can't ALTER a PRIMARY KEY, so rebuild both tables if the userId
// column is absent. Existing rows (open-access installs) are preserved under
// userId = '' — the sentinel for anonymous/open-access sessions.
{
  const favColsStmt = db.prepare<[], { name: string }>('PRAGMA table_info(favorites)');
  if (!favColsStmt.all().some(c => c.name === 'userId')) {
    db.prepare(`CREATE TABLE favorites_new (
      objectId TEXT NOT NULL,
      userId   TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (objectId, userId)
    )`).run();
    db.prepare(`INSERT OR IGNORE INTO favorites_new (objectId, userId)
      SELECT objectId, '' FROM favorites`).run();
    db.prepare('DROP TABLE favorites').run();
    db.prepare('ALTER TABLE favorites_new RENAME TO favorites').run();
  }
}
{
  const imgFavColsStmt = db.prepare<[], { name: string }>('PRAGMA table_info(imageFavorites)');
  if (!imgFavColsStmt.all().some(c => c.name === 'userId')) {
    db.prepare(`CREATE TABLE imageFavorites_new (
      imagePath TEXT NOT NULL,
      userId    TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (imagePath, userId)
    )`).run();
    db.prepare(`INSERT OR IGNORE INTO imageFavorites_new (imagePath, userId)
      SELECT imagePath, '' FROM imageFavorites`).run();
    db.prepare('DROP TABLE imageFavorites').run();
    db.prepare('ALTER TABLE imageFavorites_new RENAME TO imageFavorites').run();
  }
}

// ─── Migrate JSON blob → columnar appSettings (runs once) ──────────────────
{
  // Typed prepared statements — SQL trust boundary enforced by settings/appSettings schema.
  const getLegacySettingsStmt = db.prepare<[], { data: string }>('SELECT data FROM settings WHERE id = 1');
  const getCurrentCatalogSourceStmt = db.prepare<[], { catalogSource: string }>(
    'SELECT catalogSource FROM appSettings WHERE id = 1',
  );
  const row = getLegacySettingsStmt.get();
  if (row && row.data !== '{}') {
    try {
      // Constructor coercions narrow `unknown` field-by-field — never trust a
      // JSON blob's claimed type by assertion alone.
      const parsed: unknown = JSON.parse(row.data);
      if (parsed === null || typeof parsed !== 'object') {
        throw new Error('non-object'); // caught below — defaults remain
      }
      // Trust boundary: object shape verified above; field types narrowed via
      // helper coercions before each DB write. No `as unknown as T`.
      const data = parsed as Record<string, unknown>;
      // Only migrate if appSettings is still at defaults (hasn't been migrated yet)
      const current = getCurrentCatalogSourceStmt.get();
      if (current && current.catalogSource === 'builtin' && !data._migrated) {
        const boolToInt = (v: unknown, def: number) => v === true ? 1 : v === false ? 0 : def;
        const str = (v: unknown, def: string) => typeof v === 'string' ? v : def;
        const num = (v: unknown, def: number) => typeof v === 'number' ? v : def;
        const numOrNull = (v: unknown) => typeof v === 'number' ? v : null;
        db.prepare(`UPDATE appSettings SET
          catalogSource = ?, customCatalogUrl = ?, apiKey = ?,
          latitude = ?, longitude = ?, timezone = ?,
          minAlt = ?, horizonProfile = ?,
          syncEnabled = ?, syncJpg = ?, syncFits = ?, syncThumbnails = ?,
          syncSubFrames = ?, syncVideos = ?,
          autoImportInterval = ?,
          importJpg = ?, importFits = ?, importThumbnails = ?,
          importSubFrames = ?, importVideos = ?
          WHERE id = 1`).run(
          str(data.catalogSource, 'builtin'),
          str(data.customCatalogUrl, ''),
          str(data.apiKey, ''),
          numOrNull(data.latitude),
          numOrNull(data.longitude),
          str(data.timezone, ''),
          num(data.minAlt, 20),
          JSON.stringify(data.horizonProfile || []),
          boolToInt(data.syncEnabled, 1), boolToInt(data.syncJpg, 1),
          boolToInt(data.syncFits, 1), boolToInt(data.syncThumbnails, 1),
          boolToInt(data.syncSubFrames, 0), boolToInt(data.syncVideos, 0),
          num(data.autoImportInterval, 60),
          boolToInt(data.importJpg, 1), boolToInt(data.importFits, 0),
          boolToInt(data.importThumbnails, 1), boolToInt(data.importSubFrames, 0),
          boolToInt(data.importVideos, 0),
        );
        // Mark the blob as migrated so we don't re-run
        data._migrated = true;
        db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(data));
        console.log('Migrated settings JSON blob → appSettings table');
      }
    } catch {
      // JSON parse failed — blob is empty or corrupt, defaults are fine
    }
  }
}

// ─── catalogCache: add distanceLy for pack-sourced distance data ─────────────
{
  const cols = db.prepare<[], { name: string }>('PRAGMA table_info(catalogCache)').all();
  if (!cols.some(c => c.name === 'distanceLy')) {
    db.prepare('ALTER TABLE catalogCache ADD COLUMN distanceLy REAL').run();
  }
}

export default db;
