/**
 * Library — processing-run domain.
 *
 * A processing run records which nights a combined processed image actually
 * draws on (a "day 1+2+3 stack"), addressing the gap where
 * `sessionProcessedImages` could only ever be filed under one session date.
 * See `processed.ts` for the image records themselves.
 */
import { randomUUID } from 'crypto';
import db from '../db.js';

export interface ProcessingRun {
  id: string;
  objectId: string;
  title: string;
  notes: string;
  software: string;
  createdAt: string;
  dates: string[];
}

interface ProcessingRunRow {
  id: string;
  objectId: string;
  title: string;
  notes: string;
  software: string;
  createdAt: string;
}

const stmts = {
  insertRun: db.prepare(
    `INSERT INTO processingRuns (id, objectId, title, notes, software, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
  ),
  insertRunSession: db.prepare('INSERT INTO processingRunSessions (runId, date) VALUES (?, ?)'),
  getRun: db.prepare<[string], ProcessingRunRow>('SELECT * FROM processingRuns WHERE id = ?'),
  getRunsForObject: db.prepare<[string], ProcessingRunRow>(
    'SELECT * FROM processingRuns WHERE objectId = ? ORDER BY createdAt DESC',
  ),
  getDatesForRun: db.prepare<[string], { date: string }>(
    'SELECT date FROM processingRunSessions WHERE runId = ? ORDER BY date ASC',
  ),
};

function toRun(row: ProcessingRunRow): ProcessingRun {
  return {
    ...row,
    dates: stmts.getDatesForRun.all(row.id).map(r => r.date),
  };
}

/** Create a run tying a set of session dates together. `dates` must be
 *  non-empty; duplicates are harmless (processingRunSessions PK dedupes). */
export function createProcessingRun(
  objectId: string,
  dates: string[],
  title: string,
  notes: string,
  software: string,
): ProcessingRun {
  const id = `run_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const create = db.transaction(() => {
    stmts.insertRun.run(id, objectId, title, notes, software, createdAt);
    for (const date of new Set(dates)) {
      stmts.insertRunSession.run(id, date);
    }
  });
  create();
  return toRun({ id, objectId, title, notes, software, createdAt });
}

export function getProcessingRun(id: string): ProcessingRun | null {
  const row = stmts.getRun.get(id);
  return row ? toRun(row) : null;
}

export function getProcessingRunsForObject(objectId: string): ProcessingRun[] {
  return stmts.getRunsForObject.all(objectId).map(toRun);
}

/** Dates for a run, or null when the run doesn't exist / has no runId. Used
 *  to embed `runDates` onto ProcessedImageRecord without a second round trip
 *  from the caller's perspective. */
export function getRunDates(runId: string | null): string[] | null {
  if (!runId) return null;
  const dates = stmts.getDatesForRun.all(runId).map(r => r.date);
  return dates.length > 0 ? dates : null;
}
