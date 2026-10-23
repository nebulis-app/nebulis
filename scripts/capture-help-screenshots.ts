/**
 * Captures the Help page screenshots from a running Nebulis web app.
 *
 *   npm run help:shots -- --login          sign in once in a visible browser (saves .help-shots/auth.json)
 *   npm run help:shots                     capture everything into .help-shots/out/ for review
 *   npm run help:shots -- --only objects   capture shots whose name starts with "objects" (comma list)
 *   npm run help:shots -- --write          also copy the results over src/assets/help/
 *
 * Read-only by design: it opens pages, menus and dialogs and never presses a Save, Discard,
 * Download or Delete button. Selecting frames only ticks local checkboxes.
 *
 * Options: --base http://localhost:5173   --object M16   --width 1400 --height 831
 * Every shot is independent. A failure is reported at the end and the rest still run.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from '@playwright/test';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.help-shots');
const AUTH = path.join(WORK, 'auth.json');
const OUT = path.join(WORK, 'out');
const ASSETS = path.join(ROOT, 'src', 'assets', 'help');

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = opt('base', 'http://localhost:5173');
const OBJECT = opt('object', 'M16');
const WIDTH = Number(opt('width', '1400'));
const HEIGHT = Number(opt('height', '831'));
const ONLY = opt('only', '').split(',').filter(Boolean);

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function login(browser: Browser) {
  fs.mkdirSync(WORK, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  console.log('Sign in in the browser window. Waiting up to 5 minutes...');
  await page.waitForFunction(() => !!localStorage.getItem('nebulis_auth_token'), undefined, { timeout: 300_000 });
  await wait(1500);
  await ctx.storageState({ path: AUTH });
  await ctx.close();
  console.log(`Saved ${path.relative(ROOT, AUTH)}. Run the script again without --login.`);
}

/** Close the What's New reel or tour prompt if one opens over the page. */
async function clearPopups(page: Page) {
  for (const name of [/^got it$/i, /^done$/i, /remind me later/i, /^skip/i, /^close$/i]) {
    const b = page.getByRole('dialog').getByRole('button', { name }).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click().catch(() => {});
      await wait(300);
    }
  }
}

async function go(page: Page, url: string) {
  await page.goto(BASE + url);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await clearPopups(page);
  await wait(900);
}

async function save(dest: string, shot: Buffer) {
  const file = path.join(OUT, dest);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(shot).webp({ quality: 82 }).toFile(file);
  console.log(`  ok  ${dest}`);
}

/** Real places to hide, found from the sites API at the start of a run. The active site becomes "Backyard". */
interface Places {
  /** [real name, fake name] */
  names: [string, string][];
  /** Timezones that would give a location away. */
  zones: string[];
  /** [regex source matching a real site's coordinates, fake coordinates] */
  coords: [string, string][];
}
let PLACES: Places = { names: [], zones: [], coords: [] };
const FAKE_SITES = ['Dark-sky site', 'Lake house', "Friend's farm", 'Rooftop', 'Club field'];
const FAKE_COORDS = '40.00°, -100.00°';
const FAKE_SITE_COORDS = ['38.40°, -98.30°', '41.20°, -101.50°', '39.10°, -99.20°', '42.30°, -103.10°', '37.60°, -97.10°'];
const FAKE_ZONE = 'America/Denver';

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
}

/** Replace anything personal on screen before a capture: email addresses, home-folder names, and your real sites
 *  (names, coordinates, timezones). Real names that are still visible afterwards are logged as LEAK. */
async function redact(page: Page) {
  const escape = escapeRegExp;
  // Built here, not in the page, so the browser-side function stays free of helpers.
  const rules: { src: string; flags: string; to: string }[] = [];
  for (const [real, fake] of PLACES.names) {
    // Short names (like "Test") could be ordinary words, so those only match a whole text node.
    rules.push(real.length >= 5 ? { src: `\\b${escape(real)}\\b`, flags: 'gi', to: fake } : { src: `^\\s*${escape(real)}\\s*$`, flags: 'i', to: fake });
  }
  for (const z of PLACES.zones) rules.push({ src: escape(z), flags: 'g', to: FAKE_ZONE });
  // Each real site's own coordinates, in any rounding, before the catch-all for coordinates read from image data.
  // Swapped for a placeholder first, so the catch-all below cannot overwrite them; the real fakes go in at the end.
  PLACES.coords.forEach(([src], i) => rules.push({ src, flags: 'g', to: `§SITE${i}§` }));
  const watch = [...PLACES.names.map(([r]) => r), ...PLACES.zones].filter(r => r.length >= 5);
  const fakes = PLACES.coords.map(c => c[1]);
  const leaks = await page.evaluate(({ rules, coords, watch, fakes }) => {
    const compiled = rules.map(r => ({ re: new RegExp(r.src, r.flags), to: r.to }));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const v = n.nodeValue ?? '';
      let next = v;
      for (const c of compiled) next = next.replace(c.re, c.to);
      next = next
        .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'you@example.com')
        .replace(/\/Users\/[^/\s]+/g, '/Users/you')
        .replace(/-?\d{1,2}\.\d{2}°,\s*-?\d{1,3}\.\d{2}°/g, coords)
        .replace(/-?\d{1,2}\.\d{3,5},\s*-?\d{1,3}\.\d{3,5}/g, coords)
        .replace(/§SITE(\d+)§/g, (_m, i) => fakes[Number(i)] ?? coords);
      if (next !== v) n.nodeValue = next;
    }
    for (const el of Array.from(document.querySelectorAll('input'))) {
      if (/@/.test(el.value)) el.value = 'you@example.com';
      for (const c of compiled) if (c.re.test(el.value)) el.value = el.value.replace(c.re, c.to);
    }
    const text = document.body.innerText.toLowerCase();
    return watch.filter(w => text.includes(w.toLowerCase()));
  }, { rules, coords: FAKE_COORDS, watch, fakes });
  if (leaks.length) console.log(`  LEAK still on screen: ${leaks.join(', ')}`);
  // Never save an error screen as documentation.
  const shown = await page.evaluate(() => document.body.innerText);
  const bad = ['Too many requests', 'Something went wrong', 'Failed to fetch', 'Could not load', "Couldn't load"].find(m => shown.includes(m));
  if (bad) throw new Error(`the page shows an error ("${bad}")`);
}
/** Finds the real sites and decides what each is called in the screenshots. */
async function loadPlaces(ctx: BrowserContext) {
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => !!localStorage.getItem('nebulis_auth_token'), undefined, { timeout: 20_000 });
  const data = await page.evaluate(async () => {
    const h = { Authorization: 'Bearer ' + localStorage.getItem('nebulis_auth_token') };
    const sites = (await (await fetch('/api/sites', { headers: h })).json()).data as { id: string; name: string; timezone: string; latitude: number; longitude: number }[];
    const active = (await (await fetch('/api/sites/active', { headers: h })).json()).data as { id: string } | null;
    return { sites, active };
  });
  await page.close();
  let spare = 0;
  const names: [string, string][] = data.sites.map(s => [s.name, s.id === data.active?.id ? 'Backyard' : FAKE_SITES[spare++ % FAKE_SITES.length]]);
  if (!names.some(([, fake]) => fake === 'Backyard') && names[0]) names[0][1] = 'Backyard';
  // The whole-degree part of each coordinate, so any rounding the app shows (35.9, 35.93, 35.9251) is caught.
  const whole = (v: number) => `${v < 0 ? '-' : ''}${Math.trunc(Math.abs(v))}\\.\\d+`;
  const coords: [string, string][] = data.sites.map((s, i) => [`${whole(s.latitude)}°?,?\\s*${whole(s.longitude)}°?`, FAKE_SITE_COORDS[i % FAKE_SITE_COORDS.length]]);
  PLACES = { names: names.filter(([real]) => real.trim()), zones: [...new Set(data.sites.map(s => s.timezone).filter(Boolean))], coords };
  console.log(`Hiding ${PLACES.names.length} sites: the active one shows as "Backyard".`);
}
// Map tiles show real streets and place names, so every map gets a plain background.
let BLANK_TILE: Buffer | null = null;
async function blankMapTiles(ctx: BrowserContext) {
  BLANK_TILE = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#1e293b' } }).png().toBuffer();
  await ctx.route(/(tile|arcgisonline|basemaps|cartocdn|openstreetmap|mapbox)/i, async r => {
    const host = new URL(r.request().url()).hostname;
    if (r.request().resourceType() !== 'image' || host === 'localhost' || host === '127.0.0.1') return r.continue();
    return r.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE! });
  });
}
const view = async (page: Page) => { await redact(page); return page.screenshot({ type: 'png' }); };
const box = async (l: Locator) => { await redact(l.page()); return l.screenshot({ type: 'png' }); };

/** The newest night of OBJECT, as an /observations/... URL. */
async function latestNight(page: Page): Promise<string> {
  await go(page, `/object/${OBJECT}`);
  await page.getByRole('tab', { name: /^Nights/ }).click().catch(() => {});
  await wait(600);
  const href = await page.locator(`a[href*="/observations/${OBJECT}/"]`).first().getAttribute('href');
  if (!href) throw new Error(`no night found for ${OBJECT}`);
  return href;
}

async function openSettings(page: Page, tab: string, section?: string) {
  await go(page, `/settings?tab=${tab}${section ? `&section=${section}` : ''}`);
}


/* ── Illustrative data ────────────────────────────────────────────────────────
 * Your library has no sub-frames, no integration goals and no plan for tonight, so those
 * screens would be empty. For the shots that need them, only the responses below are replaced
 * (in this browser tab; nothing is written to the server). Everything else on the page is real.
 * The numbers are made up and plausible. They are not from real frames. */
const envelope = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });

type Verdict = { score: number; grade: 'good' | 'fair' | 'bad'; flags: string[]; reasons: unknown[] };
const GOOD = (score: number): Verdict => ({ score, grade: 'good', flags: [], reasons: [] });
/** Frame index to verdict: mostly good, a few fair, a few bad, to show every kind of flag. */
function verdictFor(i: number): Verdict {
  const bad = (score: number, flag: string, reason: unknown): Verdict => ({ score, grade: 'bad', flags: [flag], reasons: [reason] });
  const fair = (score: number, flag: string, reason: unknown): Verdict => ({ score, grade: 'fair', flags: [flag], reasons: [reason] });
  switch (i) {
    case 6: return fair(64, 'soft', { flag: 'soft', fwhm: 4.6, typical: 3.1 });
    case 9: return bad(21, 'clouds', { flag: 'clouds', stars: 34, typical: 240, percentFewer: 86, brighterSky: true });
    case 10: return bad(27, 'clouds', { flag: 'clouds', stars: 52, typical: 240, percentFewer: 78, brighterSky: true });
    case 14: return fair(58, 'streak', { flag: 'streak', angle: 38 });
    case 15: return bad(15, 'trails', { flag: 'trails', ratio: 2.4, angle: 12, plain: false });
    case 19: return fair(66, 'noisy', { flag: 'noisy', percentAbove: 41 });
    default: return GOOD(86 + ((i * 7) % 11));
  }
}

/** Gives one night 24 measured raw frames. */
async function mockFrames(page: Page, objectId: string, date: string, opts: { maxSessions?: number; nightsFacet?: boolean } = {}) {
  const COUNT = 24;
  const names: string[] = [];
  let thumb: string | null = null;
  let start = Date.parse(date.split('?')[0] + 'T13:00:00Z');
  if (!Number.isFinite(start)) start = Date.now() - 86_400_000;
  const fileFor = (i: number) => {
    const mins = 5 * i;
    const stamp = `${date.split('?')[0].replace(/-/g, '')}-${String(21 + Math.floor(mins / 60)).padStart(2, '0')}${String(mins % 60).padStart(2, '0')}00`;
    const name = `Light_${objectId}_30.0s_LP_${stamp}.fit`;
    const pth = `/library/${objectId}/${date}/subs/${name}`;
    return {
      stamp, name, size: 8_388_608, type: 'fits', fileType: 'sub', path: pth, exposure: '30', filter: 'LP',
      timestamp: new Date(start + i * 300_000).toISOString(), date, frameCount: 1, isThumbnail: false,
      downloadUrl: `/api/library/file?path=${encodeURIComponent(pth)}`,
    };
  };
  await page.route(/\/api\/library\/observations\/[^/?]+\/[^/?]+/, async r => {
    const resp = await r.fetch();
    const j = await resp.json();
    const d = j.data ?? {};
    const real = (d.files ?? []) as { type?: string; downloadUrl?: string; timestamp?: string }[];
    thumb = real.find(f => f.type === 'image')?.downloadUrl ?? null;
    const first = Date.parse(real[0]?.timestamp ?? '');
    if (Number.isFinite(first)) start = first - COUNT * 300_000;
    const subs = Array.from({ length: COUNT }, (_, i) => fileFor(i));
    names.splice(0, names.length, ...subs.map(f => f.name));
    d.files = [...real, ...subs];
    d.subFiles = subs;
    await r.fulfill(envelope(d));
  });
  const metrics = (i: number) => ({
    width: 1080, height: 1920, starCount: 240 - (i % 5) * 6, fwhm: 3.1, elongation: 1.1, orientation: 0, background: 900, noise: 12,
    gradient: 1, peakSNR: 30, streak: null, saturatedFraction: 0, ra: null, dec: null,
  });
  await page.route(/\/frame-analysis(\?.*)?$/, async r => {
    if (r.request().method() !== 'GET') return r.fulfill(envelope({}));
    const frames = Array.from({ length: COUNT }, (_, i) => {
      const f = fileFor(i);
      const v = verdictFor(i);
      return { path: f.path, name: f.name, timestamp: f.stamp, thumbUrl: thumb, downloadUrl: f.downloadUrl, file: f, metrics: metrics(i), verdict: v, review: null, kept: v.grade !== 'bad' };
    });
    return r.fulfill(envelope({
      objectId, date, frames, reference: { stars: 240, fwhm: 3.1, elongation: 1.1, noise: 12, background: 900, weak: false },
      measured: COUNT, total: COUNT, pending: 0, failures: {},
    }));
  });
  await page.route(/\/frame-analysis\/(measure|review)/, r => r.fulfill(envelope({ queued: 0, pending: 0, total: COUNT })));
  if (opts.nightsFacet) {
    await page.route(`**/api/library/objects/${objectId}/media?*`, async r => {
      const resp = await r.fetch();
      const j = await resp.json();
      const d = j.data ?? {};
      d.facets = { ...(d.facets ?? {}), nights: ['2026-10-06', '2026-09-27', '2026-06-03', '2026-06-02'].map(x => ({ date: x, count: COUNT })) };
      await r.fulfill(envelope(d));
    });
  }
  await page.route(`**/api/library/objects/${objectId}/sessions`, async r => {
    const resp = await r.fetch();
    const j = await resp.json();
    const all = Array.isArray(j.data) ? j.data : [];
    const sessions = (opts.maxSessions ? all.slice(0, opts.maxSessions) : all).map((x: object) => ({ ...x, subFrameCount: COUNT }));
    await r.fulfill(envelope(sessions));
  });
}

/** An Integration card with two filters, one of them with a goal. */
async function mockIntegration(page: Page, objectId: string, date: string) {
  const night = (d: string, frames: number, sec: number) => ({ date: d, frames, exposureSec: sec });
  await page.route(`**/api/library/objects/${objectId}/integration/filters`, r => r.fulfill(envelope({
    objectId, totalFrames: 1013, totalExposureSec: 30390, unreadableFrames: 0,
    filters: [
      { filter: 'LP', frames: 744, exposureSec: 22320, goalSec: 36000, nights: [night(date, 205, 6150), night('2026-09-27', 111, 3330), night('2026-06-03', 279, 5580)] },
      { filter: 'IRCUT', frames: 269, exposureSec: 8070, goalSec: null, nights: [night('2026-04-23', 269, 8070)] },
    ],
  })));
}

/** The export dialog: one filter fully matched, one missing its darks and flats. */
async function mockStackingExport(page: Page, objectId: string, date: string) {
  const cal = (type: string, name: string, extra: Record<string, unknown> = {}) => ({
    type, name, scope: null, folderName: name, key: `${type}-${name}`, source: 'matched', fileCount: 20, bytes: 1_000_000,
    exposureSec: 30, gain: 80, binning: 1, sensorTempC: -10, filter: null, capturedAt: '2026-09-01T00:00:00Z', isExpired: false, ...extra,
  });
  const complete = {
    id: 'g1', night: date, filter: 'LP', exposureSec: 30, gain: 80, binning: 1, sensorTempC: -10, frames: 24, kept: 21, bytes: 190_000_000,
    dark: cal('dark', 'Darks 30s g80'), flat: cal('flat', 'Flats LP', { filter: 'LP', deltaDays: 0 }), flatDark: null, bias: cal('bias', 'Bias g80'), issues: [],
  };
  const problem = {
    ...complete, id: 'g2', filter: 'IRCUT', frames: 12, kept: 12, bytes: 95_000_000, dark: null, flat: null, bias: null,
    issues: [{ code: 'no_dark', severity: 'error' }, { code: 'no_flat', severity: 'error', params: { filter: 'IRCUT' } }],
  };
  await page.route(`**/api/library/objects/${objectId}/stacking-export/plan`, r => r.fulfill(envelope({
    objectId, nights: [date], includeNotKept: false, groups: [complete, problem], unmeasuredByNight: {},
    totals: { lights: 33, excluded: 3, calibrationFrames: 60, bytes: 285_000_000, errors: 2, warnings: 0 },
  })));
}

type PlanKind = 'plan' | 'conflict' | 'outcome' | 'none';
interface StoredBlock { id: number; startTime: string; endTime: string; [k: string]: unknown }

/** The Planner with an in-memory list of planned blocks instead of the server's. Plan My Night still does its real
 *  calculation; the blocks it proposes are kept here (the POSTs that would save them are answered by this mock and
 *  go nowhere). The returned helpers open the best-rated night of the forecast and build a plan on it. */
async function mockPlanner(page: Page, kind: PlanKind) {
  let ratings: { date: string; score: number }[] = [];
  const store: StoredBlock[] = [];
  let nextId = 1;
  await page.route('**/api/forecast**', async r => {
    const resp = await r.fetch();
    const j = await resp.json();
    if (Array.isArray(j.data?.nightRatings)) ratings = j.data.nightRatings;
    await r.fulfill({ response: resp });
  });
  await page.route('**/api/planned-sessions**', async r => {
    const method = r.request().method();
    const now = new Date().toISOString();
    if (method === 'POST') {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      const row = { notes: '', framingSetup: null, skipped: 0, outcome: null, ...body, id: nextId++, createdAt: now, updatedAt: now } as unknown as StoredBlock;
      store.push(row);
      return r.fulfill(envelope(row));
    }
    if (method === 'DELETE') {
      const id = Number(r.request().url().split('/').pop()?.split('?')[0]);
      const at = store.findIndex(b => b.id === id);
      if (at >= 0) store.splice(at, 1);
      return r.fulfill(envelope({ deleted: true }));
    }
    if (method !== 'GET') return r.fulfill(envelope({}));
    const u = new URL(r.request().url());
    const from = Date.parse(u.searchParams.get('from') ?? '');
    const to = Date.parse(u.searchParams.get('to') ?? '');
    const ordered = [...store].sort((x, y) => Date.parse(x.startTime) - Date.parse(y.startTime));
    const outcomes = [
      { status: 'partial', plannedSec: 7200, achievedSec: 6000, frames: 200 },
      { status: 'awaiting_import', plannedSec: 7200, achievedSec: 0, frames: 0 },
      { status: 'done', plannedSec: 7200, achievedSec: 7200, frames: 240 },
    ];
    const shown = ordered.map((b, i) => {
      const copy = { ...b };
      if (kind === 'outcome') copy.outcome = outcomes[i % outcomes.length];
      // Overlap the second block with the first, to show how a double-booking looks.
      if (kind === 'conflict' && i === 1) {
        const shift = Date.parse(ordered[0].startTime) + 30 * 60_000;
        const len = Date.parse(b.endTime) - Date.parse(b.startTime);
        copy.startTime = new Date(shift).toISOString();
        copy.endTime = new Date(shift + len).toISOString();
      }
      return copy;
    });
    return r.fulfill(envelope(shown.filter(b => Date.parse(b.startTime) < to && Date.parse(b.endTime) > from)));
  });
  return {
    /** Opens the night with the best forecast score in the day strip. */
    async openBestNight(p: Page) {
      for (let i = 0; i < 20 && ratings.length === 0; i++) await wait(300);
      if (ratings.length === 0) return;
      const best = ratings.reduce((a, b) => (b.score > a.score ? b : a));
      const day = Number(best.date.slice(8));
      const btn = p.getByRole('button', { name: new RegExp(`^[A-Za-z]{3,}\\s*${day}\\b`) }).first();
      if (await btn.count()) {
        await btn.click();
        await p.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await wait(2500);
      }
    },
    /** Runs Plan My Night on the open night. With `add`, presses Add to put the proposed blocks on the schedule. */
    async buildPlan(p: Page, add: boolean) {
      await p.getByRole('button', { name: /plan my night/i }).first().click();
      await p.getByText('Build my plan').click();
      await p.getByRole('button', { name: /^Add to / }).waitFor({ timeout: 30_000 });
      await wait(800);
      if (!add) return;
      await p.getByRole('button', { name: /^Add to / }).click();
      await p.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      await wait(3500);
    },
  };
}

type Shot = { name: string; run: (page: Page) => Promise<void> };
const shots: Shot[] = [];
const shot = (name: string, run: Shot['run']) => shots.push({ name, run });

/* ── Getting started ──────────────────────────────────────────────────────── */
shot('getting-started/settings-telescopes', async p => { await openSettings(p, 'hardware'); await save('getting-started/settings-telescopes.webp', await view(p)); });
shot('getting-started/add-telescope-modal', async p => {
  await openSettings(p, 'hardware');
  await p.getByRole('button', { name: /Add smart telescope/i }).first().click();
  const d = p.getByRole('dialog').first();
  await d.waitFor();
  await wait(500);
  await save('getting-started/add-telescope-modal.webp', await box(d));
});
shot('getting-started/settings-sky', async p => { await openSettings(p, 'sky', 'sites'); await save('getting-started/settings-sky.webp', await view(p)); });
shot('getting-started/sync-dropdown', async p => {
  await go(p, '/');
  await p.getByRole('button', { name: /online/i }).first().click();
  await wait(500);
  await save('getting-started/sync-dropdown.webp', await view(p));
});

/* ── Library ──────────────────────────────────────────────────────────────── */
shot('tour/library/filter-menu', async p => {
  await go(p, '/');
  await p.getByRole('button', { name: /^Filters/ }).first().click();
  await wait(500);
  await save('tour/library/filter-menu.webp', await view(p));
});
shot('tour/library/mosaic', async p => {
  await go(p, '/');
  await p.getByRole('button', { name: /^Layout|Mosaic/i }).first().click().catch(() => {});
  await p.getByRole('menuitem', { name: /Mosaic/i }).or(p.getByRole('button', { name: /^Mosaic$/ })).first().click().catch(() => {});
  await wait(1200);
  await wait(2500);
  await save('tour/library/mosaic.webp', await view(p));
});
shot('tour/library/object-action-bar', async p => {
  await go(p, `/object/${OBJECT}`);
  await p.getByRole('button', { name: 'More actions' }).click();
  await wait(400);
  await save('tour/library/object-action-bar.webp', await view(p));
});
shot('tour/library/session-notes', async p => {
  const night = await latestNight(p);
  await go(p, night);
  await p.getByRole('button', { name: /notes/i }).first().click();
  const d = p.getByRole('dialog').first();
  await d.waitFor();
  await save('tour/library/session-notes.webp', await box(d));
});
shot('tour/library/storage-breakdown', async p => { await openSettings(p, 'storage'); await save('tour/library/storage-breakdown.webp', await view(p)); });

/* ── Object Details ───────────────────────────────────────────────────────── */
shot('tour/objects/overview', async p => { await go(p, `/object/${OBJECT}`); await save('tour/objects/overview.webp', await view(p)); });
shot('tour/objects/tonight', async p => {
  await go(p, `/object/${OBJECT}`);
  const panel = p.getByRole('heading', { name: /tonight/i }).first().locator('xpath=ancestor::section[1] | ancestor::div[contains(@class,"rounded")][1]');
  await save('tour/objects/tonight.webp', await box(panel.first()));
});
shot('tour/objects/combined', async p => {
  await go(p, `/object/${OBJECT}`);
  await p.mouse.wheel(0, 500);
  await wait(800);
  await save('tour/objects/combined.webp', await view(p));
});
shot('tour/objects/nights', async p => {
  await go(p, `/object/${OBJECT}`);
  await p.getByRole('tab', { name: /^Nights/ }).click();
  await wait(900);
  await p.mouse.wheel(0, 450);
  await wait(500);
  await save('tour/objects/nights.webp', await view(p));
});
/* ── Gallery ──────────────────────────────────────────────────────────────── */
shot('tour/gallery/overview', async p => { await go(p, '/image-gallery'); await save('tour/gallery/overview.webp', await view(p)); });
shot('tour/gallery/viewer', async p => {
  await go(p, `/object/${OBJECT}`);
  await p.getByRole('button', { name: /^Telescope image/ }).first().click();
  await p.getByRole('dialog').first().waitFor();
  await wait(2000);
  await save('tour/gallery/viewer.webp', await view(p));
});
shot('tour/gallery/manage', async p => {
  await go(p, '/image-gallery');
  const search = p.getByPlaceholder(/search/i).first();
  await search.fill(OBJECT);
  await wait(1200);
  await save('tour/gallery/manage.webp', await view(p));
});

/* ── Observations ─────────────────────────────────────────────────────────── */
shot('tour/observations/calendar', async p => { await go(p, '/observations'); await save('tour/observations/calendar.webp', await view(p)); });
shot('tour/observations/list', async p => {
  await go(p, '/observations');
  await p.getByRole('button', { name: 'List' }).click();
  await wait(800);
  await save('tour/observations/list.webp', await view(p));
});
shot('tour/observations/detail', async p => { await go(p, await latestNight(p)); await save('tour/observations/detail.webp', await view(p)); });
shot('tour/observations/map', async p => {
  await go(p, '/observations');
  await p.getByRole('button', { name: 'Map' }).click();
  await wait(2500);
  await save('tour/observations/map.webp', await view(p));
});

/* ── Forecast ─────────────────────────────────────────────────────────────── */
shot('tour/forecast/tonight', async p => { await go(p, '/forecast'); await save('tour/forecast/tonight.webp', await view(p)); });
shot('tour/forecast/week', async p => {
  await go(p, '/forecast');
  const h = p.getByText(/the nights ahead/i).first();
  await h.scrollIntoViewIfNeeded();
  await wait(500);
  await save('tour/forecast/week.webp', await view(p));
});
shot('tour/forecast/location', async p => {
  await go(p, '/forecast');
  // The picker is labelled with the real site's name; it is renamed only in the screenshot.
  const picker = p.getByRole('button').filter({ hasText: new RegExp(PLACES.names.map(([real]) => escapeRegExp(real)).join('|')) }).first();
  await picker.click();
  await wait(500);
  await save('tour/forecast/location.webp', await view(p));
});

/* ── Planner (read-only: shows whatever is already planned) ───────────────── */
/* ── Planner (illustrative plan, see mockPlanner) ─────────────────────────── */
async function plannerOnBestNight(p: Page, kind: PlanKind) {
  const m = await mockPlanner(p, kind);
  await go(p, '/planner');
  await m.openBestNight(p);
  if (kind !== 'none') await m.buildPlan(p, true);
  return m;
}
shot('tour/planner/schedule', async p => { await plannerOnBestNight(p, 'plan'); await save('tour/planner/schedule.webp', await view(p)); });
shot('tour/planner/curves', async p => {
  await plannerOnBestNight(p, 'plan');
  await p.getByText(/altitude/i).first().scrollIntoViewIfNeeded().catch(() => {});
  await wait(1200);
  await save('tour/planner/curves.webp', await view(p));
});
shot('tour/planner/conflicts', async p => { await plannerOnBestNight(p, 'conflict'); await save('tour/planner/conflicts.webp', await view(p)); });
shot('tour/planner/conditions', async p => { await plannerOnBestNight(p, 'plan'); await save('tour/planner/conditions.webp', await box(p.locator('main').locator('> *').first())); });
shot('tour/planner/plan-vs-actual', async p => { await plannerOnBestNight(p, 'outcome'); await save('tour/planner/plan-vs-actual.webp', await view(p)); });
shot('tour/planner/plan-my-night', async p => {
  const m = await plannerOnBestNight(p, 'none');
  await m.buildPlan(p, false);
  await save('tour/planner/plan-my-night.webp', await view(p));
});
/* ── Explore ──────────────────────────────────────────────────────────────── */
shot('tour/explore/overview', async p => { await go(p, '/explore'); await wait(1500); await save('tour/explore/overview.webp', await view(p)); });
shot('tour/explore/category', async p => {
  await go(p, '/explore');
  await p.getByRole('link', { name: 'Galaxies' }).first().click();
  await p.waitForLoadState('networkidle').catch(() => {});
  await wait(1500);
  await save('tour/explore/category.webp', await view(p));
});
shot('tour/explore/card', async p => {
  await go(p, '/explore');
  await p.getByRole('link', { name: 'Galaxies' }).first().click();
  await wait(1500);
  const card = p.getByRole('button', { name: /^Open / }).first().locator('xpath=ancestor::div[contains(@class,"group")][1]');
  await save('tour/explore/card.webp', await box(card));
});

/* ── Catalogs ─────────────────────────────────────────────────────────────── */
shot('tour/catalogs/landing', async p => { await go(p, '/catalogs'); await save('tour/catalogs/landing.webp', await view(p)); });
shot('tour/catalogs/board', async p => { await go(p, '/catalogs/messier'); await save('tour/catalogs/board.webp', await view(p)); });
shot('tour/catalogs/popup', async p => {
  await go(p, '/catalogs/messier');
  await p.getByRole('button', { name: /^M16, / }).click();
  await p.getByText('Open in Planner').waitFor();
  await wait(800);
  await save('tour/catalogs/popup.webp', await view(p));
});
shot('tour/catalogs/progress', async p => {
  await go(p, '/catalogs/messier');
  await p.mouse.wheel(0, 400);
  await wait(500);
  await save('tour/catalogs/progress.webp', await view(p));
});
shot('tour/catalogs/in-frame', async p => {
  await go(p, '/catalogs/sharpless');
  const badge = p.getByText(/^In [A-Z]+\s?\d+/).first();
  await scrollTo(p, badge, 360);
  await save('tour/catalogs/in-frame.webp', await view(p));
});
shot('tour/catalogs/my-catalog', async p => { await go(p, '/catalogs/messier/mine'); await wait(2000); await save('tour/catalogs/my-catalog.webp', await view(p)); });

/* ── Settings ─────────────────────────────────────────────────────────────── */
shot('tour/settings/overview', async p => { await openSettings(p, 'general'); await save('tour/settings/overview.webp', await view(p)); });
shot('tour/settings/search', async p => {
  await openSettings(p, 'general');
  await p.keyboard.press('/');
  await p.keyboard.type('filter');
  await wait(700);
  await save('tour/settings/search.webp', await view(p));
});
shot('settings/devices', async p => { await openSettings(p, 'account', 'devices'); await save('settings/devices.webp', await view(p)); });
shot('settings/account', async p => { await openSettings(p, 'account'); await save('settings/account.webp', await view(p)); });
shot('settings/storage', async p => { await openSettings(p, 'storage'); await save('settings/storage.webp', await view(p)); });
shot('settings/advanced', async p => { await openSettings(p, 'danger'); await save('settings/advanced.webp', await view(p)); });
shot('settings/library', async p => { await openSettings(p, 'library', 'processing'); await save('settings/library.webp', await view(p)); });
shot('settings/alerts', async p => { await openSettings(p, 'alerts'); await wait(800); await save('settings/alerts.webp', await view(p)); });

/* ── Frame quality, stacking, integration, rigs, annotate ─────────────────── */
/** Expands the object page's Integration row and captures it down to the About row. */
async function integrationShot(p: Page, dest: string) {
  await mockIntegration(p, OBJECT, '2026-10-06');
  await go(p, `/object/${OBJECT}`);
  const row = p.getByRole('button', { name: /^Integration/ }).first();
  await row.scrollIntoViewIfNeeded();
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  await wait(800);
  await p.evaluate(() => window.scrollBy(0, 260));
  await wait(500);
  const top = await row.boundingBox();
  const about = await p.getByRole('button', { name: /^About / }).first().boundingBox();
  if (!top || !about) throw new Error('Integration or About row not found');
  await redact(p);
  const y = Math.max(0, top.y - 24);
  const shotBuf = await p.screenshot({ type: 'png', clip: { x: 32, y, width: Math.min(1336, WIDTH - 64), height: Math.max(120, about.y - y - 8) } });
  await save(dest, shotBuf);
}
shot('tour/objects/integration', async p => { await integrationShot(p, 'tour/objects/integration.webp'); });
shot('integration/card', async p => { await integrationShot(p, 'integration/card.webp'); });
/** Scroll so the locator sits `offset` px below the top of the viewport. */
async function scrollTo(p: Page, l: Locator, offset = 120) {
  await l.scrollIntoViewIfNeeded();
  const b = await l.boundingBox();
  if (b) await p.evaluate(y => window.scrollBy(0, y), b.y - offset);
  await wait(500);
}
async function framesPage(p: Page) {
  const night = await latestNight(p);
  const date = night.split('/').pop()!;
  await mockFrames(p, OBJECT, date);
  await go(p, night);
  await p.getByRole('tab', { name: /sub-?frames/i }).or(p.getByRole('button', { name: /sub-?frames/i })).first().click();
  await wait(2500);
}
shot('frames/list', async p => {
  await framesPage(p);
  await scrollTo(p, p.getByRole('button', { name: /Analyze Frames/i }).first(), 90);
  await p.mouse.move(2, 2);
  await wait(600);
  await save('frames/list.webp', await view(p));
});
shot('frames/preview', async p => {
  await framesPage(p);
  const row = p.getByRole('checkbox', { name: /^Select / }).nth(9).locator('xpath=ancestor::*[self::tr or self::li][1]');
  await scrollTo(p, p.getByRole('button', { name: /Analyze Frames/i }).first(), 90);
  await row.hover({ force: true, timeout: 5000 }).catch(() => {});
  await wait(1500);
  await save('frames/preview.webp', await view(p));
});
shot('frames/select', async p => {
  await framesPage(p);
  const boxes = p.getByRole('checkbox', { name: /^Select / });
  await scrollTo(p, p.getByRole('button', { name: /Analyze Frames/i }).first(), 90);
  for (const i of [9, 10, 15]) await boxes.nth(i).check();
  await wait(500);
  await save('frames/select.webp', await view(p));
});
shot('frames/analyze', async p => {
  const night = await latestNight(p);
  await mockFrames(p, OBJECT, night.split('/').pop()!, { maxSessions: 4, nightsFacet: true });
  await go(p, `/object/${OBJECT}`);
  await p.getByRole('tab', { name: /^Subframes/ }).click();
  await wait(800);
  await p.getByRole('button', { name: /Review subframes|Analyze Frames/i }).first().click();
  await wait(3000);
  await save('frames/analyze.webp', await view(p));
});
shot('frames/export-stacking', async p => {
  const night = await latestNight(p);
  const date = night.split('/').pop()!;
  await mockFrames(p, OBJECT, date, { maxSessions: 3 });
  await mockStackingExport(p, OBJECT, date);
  await go(p, `/object/${OBJECT}`);
  await p.getByRole('button', { name: 'More actions' }).click();
  await p.getByRole('menuitem', { name: 'Export for stacking' }).click();
  const d = p.getByRole('dialog', { name: 'Export for stacking' });
  await d.waitFor();
  await wait(2000);
  await save('frames/export-stacking.webp', await box(d));
});
shot('integration/filter-aliases', async p => {
  await openSettings(p, 'library', 'organization');
  const h = p.getByText('Filter aliases').first();
  await h.scrollIntoViewIfNeeded();
  await wait(500);
  await save('integration/filter-aliases.webp', await view(p));
});
shot('integration/rig', async p => {
  await go(p, await latestNight(p));
  await save('integration/rig.webp', await view(p));
});
shot('integration/group-by-rig', async p => {
  await go(p, `/object/${OBJECT}`);
  await p.getByRole('tab', { name: /^Nights/ }).click();
  await wait(800);
  await save('integration/group-by-rig.webp', await view(p));
});
async function openViewer(p: Page) {
  await go(p, `/object/${OBJECT}`);
  await p.getByRole('button', { name: /^Telescope image/ }).first().click();
  await p.getByRole('dialog').first().waitFor();
  await wait(2000);
}
shot('annotate/rings', async p => {
  await openViewer(p);
  const d = p.getByRole('dialog').first();
  await d.getByRole('button', { name: 'Name the objects in this image' }).click();
  await wait(3500);
  await save('annotate/rings.webp', await view(p));
});
shot('annotate/download', async p => {
  await openViewer(p);
  const d = p.getByRole('dialog').first();
  await d.getByRole('button', { name: 'Name the objects in this image' }).click();
  await wait(3500);
  await d.getByRole('link', { name: /download/i }).first().click();
  await wait(700);
  await save('annotate/download.webp', await view(p));
});

/* ── Uploading ────────────────────────────────────────────────────────────── */
shot('uploading/upload-files', async p => {
  await go(p, '/');
  await p.getByRole('button', { name: /^Add/ }).first().click();
  await p.getByRole('menuitem', { name: /Upload Files/i }).click();
  const d = p.getByRole('dialog').first();
  await d.waitFor();
  await wait(500);
  await save('uploading/upload-files.webp', await box(d));
});
shot('uploading/new-observation', async p => {
  await go(p, '/');
  await p.getByRole('button', { name: /^Add/ }).first().click();
  await p.getByRole('menuitem', { name: /New Observation/i }).click();
  await wait(800);
  await save('uploading/new-observation.webp', await view(p));
});

async function main() {
  const browser = await chromium.launch({ headless: !flag('login') });
  if (flag('login')) {
    await login(browser);
    await browser.close();
    return;
  }
  if (!fs.existsSync(AUTH)) {
    console.error('No saved session. Run: npm run help:shots -- --login');
    process.exit(1);
  }
  const ctx: BrowserContext = await browser.newContext({
    storageState: AUTH,
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });
  await ctx.addInitScript(() => {
    const css = document.createElement('style');
    css.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}::-webkit-scrollbar{display:none}';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(css));
  });
  await blankMapTiles(ctx);
  await loadPlaces(ctx);
  const wanted = shots.filter(s => ONLY.length === 0 || ONLY.some(o => s.name.startsWith(o)));
  const failed: { name: string; why: string }[] = [];
  for (const s of wanted) {
    console.log(s.name);
    // A shot that hits a rate limit or a slow load gets two more tries after a pause.
    let why = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const page = await ctx.newPage();
      try {
        await s.run(page);
        why = '';
        break;
      } catch (e) {
        why = (e as Error).message.split('\n')[0];
        console.log(`  retry ${attempt}/3: ${why}`);
      } finally {
        await page.close();
      }
      if (attempt < 3) await wait(20_000);
    }
    if (why) {
      console.log(`  FAIL ${why}`);
      failed.push({ name: s.name, why });
    }
  }
  await browser.close();

  if (flag('write')) {
    fs.cpSync(OUT, ASSETS, { recursive: true });
    console.log(`\nCopied ${path.relative(ROOT, OUT)} to ${path.relative(ROOT, ASSETS)}`);
  }
  console.log(`\n${wanted.length - failed.length}/${wanted.length} captured into ${path.relative(ROOT, OUT)}`);
  for (const f of failed) console.log(`  FAILED ${f.name}: ${f.why}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
