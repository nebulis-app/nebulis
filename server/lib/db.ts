/**
 * SQLite database connection and initialization.
 * Single source of truth for the database — import `db` from here everywhere.
 *
 * Schema creation runs inline so that tables exist before any other module
 * tries to prepare statements (ES module imports are hoisted).
 */
import Database from 'better-sqlite3';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from './paths.js';
import { encrypt as encryptSecret, decrypt as decryptSecret } from './crypto/secretBox.js';
import { COLOR_BY_KIND, kindFromModel, isTelescopeKind } from './types/telescopeKind.js';
import { isRecord } from './typeGuards.js';
import {
  maybeBackupBeforeMigrations,
  backupDatabaseNow,
  pruneDatabaseBackups,
  type StartupBackupOutcome,
  type DatabaseBackupInfo,
} from './dbBackup.js';
import { getCurrentVersion } from './appUpdate/platform.js';

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

// ─── Pre-upgrade snapshot (runs before any migration below) ─────────────────
// If the build version changed since the last boot, copy the database into
// {DATA_DIR}/backups/ while it still holds the OLD schema + data, so a later
// downgrade has something clean to restore. Never throws. server/index.ts
// writes the outcome to the admin system log once logging is available.
export const startupBackupOutcome: StartupBackupOutcome = (() => {
  try {
    return maybeBackupBeforeMigrations(db, getCurrentVersion());
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      previousVersion: null,
    };
  }
})();

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
    importFits          INTEGER NOT NULL DEFAULT 1,
    importThumbnails    INTEGER NOT NULL DEFAULT 0,
    importSubFrames     INTEGER NOT NULL DEFAULT 0,
    importVideos        INTEGER NOT NULL DEFAULT 0,
    -- Keep files Nebulis has no use for, so the library can be a complete copy
    -- of the device. Relaxes the unrecognized-extension, img_ working-file, and
    -- failed-frame rejections only; the five per-type toggles above still apply.
    archiveAllFiles     INTEGER NOT NULL DEFAULT 0,
    onboardingCompleted INTEGER NOT NULL DEFAULT 0,
    prefetchCatalogAssets INTEGER NOT NULL DEFAULT 1,
    planetariumShowInfo INTEGER NOT NULL DEFAULT 1,
    galleryImageSource TEXT NOT NULL DEFAULT 'sky-survey',
    -- Which catalog nomenclature to prefer for new object folder names when
    -- an object has both an NGC/IC and a Caldwell designation (e.g. "C5" vs
    -- "IC342"). 'default' keeps the existing NGC/IC-wins priority; 'caldwell'
    -- uses the Caldwell number instead. See server/lib/catalogAliases.ts.
    preferredCatalog   TEXT    NOT NULL DEFAULT 'default',
    -- Whether a session that runs past local midnight (e.g. 11pm-1am) groups
    -- as one observing night (true, default) or splits into two calendar-date
    -- sessions the old way (false). See server/lib/telescopeFiles.ts —
    -- observingNightDate/sessionNightFor/clampToNightSafeTime are the only
    -- functions gated on this; every caller (import, wizard, calendar,
    -- downloads, reports) inherits the toggle through them automatically.
    groupObservingNights INTEGER NOT NULL DEFAULT 1,
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
    status     TEXT NOT NULL            -- CATALOG_DESCRIPTION_STATUSES in lib/types/catalog.ts
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
  -- both SMB and USB, or a Dwarf reachable via FTP). Active transport is
  -- picked at run time by selectActiveTransport(): local mount present wins,
  -- then FTP, then SMB reachable; tiebreak by priority asc, then lastSeenAt
  -- desc.
  CREATE TABLE IF NOT EXISTS telescopeTransports (
    id          TEXT PRIMARY KEY,
    profileId   TEXT NOT NULL REFERENCES telescopeProfiles(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,                          -- TRANSPORT_KINDS in lib/telescopeTransports.ts: 'smb' | 'local' | 'ftp'
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
    primaryTelescopeId TEXT,
    -- 'flat' | 'nested'. See libraryLayout.ts. Defaults to 'flat' so a legacy
    -- database reaching the ALTER below keeps describing itself accurately;
    -- new objects are stamped 'nested' explicitly at creation.
    layout        TEXT NOT NULL DEFAULT 'flat'
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

  -- ─── Per-file record (the "filenames stop carrying identity" table) ──
  -- Historically the library had no per-file table: session membership was
  -- recomputed by running parseFilename(name).date through sessionNightFor on
  -- every read, which is why the importer had to rewrite filenames to stamp a
  -- session timestamp into them. This table records what the filename used to
  -- have to encode, so a file can keep the name the telescope gave it.
  --
  -- captureDate/captureTime hold the RAW capture instant, not the observing
  -- night. The night is derived at read time via observingNightDate() because
  -- the groupObservingNights setting can be toggled at any point and every
  -- session boundary in the app has to move with it. Storing a resolved night
  -- would freeze that toggle for imported files. sessionDateOverride is the
  -- escape hatch for a date the user pinned by hand (the folder wizard's
  -- unsorted bucket, or a later reassignment) and wins over the derivation.
  CREATE TABLE IF NOT EXISTS libraryFiles (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    objectId            TEXT NOT NULL,
    -- '<folderName>/<fileName>', matching the relative form used everywhere
    -- else in the library (never an absolute path — see libraryPath.ts).
    relPath             TEXT NOT NULL UNIQUE,
    fileName            TEXT NOT NULL,
    -- The name the source gave the file, kept even when fileName was rewritten
    -- on the way in. Equal to fileName for anything imported without renaming.
    originalName        TEXT NOT NULL,
    role                TEXT NOT NULL,
    captureDate         TEXT,
    captureTime         TEXT,
    sessionDateOverride TEXT,
    telescopeId         TEXT,
    bytes               INTEGER NOT NULL DEFAULT 0,
    -- Path on the telescope / source folder this came from, for provenance.
    sourcePath          TEXT,
    importedAt          TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_libraryFiles_object ON libraryFiles(objectId);
  CREATE INDEX IF NOT EXISTS idx_libraryFiles_session
    ON libraryFiles(objectId, captureDate);
  CREATE INDEX IF NOT EXISTS idx_libraryFiles_role ON libraryFiles(objectId, role);

  -- ─── Capture info parsed from device sidecars (shotsInfo.json) ───────
  -- The authoritative per-run record the device itself wrote: exposure, gain,
  -- filter, target coordinates, and how many frames were kept out of how many
  -- taken out of how many planned. Nebulis used to discard this entirely and
  -- re-derive a weaker version by parsing filenames and FITS headers.
  --
  -- Keyed on (objectId, sessionFolder), NOT on the observing night. Two capture
  -- runs can share one night with different settings — a real library has C 5
  -- shot at 60s/gain 60 and again at 120s/gain 40 on the same evening — so a
  -- night-keyed row would have to discard one of them. sessionDate is stored
  -- alongside for querying but is not the identity.
  CREATE TABLE IF NOT EXISTS captureInfo (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    objectId      TEXT NOT NULL,
    -- Session directory the sidecar was found in; '' for a flat object.
    sessionFolder TEXT NOT NULL DEFAULT '',
    sessionDate   TEXT,
    exposureSec   REAL,
    gain          INTEGER,
    filter        TEXT,
    binning       TEXT,
    framesStacked INTEGER,
    framesTaken   INTEGER,
    framesPlanned INTEGER,
    minTempC      REAL,
    maxTempC      REAL,
    -- RA in HOURS, Dec in DEGREES, exactly as the device writes them.
    raHours       REAL,
    decDeg        REAL,
    target        TEXT,
    sourceRelPath TEXT,
    updatedAt     TEXT NOT NULL,
    UNIQUE (objectId, sessionFolder)
  );
  CREATE INDEX IF NOT EXISTS idx_captureInfo_session
    ON captureInfo(objectId, sessionDate);

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

  -- ─── System log (admin audit trail) ───────────────────────────
  -- Security and administrative events: logins (success/failure), user and
  -- telescope management, device pairing, sync summaries, storage and
  -- settings changes. Append-only; see server/lib/systemLog.ts for the
  -- writer/reader and the nightly prune that enforces retention.
  -- username is a snapshot at write time so a later rename or deletion of
  -- the account doesn't rewrite history.
  CREATE TABLE IF NOT EXISTS systemLog (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    createdAt INTEGER NOT NULL,               -- Unix ms
    category  TEXT    NOT NULL,               -- 'auth' | 'user' | 'device' | 'telescope' | 'sync' | 'storage' | 'settings' | 'system'
    event     TEXT    NOT NULL,               -- machine-readable id, e.g. 'login_failed'
    level     TEXT    NOT NULL DEFAULT 'info', -- 'info' | 'warning' | 'error'
    message   TEXT    NOT NULL,               -- human-readable summary
    userId    TEXT,                           -- actor id; NULL for unauthenticated events
    username  TEXT,                           -- actor username snapshot; NULL if unknown
    ip        TEXT,
    metadata  TEXT                            -- JSON blob of structured extras (counts, ids)
  );
  CREATE INDEX IF NOT EXISTS idx_systemLog_createdAt ON systemLog(createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_systemLog_category ON systemLog(category);

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

  -- ─── Observing sites ─────────────────────────────────────────
  -- One row per place-and-sky the user observes from. An entry bundles the
  -- coordinates with the sky settings that apply there (minAlt, horizon
  -- profile, visible-sky mask), so "same garden, looking north" and "same
  -- garden, looking south" are two entries sharing coordinates.
  --
  -- The matching columns on appSettings (latitude/longitude/locationName/
  -- timezone/minAlt/horizonProfile/visibleSkyMap) are kept as a projection of
  -- whichever row has isDefault = 1. Shipped iOS/Android clients read those
  -- fields off GET /settings, so they must never stop reflecting a real site.
  -- See server/lib/observingSites.ts.
  CREATE TABLE IF NOT EXISTS observingSites (
    id             TEXT PRIMARY KEY,
    name           TEXT    NOT NULL,
    latitude       REAL,
    longitude      REAL,
    timezone       TEXT    NOT NULL DEFAULT '',
    minAlt         INTEGER NOT NULL DEFAULT 20,
    horizonProfile TEXT    NOT NULL DEFAULT '[]',
    visibleSkyMap  TEXT    NOT NULL DEFAULT '[]',
    bortleClass    INTEGER,
    isDefault      INTEGER NOT NULL DEFAULT 0,
    sortOrder      INTEGER NOT NULL DEFAULT 0,
    createdAt      TEXT    NOT NULL
  );
  -- Exactly one default, enforced here rather than by application discipline.
  -- Partial index: only isDefault = 1 rows participate, so the many 0s don't
  -- collide with each other.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_observingSites_default
    ON observingSites(isDefault) WHERE isDefault = 1;
  CREATE INDEX IF NOT EXISTS idx_observingSites_sort ON observingSites(sortOrder, createdAt);
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
  // tokenVersion is embedded in login JWTs and bumped on password change so that
  // old tokens are immediately rejected without waiting for their 30-day expiry.
  if (!userCols.some(c => c.name === 'tokenVersion')) {
    db.prepare('ALTER TABLE users ADD COLUMN tokenVersion INTEGER NOT NULL DEFAULT 0').run();
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
  if (!cols.some(c => c.name === 'galleryProcessedOnlyDefault')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN galleryProcessedOnlyDefault INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!cols.some(c => c.name === 'planetariumProcessedOnlyDefault')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN planetariumProcessedOnlyDefault INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!cols.some(c => c.name === 'temperatureUnit')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN temperatureUnit TEXT NOT NULL DEFAULT 'fahrenheit'").run();
  }
  if (!cols.some(c => c.name === 'locationName')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN locationName TEXT NOT NULL DEFAULT ''").run();
  }
  if (!cols.some(c => c.name === 'visibleSkyMap')) {
    // 288-element boolean array (36 azimuth slices × 8 elevation bands),
    // serialized as JSON. Default '[]' means "no map set yet — treat whole
    // sky as visible." The planner UI flips that into a length-288 array
    // when the user opens the Set Visible Sky editor.
    db.prepare("ALTER TABLE appSettings ADD COLUMN visibleSkyMap TEXT NOT NULL DEFAULT '[]'").run();
  }
  if (!cols.some(c => c.name === 'activeSiteId')) {
    // Which observing site the planner/forecast currently compute for. Empty
    // means "use the default site" — that is also the value every existing
    // install starts on, so the switcher is opt-in and nothing moves on upgrade.
    db.prepare("ALTER TABLE appSettings ADD COLUMN activeSiteId TEXT NOT NULL DEFAULT ''").run();
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
  if (!cols.some(c => c.name === 'nightlyMaintenanceEnabled')) {
    // Master switch for the whole nightly maintenance batch. The per-task
    // columns above are kept for backward compatibility but are no longer
    // read by the scheduler — this one flag gates everything.
    db.prepare('ALTER TABLE appSettings ADD COLUMN nightlyMaintenanceEnabled INTEGER NOT NULL DEFAULT 1').run();
    // Preserve prior intent on upgrade: an install that had deliberately
    // disabled ALL four per-task toggles keeps maintenance off rather than
    // silently turning it back on. A partial state (some on, some off)
    // collapses to "on" — the individual off-switches no longer exist, so
    // the previously-disabled task runs again, which is the point of a single
    // master switch.
    db.prepare(
      `UPDATE appSettings SET nightlyMaintenanceEnabled = 0
       WHERE plannerPrefetchEnabled = 0
         AND nightlyCatalogPackCheckEnabled = 0
         AND nightlyHousekeepingEnabled = 0
         AND nightlyForecastPrefetchEnabled = 0`
    ).run();
  }
  if (!cols.some(c => c.name === 'windSpeedUnit')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN windSpeedUnit TEXT NOT NULL DEFAULT 'mph'").run();
  }
  // Network share (UNC/SMB) as a library location, alongside the existing
  // local-path relocation (libraryPath/libraryId above). See
  // server/lib/libraryNetwork.ts and server/lib/libraryPath.ts.
  if (!cols.some(c => c.name === 'libraryLocationType')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN libraryLocationType TEXT NOT NULL DEFAULT 'local'").run();
  }
  if (!cols.some(c => c.name === 'libraryNetworkHost')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN libraryNetworkHost TEXT NOT NULL DEFAULT ''").run();
  }
  if (!cols.some(c => c.name === 'libraryNetworkShare')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN libraryNetworkShare TEXT NOT NULL DEFAULT ''").run();
  }
  if (!cols.some(c => c.name === 'libraryNetworkDomain')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN libraryNetworkDomain TEXT NOT NULL DEFAULT ''").run();
  }
  if (!cols.some(c => c.name === 'libraryNetworkUsername')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN libraryNetworkUsername TEXT NOT NULL DEFAULT ''").run();
  }
  if (!cols.some(c => c.name === 'libraryNetworkPasswordSealed')) {
    // encrypted via secretBox, same convention as telescopeTransports.password
    db.prepare("ALTER TABLE appSettings ADD COLUMN libraryNetworkPasswordSealed TEXT NOT NULL DEFAULT ''").run();
  }
  if (!cols.some(c => c.name === 'libraryNetworkSubpath')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN libraryNetworkSubpath TEXT NOT NULL DEFAULT ''").run();
  }
  if (!cols.some(c => c.name === 'preferredCatalog')) {
    db.prepare("ALTER TABLE appSettings ADD COLUMN preferredCatalog TEXT NOT NULL DEFAULT 'default'").run();
  }
  if (!cols.some(c => c.name === 'groupObservingNights')) {
    // Default 1 (on) — existing installs get the merged-session fix
    // automatically; the Settings toggle lets them opt back into the old
    // split-by-calendar-date behavior.
    db.prepare('ALTER TABLE appSettings ADD COLUMN groupObservingNights INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!cols.some(c => c.name === 'sampleLibrarySeeded')) {
    // Marks the one-time bootstrap of the M31 sample object. The DEFAULT is 1
    // ("already seeded, leave it alone") so an established install upgrading
    // into this feature never has a sample object appear in its library. The
    // repair below immediately re-derives the value, because ADD COLUMN cannot
    // tell a brand-new database from an upgrade — it stamps the same default
    // onto both.
    db.prepare('ALTER TABLE appSettings ADD COLUMN sampleLibrarySeeded INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!cols.some(c => c.name === 'sampleSeedFlagRepaired')) {
    // One-time repair of the flag above.
    //
    // The ADD COLUMN default stamped `sampleLibrarySeeded = 1` onto EVERY
    // database, brand-new ones included, so the "have we seeded yet?" flag
    // read as "yes" on an install that had never seeded anything. The only
    // honest signal for "this library is established, keep the sample out" is
    // whether the library actually holds objects, so re-derive it from that
    // once. An empty library has nothing to protect.
    //
    // Gated on its own marker column rather than run every boot: a real user
    // who deletes every object must not have the sample reappear afterwards.
    db.prepare('ALTER TABLE appSettings ADD COLUMN sampleSeedFlagRepaired INTEGER NOT NULL DEFAULT 0').run();
    const objectRow = db.prepare<[], { n: number }>(
      'SELECT COUNT(*) AS n FROM libraryObjects',
    ).get();
    const hasLibraryData = (objectRow?.n ?? 0) > 0;
    db.prepare('UPDATE appSettings SET sampleLibrarySeeded = ?, sampleSeedFlagRepaired = 1 WHERE id = 1')
      .run(hasLibraryData ? 1 : 0);
  }
  if (!cols.some(c => c.name === 'sampleObjectId')) {
    // The objectId of the demo object currently planted for the product tour,
    // or '' when none is planted. The sample is a tour prop: it exists only
    // while the tour is running and is purged when the tour ends (or at the
    // next boot, if the tour was abandoned by closing the browser). This is
    // the record of "we put that there", so the purge only ever removes an
    // object this app planted and never touches a real one.
    db.prepare("ALTER TABLE appSettings ADD COLUMN sampleObjectId TEXT NOT NULL DEFAULT ''").run();
  }
  if (!cols.some(c => c.name === 'sampleLocationSiteId')) {
    // The tour also needs coordinates, because the Planner computes nothing
    // without them and a brand-new install has none. These two record the
    // observing site whose coordinates were filled in for the tour, and the
    // name it had beforehand, so the purge can put it back exactly as it was.
    // Empty means no demo location is planted.
    db.prepare("ALTER TABLE appSettings ADD COLUMN sampleLocationSiteId TEXT NOT NULL DEFAULT ''").run();
    db.prepare("ALTER TABLE appSettings ADD COLUMN sampleLocationPrevName TEXT NOT NULL DEFAULT ''").run();
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
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN importFits INTEGER NOT NULL DEFAULT 1').run();
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
  if (!tpCols.some(c => c.name === 'pinnedTransportId')) {
    // NULL (default) means "Auto" — selectActiveTransport keeps ranking
    // local > ftp > smb. Set to a telescopeTransports.id to force that
    // transport regardless of reachability, so a manual pick fails loudly
    // (a clear "not reachable" error) instead of silently falling back to a
    // transport the user didn't choose.
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN pinnedTransportId TEXT').run();
  }

  // Stacked FITS import shipped defaulting to off, so telescopes added before
  // this changed silently skipped the file quality scoring needs. Force every
  // existing profile on, exactly once — gated on a marker column so a user who
  // deliberately disables it afterward isn't overridden on the next restart.
  const asColsForFits = db.prepare<[], { name: string }>('PRAGMA table_info(appSettings)').all();
  if (!asColsForFits.some(c => c.name === 'stackedFitsDefaultForced')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN stackedFitsDefaultForced INTEGER NOT NULL DEFAULT 0').run();
    db.prepare('UPDATE telescopeProfiles SET importFits = 1').run();
    db.prepare('UPDATE appSettings SET stackedFitsDefaultForced = 1 WHERE id = 1').run();
  }

  // Per-user release-notes dismissal. NULL means "never acknowledged" —
  // first login shows the popup with whatever is current in /meta/version.
  // Updated to the current app version whenever the user clicks "Got it".
  const upCols = db.prepare<[], { name: string }>('PRAGMA table_info(userPreferences)').all();
  if (!upCols.some(c => c.name === 'lastSeenVersion')) {
    db.prepare('ALTER TABLE userPreferences ADD COLUMN lastSeenVersion TEXT').run();
  }

  // Version of the curated-description backfill that has been applied to
  // libraryObjects. curated-descriptions.json was merged into the one catalog
  // store, so rows imported before a given batch of descriptions was added
  // still carry a blank description. server/lib/library/objects.ts runs the
  // one-time backfill when this is behind CURATED_DESCRIPTION_BACKFILL_VERSION
  // and bumps it, so a future curated-data expansion re-runs it once by
  // incrementing that constant.
  const asColsForCurated = db.prepare<[], { name: string }>('PRAGMA table_info(appSettings)').all();
  if (!asColsForCurated.some(c => c.name === 'curatedDescriptionBackfillVersion')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN curatedDescriptionBackfillVersion INTEGER NOT NULL DEFAULT 0').run();
  }

  const lsCols = db.prepare<[], { name: string }>('PRAGMA table_info(librarySessions)').all();
  if (!lsCols.some(c => c.name === 'telescopeId')) {
    db.prepare('ALTER TABLE librarySessions ADD COLUMN telescopeId TEXT').run();
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_librarySessions_telescope ON librarySessions(telescopeId)').run();

  // Cached observation-site coordinates (from FITS SITELAT/SITELONG). `lat`/`lon`
  // hold the FITS-derived location; `coordsResolved = 1` means we already read
  // the FITS header for this session (lat/lon may still be NULL when the file
  // carries no location), so the map endpoint never re-reads a coordless file.
  if (!lsCols.some(c => c.name === 'lat')) {
    db.prepare('ALTER TABLE librarySessions ADD COLUMN lat REAL').run();
  }
  if (!lsCols.some(c => c.name === 'lon')) {
    db.prepare('ALTER TABLE librarySessions ADD COLUMN lon REAL').run();
  }
  if (!lsCols.some(c => c.name === 'coordsResolved')) {
    db.prepare('ALTER TABLE librarySessions ADD COLUMN coordsResolved INTEGER NOT NULL DEFAULT 0').run();
  }

  // The coordinates the cached weather was actually fetched at.
  //
  // Weather is historical fact about a place, so it goes stale the moment the
  // session resolves to a different location: retagging it to another site,
  // editing that site's coordinates, or (the case that motivated this) fixing
  // the resolver so a session finally reads the location out of its own files.
  // Recording where each fetch happened lets the backfill notice the mismatch
  // and re-fetch, instead of every such change needing a hand-written cache
  // invalidation. NULL on pre-existing rows means "unknown": the backfill
  // re-fetches those only when the session now resolves from its own files,
  // since every pre-existing fetch used a site's coordinates and so is wrong by
  // construction for exactly those sessions. Anything still resolving to a site
  // is left alone, so upgrading doesn't re-fetch the whole library.
  if (!lsCols.some(c => c.name === 'weatherLat')) {
    db.prepare('ALTER TABLE librarySessions ADD COLUMN weatherLat REAL').run();
  }
  if (!lsCols.some(c => c.name === 'weatherLon')) {
    db.prepare('ALTER TABLE librarySessions ADD COLUMN weatherLon REAL').run();
  }

  // Which observing site this session was captured from. NULL means "the
  // default site", which is what every pre-existing session resolves to, so
  // adding the column changes nothing until the user retags something.
  //
  // Deliberately no foreign key: deleting a site must degrade its sessions to
  // the default, never cascade away observation history.
  if (!lsCols.some(c => c.name === 'siteId')) {
    db.prepare('ALTER TABLE librarySessions ADD COLUMN siteId TEXT').run();
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_librarySessions_site ON librarySessions(siteId)').run();

  // Audit 4 (indexes): `getAllFavorites` filters by userId; the table's
  // primary key is (objectId, userId) which doesn't help. Same shape for
  // `getAllImageFavorites`. Both queries fire on every /library/objects load.
  db.prepare('CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(userId)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_imageFavorites_user ON imageFavorites(userId)').run();

  const loCols = db.prepare<[], { name: string }>('PRAGMA table_info(libraryObjects)').all();
  if (!loCols.some(c => c.name === 'primaryTelescopeId')) {
    db.prepare('ALTER TABLE libraryObjects ADD COLUMN primaryTelescopeId TEXT').run();
  }
  // On-disk shape of this object's folder: 'flat' (every night's files mixed in
  // one directory, which is why the importer renames) or 'nested' (one
  // directory per session). Per object, not global, so the re-nesting migration
  // can convert one object at a time and a failure can never leave the reader
  // disagreeing with the disk. Existing rows default to 'flat' — that is what
  // every library created before this column looked like.
  const tpArchiveCols = db.prepare<[], { name: string }>('PRAGMA table_info(telescopeProfiles)').all();
  if (!tpArchiveCols.some(c => c.name === 'archiveAllFiles')) {
    db.prepare('ALTER TABLE telescopeProfiles ADD COLUMN archiveAllFiles INTEGER NOT NULL DEFAULT 0').run();
  }
  const asArchiveCols = db.prepare<[], { name: string }>('PRAGMA table_info(appSettings)').all();
  if (!asArchiveCols.some(c => c.name === 'archiveAllFiles')) {
    db.prepare('ALTER TABLE appSettings ADD COLUMN archiveAllFiles INTEGER NOT NULL DEFAULT 0').run();
  }

  if (!loCols.some(c => c.name === 'layout')) {
    db.prepare("ALTER TABLE libraryObjects ADD COLUMN layout TEXT NOT NULL DEFAULT 'flat'").run();
  }
}

// ─── Sub-frame role correction ──────────────────────────────────────────────
// A sub-frame is a raw exposure and is always FITS. Rows recorded before
// parseFilename enforced that could hold a device's per-frame preview under
// role 'sub' — Dwarf writes `Thumbnail/<same stem>.jpg` beside every RAW_TELE
// frame, and the filename alone cannot tell the two apart. Those previews were
// counted as sub-frames everywhere: the session tray, the tab badge, the
// integration stats.
//
// No version flag guards this. The WHERE clause is self-limiting: once the
// rows are corrected it matches nothing, so re-running it each boot costs one
// indexed scan and cannot double-apply.
{
  db.prepare(`
    UPDATE libraryFiles
       SET role = 'thumbnail'
     WHERE role = 'sub'
       AND lower(fileName) NOT LIKE '%.fit'
       AND lower(fileName) NOT LIKE '%.fits'
       AND lower(fileName) NOT LIKE '%.fts'
  `).run();
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

// ─── Invalidate false-negative FITS coordinate caches ───────────────────────
// The map's resolver used to list an object folder with a flat readdir, so a
// nested object's files (one level down, inside a session folder) were never
// found and the session cached as "resolved, no coordinates" — pinning it to
// the default site even though its headers carried a real SITELAT/SITELONG.
// Clear those entries so they re-resolve against the fixed walk. Only rows with
// no cached coordinates are touched; a session that did resolve keeps its value.
// One-shot, gated by a column, so genuinely coordless sessions are not re-read
// from disk on every boot.
{
  const lmCols = db.prepare<[], { name: string }>('PRAGMA table_info(libraryMeta)').all();
  if (!lmCols.some(c => c.name === 'nestedFitsCoordsRechecked')) {
    db.prepare('ALTER TABLE libraryMeta ADD COLUMN nestedFitsCoordsRechecked INTEGER NOT NULL DEFAULT 0').run();
    const cleared = db
      .prepare('UPDATE librarySessions SET coordsResolved = 0 WHERE coordsResolved = 1 AND lat IS NULL')
      .run();
    if (cleared.changes > 0) {
      console.log(`[library] Cleared ${cleared.changes} stale FITS-coordinate cache entr(ies) for re-resolution`);
    }
    db.prepare('UPDATE libraryMeta SET nestedFitsCoordsRechecked = 1 WHERE id = 1').run();
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

// ─── Re-encrypt a plaintext admin API key in appSettings ────────────────────
// The key was stored raw until sealing was added for it. Same detection as
// the transport/profile password migrations above: not the 3-part secretBox
// format means it's plaintext (or empty), so seal it in place. Also catches
// the one-time JSON-blob migration above, which still writes this column raw.
{
  const row = db.prepare<[], { apiKey: string }>('SELECT apiKey FROM appSettings WHERE id = 1').get();
  if (row?.apiKey && row.apiKey.split('.').length !== 3) {
    db.prepare('UPDATE appSettings SET apiKey = ? WHERE id = 1').run(encryptSecret(row.apiKey));
  }
}

// ─── One-shot backfill for multi-telescope columns ──────────────────────────
// Runs once when the schema is upgraded. Stamps existing sessions / objects
// with the active telescope's id, infers `kind` from `model`, picks a default
// color per kind. Idempotent — only writes to NULL/default cells.
{
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
    // `wantsKind` may come straight from the DB's TEXT column, so it is
    // narrowed with isTelescopeKind rather than asserted: a row written by a
    // newer build with a kind this version doesn't know used to index
    // COLOR_BY_KIND with it anyway and write the resulting `undefined` into
    // the color column.
    const wantsColor = row.color === '#8b5cf6' && wantsKind !== 'other' && isTelescopeKind(wantsKind)
      ? COLOR_BY_KIND[wantsKind]
      : row.color;
    if (wantsKind !== row.kind || wantsColor !== row.color) {
      updateProfileMeta.run(wantsKind, wantsColor, row.id);
    }
  }

  // Stamp librarySessions.telescopeId for any session that's still NULL.
  //
  // ONE-SHOT, gated by a libraryMeta column. This block used to run on every
  // boot and, whenever no profile was marked active, fell back to the
  // oldest-created profile — so a session row that was briefly NULL (a
  // reconcile re-bucket, a merge/split, a note-only entry) got permanently
  // claimed by whatever happened to be profile #1 on the next restart, and
  // addSessionStamped's COALESCE then made that stick forever. That is how a
  // SeeStar-only object ended up with Dwarf-attributed nights.
  //
  // Now: only the initial schema upgrade stamps, only from a genuinely active
  // profile, and never by guessing. A session whose files carry no id stays
  // NULL — the read path derives attribution from the per-file table instead
  // (see dominantTelescopeByDate).
  const lmCols = db.prepare<[], { name: string }>('PRAGMA table_info(libraryMeta)').all();
  if (!lmCols.some(c => c.name === 'sessionTelescopeBackfilled')) {
    db.prepare('ALTER TABLE libraryMeta ADD COLUMN sessionTelescopeBackfilled INTEGER NOT NULL DEFAULT 0').run();
    const activeRow = db
      .prepare<[], { id: string }>('SELECT id FROM telescopeProfiles WHERE isActive = 1 LIMIT 1')
      .get();
    const stampId = activeRow?.id ?? null;
    if (stampId) {
      const stamped = db
        .prepare('UPDATE librarySessions SET telescopeId = ? WHERE telescopeId IS NULL')
        .run(stampId);
      if (stamped.changes > 0) {
        console.log(`[telescopes] Backfilled telescopeId on ${stamped.changes} session(s) → ${stampId}`);
      }

      // Compute primaryTelescopeId per object as the telescope with the most
      // sessions for that object. Only writes rows that are still NULL.
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
    db.prepare('UPDATE libraryMeta SET sessionTelescopeBackfilled = 1 WHERE id = 1').run();
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
      // `isRecord` is a real runtime guard, so `data` is narrowed by the
      // compiler rather than asserted. Field types are then narrowed one at a
      // time via the coercion helpers below before any DB write.
      if (!isRecord(parsed)) {
        throw new Error('non-object'); // caught below — defaults remain
      }
      const data = parsed;
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

/**
 * Seed the first observing site from the legacy `appSettings` location columns.
 *
 * Only acts when `observingSites` is empty, which makes it idempotent across
 * reboots and means a user who later deletes down to a single different site
 * never gets their old location resurrected.
 *
 * Every pre-existing session keeps `siteId = NULL` and therefore resolves to
 * this row (see sessionLocation.ts), so upgrading an install
 * changes nothing observable.
 *
 * Exported so tests can drive it directly. It lives here rather than in
 * observingSites.ts because that module imports `db` — putting the seed there
 * would make the cycle db → observingSites → db, and the seed has to run before
 * any module queries the table.
 *
 * @returns true when a row was inserted, false when the table already had one.
 */
export function seedDefaultObservingSite(): boolean {
  const count = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM observingSites').get();
  if ((count?.c ?? 0) > 0) return false;

  const row = db.prepare<[], {
    latitude: number | null; longitude: number | null; locationName: string;
    timezone: string; minAlt: number; horizonProfile: string; visibleSkyMap: string;
  }>(`SELECT latitude, longitude, locationName, timezone, minAlt, horizonProfile, visibleSkyMap
        FROM appSettings WHERE id = 1`).get();
  if (!row) return false;

  db.prepare(
    `INSERT INTO observingSites
       (id, name, latitude, longitude, timezone, minAlt, horizonProfile,
        visibleSkyMap, bortleClass, isDefault, sortOrder, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 0, ?)`,
  ).run(
    randomUUID(),
    // An install with no location configured yet gets a placeholder name for
    // display. syncDefaultSiteToAppSettings deliberately does not project that
    // placeholder back into `locationName`, so "no location set" stays
    // detectable by the UI.
    row.locationName.trim() || 'My Location',
    row.latitude,
    row.longitude,
    row.timezone,
    row.minAlt,
    row.horizonProfile,
    row.visibleSkyMap,
    new Date().toISOString(),
  );
  return true;
}

// Runs after the JSON-blob → appSettings migration above, so it copies the
// final values rather than the pre-migration defaults.
if (seedDefaultObservingSite()) {
  console.log('Seeded default observing site from appSettings');
}

const RESET_LIBRARY_TABLES = [
  'libraryDeletedSessions',
  'librarySessions',
  'libraryObjects',
  'libraryMeta',
  'notes',
  'wishlist',
  'favorites',
] as const;

/** Purges every library-data table (keeps settings, users, telescope
 *  profiles), used by DELETE /settings/reset-database. Wrapped in a
 *  transaction so a crash mid-purge can't leave the database with some
 *  tables cleared and others not — the route only ever deletes the
 *  filesystem library and cache directories once this has fully committed. */
export function resetLibraryData(): void {
  const reset = db.transaction(() => {
    for (const table of RESET_LIBRARY_TABLES) {
      db.exec(`DELETE FROM ${table}`);
    }
    // Re-insert the singleton libraryMeta row.
    db.exec(`INSERT OR IGNORE INTO libraryMeta (id, version) VALUES (1, 1)`);
  });
  reset();
}

/** Take a database snapshot on demand (Settings > Storage > Backups) and prune
 *  to the retained set. The routes layer can't touch the `db` handle directly,
 *  so the call is wrapped here where it legitimately lives. */
export function createManualDatabaseBackup(): { backup: DatabaseBackupInfo; pruned: number } {
  const backup = backupDatabaseNow(db, { version: getCurrentVersion().version, kind: 'manual' });
  const pruned = pruneDatabaseBackups();
  return { backup, pruned };
}

/** Row counts across the core library tables, for the debug-logging bundle's
 *  diagnostic snapshot (server/routes/settings.ts). Not exhaustive — just the
 *  three tables that answer "how much data is in this install". */
export function getLibraryDbStats(): { objects: number; sessions: number; files: number } {
  // The statement is typed at prepare() time, so `.get()` returns the row shape
  // without an assertion. `?? 0` covers the (impossible for COUNT(*), but
  // type-visible) no-row case instead of a non-null assertion.
  const n = (sql: string) => db.prepare<[], { n: number }>(sql).get()?.n ?? 0;
  return {
    objects: n('SELECT COUNT(*) AS n FROM libraryObjects'),
    sessions: n('SELECT COUNT(*) AS n FROM librarySessions'),
    files: n('SELECT COUNT(*) AS n FROM libraryFiles'),
  };
}

export default db;
