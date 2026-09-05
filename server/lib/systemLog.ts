/**
 * System log — admin-facing audit trail.
 *
 * Records security and administrative events (logins, user/telescope
 * management, device pairing, sync summaries, storage and settings changes)
 * to the `systemLog` table so an admin can answer "who did what, and when"
 * without digging through server.log. Deliberately a separate concern from
 * the pino logger in logger.ts: that one is an operational/debug stream for
 * developers, this one is a curated, queryable feed for admins in Settings.
 *
 * Every write is best-effort: logEvent() never throws, so a logging failure
 * can never break the request or background job it's describing.
 */
import db from './db.js';
import { parseJsonRecord } from './typeGuards.js';

export const SYSTEM_LOG_CATEGORIES = [
  'auth', 'user', 'device', 'telescope', 'sync', 'storage', 'settings', 'system',
] as const;
export type SystemLogCategory = (typeof SYSTEM_LOG_CATEGORIES)[number];

export const SYSTEM_LOG_LEVELS = ['info', 'warning', 'error'] as const;
export type SystemLogLevel = (typeof SYSTEM_LOG_LEVELS)[number];

/** Narrow a query-string / DB string to a known category. Lives next to the
 *  array so a new category only has to be added in one place. Mirrored on the
 *  frontend at src/lib/api/systemLog.ts. */
export function isSystemLogCategory(value: string): value is SystemLogCategory {
  return (SYSTEM_LOG_CATEGORIES as readonly string[]).includes(value);
}

/** Narrow a query-string / DB string to a known level. See isSystemLogCategory. */
export function isSystemLogLevel(value: string): value is SystemLogLevel {
  return (SYSTEM_LOG_LEVELS as readonly string[]).includes(value);
}

export interface SystemLogEntry {
  id: number;
  createdAt: number; // Unix ms
  category: SystemLogCategory;
  event: string;
  level: SystemLogLevel;
  message: string;
  userId: string | null;
  username: string | null;
  ip: string | null;
  metadata: Record<string, unknown> | null;
}

interface SystemLogRow {
  id: number;
  createdAt: number;
  category: string;
  event: string;
  level: string;
  message: string;
  userId: string | null;
  username: string | null;
  ip: string | null;
  metadata: string | null;
}

const stmts = {
  insert: db.prepare(
    `INSERT INTO systemLog (createdAt, category, event, level, message, userId, username, ip, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  prune: db.prepare('DELETE FROM systemLog WHERE createdAt < ?'),
  clear: db.prepare('DELETE FROM systemLog'),
};

export interface LogEventInput {
  category: SystemLogCategory;
  event: string;
  message: string;
  level?: SystemLogLevel;
  userId?: string | null;
  username?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

export function logEvent(input: LogEventInput): void {
  try {
    stmts.insert.run(
      Date.now(),
      input.category,
      input.event,
      input.level ?? 'info',
      input.message,
      input.userId ?? null,
      input.username ?? null,
      input.ip ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
  } catch (err) {
    console.error('[systemLog] Failed to write log entry:', err instanceof Error ? err.message : err);
  }
}

export interface GetSystemLogsOptions {
  limit: number;
  offset: number;
  category?: SystemLogCategory;
  level?: SystemLogLevel;
  /** Matched against message, event, and username (case-insensitive substring). */
  search?: string;
}

export function getSystemLogs(opts: GetSystemLogsOptions): { entries: SystemLogEntry[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.category) {
    conditions.push('category = ?');
    params.push(opts.category);
  }
  if (opts.level) {
    conditions.push('level = ?');
    params.push(opts.level);
  }
  if (opts.search) {
    conditions.push('(message LIKE ? OR event LIKE ? OR username LIKE ?)');
    const term = `%${opts.search}%`;
    params.push(term, term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare<unknown[], SystemLogRow>(`SELECT * FROM systemLog ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.limit, opts.offset);
  const totalRow = db
    .prepare<unknown[], { count: number }>(`SELECT COUNT(*) as count FROM systemLog ${where}`)
    .get(...params);

  return {
    entries: rows.map(rowToEntry),
    total: totalRow?.count ?? 0,
  };
}

function rowToEntry(row: SystemLogRow): SystemLogEntry {
  // The metadata column is TEXT. logEvent() only ever writes a JSON object
  // into it, but parseJsonRecord also rejects valid-JSON non-objects (a bare
  // number, an array) so a hand-edited row degrades to null instead of being
  // handed to the admin UI typed as a Record it isn't.
  const metadata = row.metadata ? parseJsonRecord(row.metadata) : null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    // Rows are only ever written through logEvent(), so these already hold
    // union members — but the column is TEXT, so narrow rather than assert.
    // A row written by an older/newer build with a category we no longer know
    // degrades to 'system'/'info' instead of lying about its type.
    category: isSystemLogCategory(row.category) ? row.category : 'system',
    event: row.event,
    level: isSystemLogLevel(row.level) ? row.level : 'info',
    message: row.message,
    userId: row.userId,
    username: row.username,
    ip: row.ip,
    metadata,
  };
}

const DEFAULT_RETENTION_DAYS = 90;

/** Deletes entries older than `retentionDays`. Returns the number removed. */
export function pruneSystemLog(retentionDays = DEFAULT_RETENTION_DAYS): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  return stmts.prune.run(cutoff).changes;
}

/** Wipes the whole log. Callers should log the clear action itself right after. */
export function clearSystemLog(): number {
  return stmts.clear.run().changes;
}
