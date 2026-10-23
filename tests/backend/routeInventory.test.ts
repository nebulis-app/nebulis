import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Router } from 'express';

import { annotateRouter } from '../../server/routes/annotate';
import { authRouter } from '../../server/routes/auth';
import { catalogRouter } from '../../server/routes/catalog';
import { catalogsRouter } from '../../server/routes/catalogs';
import { devicesRouter } from '../../server/routes/devices';
import { exploreRouter } from '../../server/routes/explore';
import { forecastRouter } from '../../server/routes/forecast';
import { gearRouter } from '../../server/routes/gear';
import { journalRouter } from '../../server/routes/journal';
import { libraryRouter } from '../../server/routes/library';
import { metaRouter } from '../../server/routes/meta';
import { notesRouter } from '../../server/routes/notes';
import { observationsRouter } from '../../server/routes/observations';
import { openapiRouter } from '../../server/routes/openapi';
import { pairRouter } from '../../server/routes/pair';
import { plannedSessionsRouter } from '../../server/routes/plannedSessions';
import { plannerRouter } from '../../server/routes/planner';
import { preferencesRouter } from '../../server/routes/preferences';
import { reportsRouter } from '../../server/routes/reports';
import { satelliteRouter } from '../../server/routes/satellite';
import { settingsRouter } from '../../server/routes/settings';
import { sitesRouter } from '../../server/routes/sites';
import { skyEventsRouter } from '../../server/routes/skyEvents';
import { storageRouter } from '../../server/routes/storage';
import { systemLogRouter } from '../../server/routes/systemLog';
import { alertsRouter } from '../../server/routes/alerts';
import { telescopeRouter } from '../../server/routes/telescope';
import { telescopesRouter } from '../../server/routes/telescopes';
import { wishlistRouter } from '../../server/routes/wishlist';

/**
 * API surface contract.
 *
 * `server/index.ts` mounts these routers under `/api/v1`, and three separate
 * clients consume that surface: the React SPA, the Android app, and the
 * iOS/tvOS app. Nothing else in the suite fails when a route is renamed,
 * re-methoded, or deleted: `tsc` only sees the handler's own types, and the
 * per-domain tests call `lib/` functions or mount a single router in
 * isolation, so a removed or renamed route simply stops being tested and
 * stays green. This file is the tripwire for that class of change.
 *
 * It locks three things:
 *   1. The route inventory (method + full path), as a committed snapshot.
 *   2. The `/api/v1` mount table, checked against `server/index.ts` itself so
 *      the snapshot above cannot silently go stale relative to the real app.
 *   3. Which mutating routes carry no auth guard, against a reviewable
 *      allowlist (see PUBLIC_MUTATIONS).
 *
 * Regenerate the snapshot after an intentional API change:
 *   UPDATE_ROUTE_INVENTORY=1 npx vitest run tests/backend/routeInventory.test.ts
 * Then treat the diff as a client-facing change and confirm the native
 * clients are updated before committing it.
 */

/** `/api/v1` mount table, mirroring the `v1.use(...)` lines in server/index.ts. */
const V1_MOUNTS: Array<[prefix: string, routerName: string]> = [
  ['/openapi.json', 'openapiRouter'],
  ['/auth', 'authRouter'],
  ['/telescope', 'telescopeRouter'],
  ['/catalog', 'catalogRouter'],
  ['/settings', 'settingsRouter'],
  ['/storage', 'storageRouter'],
  ['/notes', 'notesRouter'],
  ['/telescopes', 'telescopesRouter'],
  ['/sites', 'sitesRouter'],
  ['/forecast', 'forecastRouter'],
  ['/observations', 'observationsRouter'],
  ['/satellite', 'satelliteRouter'],
  ['/library', 'libraryRouter'],
  ['/annotate', 'annotateRouter'],
  ['/planner', 'plannerRouter'],
  ['/sky-events', 'skyEventsRouter'],
  ['/gear', 'gearRouter'],
  ['/journal', 'journalRouter'],
  ['/dso', 'plannerRouter'], // alias mounted alongside /planner
  ['/wishlist', 'wishlistRouter'],
  ['/planned-sessions', 'plannedSessionsRouter'],
  ['/reports', 'reportsRouter'],
  ['/preferences', 'preferencesRouter'],
  ['/pair', 'pairRouter'],
  ['/devices', 'devicesRouter'],
  ['/meta', 'metaRouter'],
  ['/catalogs', 'catalogsRouter'],
  ['/explore', 'exploreRouter'],
  ['/system-log', 'systemLogRouter'],
  ['/alerts', 'alertsRouter'],
];

const ROUTERS: Record<string, Router> = {
  annotateRouter,
  authRouter,
  catalogRouter,
  catalogsRouter,
  devicesRouter,
  exploreRouter,
  forecastRouter,
  gearRouter,
  journalRouter,
  libraryRouter,
  metaRouter,
  notesRouter,
  observationsRouter,
  openapiRouter,
  pairRouter,
  plannedSessionsRouter,
  plannerRouter,
  preferencesRouter,
  reportsRouter,
  satelliteRouter,
  settingsRouter,
  sitesRouter,
  skyEventsRouter,
  storageRouter,
  systemLogRouter,
  alertsRouter,
  telescopeRouter,
  telescopesRouter,
  wishlistRouter,
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Paths that `apiAuth` (mounted once on the v1 router in server/index.ts)
 * lets through with no credential at all. Mirrored from
 * `server/middleware/auth.ts`; the drift check below fails if they diverge.
 *
 * The read-method bypasses in that same file are deliberately NOT included:
 * they are gated on `isReadMethod`, so a mutation can never ride one.
 */
const PUBLIC_AUTH = ['/auth/login', '/auth/register', '/auth/status'];

/**
 * The complete set of mutating routes reachable with NO credential.
 *
 * Note what this is not: a route with no route-level `requireAdmin` is still
 * authenticated, because `apiAuth` runs for every request on the v1 router.
 * "No route-level guard" means "any valid token", not "anonymous". Only a
 * path on PUBLIC_AUTH is genuinely credential-free, so this list is the whole
 * anonymous write surface and it is deliberately tiny.
 *
 * Adding an entry is a security decision, not a test fix. `/auth/register` is
 * here because a fresh install has no user to authenticate against;
 * `/auth/login` mints the first token. Anything else needs a reason.
 */
const ANONYMOUS_MUTATIONS = ['POST /auth/login', 'POST /auth/register'];

/** Minimal shape of the Express internals this file walks. */
interface ExpressLayer {
  name?: string;
  route?: {
    path: unknown;
    methods: Record<string, boolean>;
    stack?: Array<{ name?: string }>;
  };
  handle?: { stack?: ExpressLayer[] };
}

interface RouteEntry {
  method: string;
  path: string;
  guards: string[];
}

function joinPath(prefix: string, routePath: string): string {
  const p = routePath === '/' ? '' : routePath;
  const joined = `${prefix}${p}`;
  return joined === '' ? '/' : joined;
}

/**
 * Walk one router's (flat) layer stack into route entries.
 *
 * `libraryRouter` and `pairRouter` were verified to have zero nested routers,
 * so a nested `router.use(subRouter)` anywhere in this app is unexpected: if
 * one appears, the inventory built here would silently omit its routes, which
 * is exactly the failure this test exists to prevent. We therefore fail loudly
 * rather than recurse approximately.
 */
function collectRoutes(router: Router, prefix: string): RouteEntry[] {
  const stack = (router as unknown as { stack?: ExpressLayer[] }).stack;
  if (!Array.isArray(stack)) {
    throw new Error(`Router at ${prefix} exposes no .stack; Express internals changed and this contract test must be updated.`);
  }

  const out: RouteEntry[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const rawPaths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods ?? {}).filter(m => layer.route?.methods[m]);
      const guards = (layer.route.stack ?? []).map(s => s.name ?? '<anonymous>');
      for (const rawPath of rawPaths) {
        for (const method of methods) {
          out.push({ method: method.toUpperCase(), path: joinPath(prefix, String(rawPath)), guards });
        }
      }
      continue;
    }

    // A layer with its own stack and no .route is either an inline middleware
    // chain or a mounted sub-router. Distinguish by whether it registered routes.
    const nestedStack = layer.handle?.stack;
    if (Array.isArray(nestedStack) && nestedStack.some(l => l.route)) {
      throw new Error(
        `Nested router detected under ${prefix}. This contract test walks a flat stack; ` +
          'update collectRoutes to recurse (and record the mount path) before trusting the inventory.',
      );
    }
  }
  return out;
}

function buildInventory(): RouteEntry[] {
  const entries: RouteEntry[] = [];
  for (const [prefix, routerName] of V1_MOUNTS) {
    const router = ROUTERS[routerName];
    if (!router) throw new Error(`V1_MOUNTS references unknown router "${routerName}"`);
    entries.push(...collectRoutes(router, prefix));
  }
  return entries.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
}

/** `v1.use('/prefix', someRouter)` lines as written in server/index.ts. */
function parseIndexMounts(): Array<[string, string]> {
  const source = fs.readFileSync(path.join(process.cwd(), 'server', 'index.ts'), 'utf8');
  const pairs: Array<[string, string]> = [];
  const re = /v1\.use\(\s*'([^']+)'\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) pairs.push([m[1], m[2]]);
  return pairs;
}

const FIXTURE_PATH = path.join(process.cwd(), 'tests', 'backend', 'fixtures', 'routeInventory.json');

function serialize(entries: RouteEntry[]): string {
  // Guards are part of the snapshot: a route silently losing `requireAdmin`
  // is a security regression, not just an API change.
  return `${JSON.stringify(entries, null, 2)}\n`;
}

describe('API surface contract', () => {
  const inventory = buildInventory();

  it('matches the committed route inventory snapshot', () => {
    const actual = serialize(inventory);

    if (process.env.UPDATE_ROUTE_INVENTORY === '1' || !fs.existsSync(FIXTURE_PATH)) {
      fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
      fs.writeFileSync(FIXTURE_PATH, actual);
      if (process.env.UPDATE_ROUTE_INVENTORY !== '1') {
        throw new Error(
          `Route inventory snapshot was missing and has been written to ${path.relative(process.cwd(), FIXTURE_PATH)}. ` +
            'Review it and commit it as part of the change.',
        );
      }
      return;
    }

    const expected = fs.readFileSync(FIXTURE_PATH, 'utf8');
    if (expected === actual) return;

    const before = JSON.parse(expected) as RouteEntry[];
    const after = new Set(inventory.map(e => `${e.method} ${e.path}`));
    const was = new Set(before.map(e => `${e.method} ${e.path}`));
    const removed = [...was].filter(k => !after.has(k)).sort();
    const added = [...after].filter(k => !was.has(k)).sort();

    const detail = [
      removed.length ? `REMOVED/CHANGED (breaks clients):\n  ${removed.join('\n  ')}` : '',
      added.length ? `ADDED:\n  ${added.join('\n  ')}` : '',
      'If this change is intentional, regenerate with:',
      '  UPDATE_ROUTE_INVENTORY=1 npx vitest run tests/backend/routeInventory.test.ts',
      'and confirm the native clients (Android, iOS/tvOS) are updated before committing.',
    ]
      .filter(Boolean)
      .join('\n');

    throw new Error(`The /api/v1 route inventory changed.\n${detail}`);
  });

  it('walked every router without hitting a nested-router or internals change', () => {
    // collectRoutes throws on both conditions; asserting a non-trivial count
    // also catches a router that silently stops exposing routes.
    expect(inventory.length).toBeGreaterThan(100);
  });

  it('mount table matches the v1.use(...) lines in server/index.ts', () => {
    const fromSource = parseIndexMounts().sort((a, b) => a[0].localeCompare(b[0]));
    const declared = [...V1_MOUNTS].sort((a, b) => a[0].localeCompare(b[0]));
    expect(declared).toEqual(fromSource);
  });

  it('exposes only the reviewed set of credential-free mutating routes', () => {
    const anonymous = inventory
      .filter(e => MUTATING.has(e.method))
      .filter(e => PUBLIC_AUTH.some(p => e.path === p || e.path.startsWith(`${p}/`)))
      .map(e => `${e.method} ${e.path}`)
      .sort();

    expect(anonymous).toEqual([...ANONYMOUS_MUTATIONS].sort());
  });

  it('PUBLIC_AUTH mirror matches server/middleware/auth.ts', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server', 'middleware', 'auth.ts'), 'utf8');
    const match = /const PUBLIC_AUTH = \[([^\]]*)\]/.exec(source);
    if (!match) {
      throw new Error('PUBLIC_AUTH declaration not found in server/middleware/auth.ts; this contract test must be updated.');
    }
    const fromSource = match[1]
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);

    expect([...PUBLIC_AUTH].sort()).toEqual(fromSource.sort());
  });
});
