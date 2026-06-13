/**
 * One-time migration from JSON files to SQLite.
 * Detects existing JSON files, imports their data, then renames them to .json.bak.
 */
import fs from 'fs';
import path from 'path';
import db from './db.js';
import { DATA_DIR } from './paths.js';

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'nebulis-settings.json');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const WISHLIST_FILE = path.join(DATA_DIR, 'wishlist.json');
const LIBRARY_INDEX_FILE = path.join(DATA_DIR, 'library-index.json');
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');

function readJson(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function backup(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.renameSync(filePath, filePath + '.bak');
  }
}

// ─── Field-coercion helpers — narrow unknown without trust-by-assertion ─────
// Legacy JSON files were written by older versions of this app; we treat each
// field defensively so a corrupt file can't crash the migration.
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown, def = ''): string => typeof v === 'string' ? v : def;
const numOrNull = (v: unknown): number | null => typeof v === 'number' ? v : null;
const boolToInt = (v: unknown, def: 0 | 1): 0 | 1 => v === true ? 1 : v === false ? 0 : def;

export function runMigration(): void {
  // Check if any JSON files exist — if none, this is a fresh install
  const jsonFiles = [USERS_FILE, SETTINGS_FILE, NOTES_FILE, WISHLIST_FILE, LIBRARY_INDEX_FILE, FAVORITES_FILE];
  const anyExist = jsonFiles.some(f => fs.existsSync(f));
  if (!anyExist) return;

  // Check if migration already ran (tables have data).
  // Typed prepared statements — SQL trust boundary enforced by users/settings schema.
  const userCountRow = db.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM users').get();
  const settingsRow = db.prepare<[], { data: string }>('SELECT data FROM settings WHERE id = 1').get();
  const userCount = userCountRow?.c ?? 0;
  const settingsData = settingsRow?.data ?? '{}';
  if (userCount > 0 || settingsData !== '{}') return;

  console.log('Migrating JSON data to SQLite...');

  const migrate = db.transaction(() => {
    // ─── Users ─────────────────────────────────────────────────────
    // Each legacy JSON file is validated field-by-field instead of cast.
    // Rows missing required fields are skipped.
    const usersRaw = readJson(USERS_FILE);
    if (Array.isArray(usersRaw)) {
      const insertUser = db.prepare(
        'INSERT OR IGNORE INTO users (id, username, email, passwordHash, displayName, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
      );
      let migrated = 0;
      for (const u of usersRaw) {
        if (!isRecord(u)) continue;
        if (typeof u.id !== 'string' || typeof u.username !== 'string'
          || typeof u.passwordHash !== 'string' || typeof u.displayName !== 'string'
          || typeof u.createdAt !== 'string') continue;
        insertUser.run(u.id, u.username, str(u.email, ''), u.passwordHash, u.displayName, u.createdAt);
        migrated++;
      }
      console.log(`  Migrated ${migrated} users`);
    }

    // ─── Settings + Telescope Profiles ─────────────────────────────
    const settingsRaw = readJson(SETTINGS_FILE);
    if (isRecord(settingsRaw)) {
      const telescopesRaw = Array.isArray(settingsRaw.telescopes) ? settingsRaw.telescopes : [];

      const insertProfile = db.prepare(
        'INSERT OR IGNORE INTO telescopeProfiles (id, name, model, hostname, shareName, username, password, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      let profileCount = 0;
      for (const t of telescopesRaw) {
        if (!isRecord(t)) continue;
        if (typeof t.id !== 'string' || typeof t.name !== 'string') continue;
        insertProfile.run(
          t.id, t.name, str(t.model, 'SeeStar S50'), str(t.hostname, ''),
          str(t.shareName, 'EMMC Images'), str(t.username, 'guest'), str(t.password, ''),
          boolToInt(t.isActive, 0), str(t.createdAt, new Date().toISOString()),
        );
        profileCount++;
      }
      console.log(`  Migrated ${profileCount} telescope profiles`);

      // Store the rest as settings JSON blob (strip telescopes array and legacy fields)
      const { telescopes: _t, hostname: _h, shareName: _s, username: _u, password: _p, model: _m, ...rest } = settingsRaw;
      db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(rest));
      console.log('  Migrated settings');
    }

    // ─── Notes ─────────────────────────────────────────────────────
    const notesRaw = readJson(NOTES_FILE);
    if (Array.isArray(notesRaw)) {
      const insertNote = db.prepare(
        `INSERT OR IGNORE INTO notes (id, objectId, date, bortleClass, seeingRating, transparencyRating,
         moonPhase, moonIllumination, equipment, notes, rating, location, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let migrated = 0;
      for (const n of notesRaw) {
        if (!isRecord(n)) continue;
        if (typeof n.id !== 'string' || typeof n.objectId !== 'string' || typeof n.date !== 'string'
          || typeof n.createdAt !== 'string' || typeof n.updatedAt !== 'string') continue;
        insertNote.run(
          n.id, n.objectId, n.date, numOrNull(n.bortleClass), numOrNull(n.seeingRating),
          numOrNull(n.transparencyRating), typeof n.moonPhase === 'string' ? n.moonPhase : null,
          numOrNull(n.moonIllumination),
          str(n.equipment, ''), str(n.notes, ''), numOrNull(n.rating), str(n.location, ''),
          n.createdAt, n.updatedAt,
        );
        migrated++;
      }
      console.log(`  Migrated ${migrated} observation notes`);
    }

    // ─── Wishlist ──────────────────────────────────────────────────
    const wishlistRaw = readJson(WISHLIST_FILE);
    if (Array.isArray(wishlistRaw)) {
      const insertWish = db.prepare(
        `INSERT OR IGNORE INTO wishlist (id, objectId, name, type, constellation, magnitude, majorAxisArcmin, priority, notes, addedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let migrated = 0;
      for (const w of wishlistRaw) {
        if (!isRecord(w)) continue;
        if (typeof w.id !== 'string' || typeof w.objectId !== 'string'
          || typeof w.name !== 'string' || typeof w.addedAt !== 'string') continue;
        insertWish.run(
          w.id, w.objectId, w.name, str(w.type, ''),
          typeof w.constellation === 'string' ? w.constellation : null,
          numOrNull(w.magnitude), numOrNull(w.majorAxisArcmin), str(w.priority, 'medium'),
          str(w.notes, ''), w.addedAt,
        );
        migrated++;
      }
      console.log(`  Migrated ${migrated} wishlist items`);
    }

    // ─── Library Index ─────────────────────────────────────────────
    const libIndexRaw = readJson(LIBRARY_INDEX_FILE);
    if (isRecord(libIndexRaw) && isRecord(libIndexRaw.objects)) {
      const insertObj = db.prepare(
        'INSERT OR IGNORE INTO libraryObjects (objectId, folderName, fileCount, lastImport, deleted, deletedAt) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const insertSession = db.prepare(
        'INSERT OR IGNORE INTO librarySessions (objectId, date) VALUES (?, ?)'
      );
      const insertDeletedSession = db.prepare(
        'INSERT OR IGNORE INTO libraryDeletedSessions (objectId, date) VALUES (?, ?)'
      );

      let objCount = 0;
      for (const [objectId, metaRaw] of Object.entries(libIndexRaw.objects)) {
        if (!isRecord(metaRaw)) continue;
        const folderName = typeof metaRaw.folderName === 'string' ? metaRaw.folderName : objectId;
        const fileCount = typeof metaRaw.fileCount === 'number' ? metaRaw.fileCount : 0;
        const lastImport = typeof metaRaw.lastImport === 'string' ? metaRaw.lastImport : new Date().toISOString();
        const deletedAt = typeof metaRaw.deletedAt === 'string' ? metaRaw.deletedAt : null;
        const sessions = Array.isArray(metaRaw.sessions)
          ? metaRaw.sessions.filter((d): d is string => typeof d === 'string')
          : [];
        const deletedSessions = Array.isArray(metaRaw.deletedSessions)
          ? metaRaw.deletedSessions.filter((d): d is string => typeof d === 'string')
          : [];

        insertObj.run(objectId, folderName, fileCount, lastImport, boolToInt(metaRaw.deleted, 0), deletedAt);
        for (const date of sessions) insertSession.run(objectId, date);
        for (const date of deletedSessions) insertDeletedSession.run(objectId, date);
        objCount++;
      }

      const version = typeof libIndexRaw.version === 'number' ? libIndexRaw.version : 1;
      const lastImport = typeof libIndexRaw.lastImport === 'string' ? libIndexRaw.lastImport : null;
      db.prepare('UPDATE libraryMeta SET version = ?, lastImport = ? WHERE id = 1').run(version, lastImport);

      console.log(`  Migrated ${objCount} library objects`);
    }

    // ─── Favorites ─────────────────────────────────────────────────
    const favoritesRaw = readJson(FAVORITES_FILE);
    if (Array.isArray(favoritesRaw)) {
      const insertFav = db.prepare('INSERT OR IGNORE INTO favorites (objectId) VALUES (?)');
      let migrated = 0;
      for (const objectId of favoritesRaw) {
        if (typeof objectId !== 'string') continue;
        insertFav.run(objectId);
        migrated++;
      }
      console.log(`  Migrated ${migrated} favorites`);
    }
  });

  migrate();

  // Backup old JSON files
  for (const f of jsonFiles) {
    backup(f);
  }

  console.log('Migration complete. Old JSON files renamed to .bak');
}
