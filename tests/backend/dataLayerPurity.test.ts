import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * `server/data` is the leaf layer: static catalog tables and the pure lookups
 * over them. Importing it must never open the database, create DATA_DIR, take
 * a backup or run a migration. It did once: `data/catalog.ts` imported
 * `lib/catalogOverrides`, which imported `lib/db`, so a build script asking for
 * catalog rows touched the developer's real nebulis.db.
 *
 * This walks the full static import closure of every file in `server/data`
 * (type-only imports ignored, they are erased) and fails if it reaches a module
 * that does work at import time.
 */
const SERVER = path.resolve(__dirname, '../../server');

/** Modules that open, create or migrate something the moment they load. */
const FORBIDDEN = ['lib/db.ts', 'lib/paths.ts', 'lib/logger.ts', 'lib/dbBackup.ts', 'lib/systemLog.ts'];

const IMPORT_RE = /^\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm;

function resolveSpecifier(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null; // json and other non-code leaves
}

function valueImports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    if (m[1]) continue;
    const resolved = resolveSpecifier(file, m[2]);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** Shortest import chain from `start` to any forbidden module, or null. */
function findForbiddenChain(start: string): string[] | null {
  const queue: string[][] = [[start]];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const chain = queue.shift()!;
    const file = chain[chain.length - 1];
    const rel = path.relative(SERVER, file);
    if (FORBIDDEN.includes(rel)) return chain;
    for (const next of valueImports(file)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...chain, next]);
    }
  }
  return null;
}

describe('server/data stays a leaf layer', () => {
  const dataFiles = fs
    .readdirSync(path.join(SERVER, 'data'))
    .filter(f => f.endsWith('.ts'))
    .map(f => path.join(SERVER, 'data', f));

  it('finds the data files', () => {
    expect(dataFiles.length).toBeGreaterThan(0);
  });

  it.each(dataFiles.map(f => [path.basename(f), f]))('%s never reaches the database or other import-time side effects', (_name, file) => {
    const chain = findForbiddenChain(file);
    expect(chain && chain.map(f => path.relative(SERVER, f)).join(' -> ')).toBeNull();
  });

  it('the guard itself catches a real chain (lib/catalogOverrides reaches lib/db)', () => {
    const chain = findForbiddenChain(path.join(SERVER, 'lib/catalogOverrides.ts'));
    expect(chain?.map(f => path.relative(SERVER, f))).toEqual(['lib/catalogOverrides.ts', 'lib/db.ts']);
  });
});
