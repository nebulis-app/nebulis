/**
 * The ISS's orbital elements, kept fresher than the satellite catalog's.
 *
 * The catalog (satelliteCatalog.ts) is refreshed once a day in one bulk request, which suits trail identification.
 * The station is different: it reboosts and dodges debris every few weeks, and a TLE a few days old can put a pass a
 * minute off. So its own elements are asked from CelesTrak on their own (one small request, CATNR=25544), at most
 * every REFRESH_MS, kept on disk, and the best of that and the catalog's copy is used, whichever has the newer epoch.
 *
 * A TLE older than STALE_MS is still used (a pass a few minutes off beats no pass) but flagged, so the page and the
 * alert can say so instead of trusting it.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../paths.js';
import { log } from '../logger.js';
import { satelliteCatalog, type TLERecord } from '../satelliteCatalog.js';
import { ISS_NORAD_ID, tleEpoch } from './passes.js';

export const ISS_TLE_URL = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${ISS_NORAD_ID}&FORMAT=tle`;
/** At most one request per this long (CelesTrak asks for no more than one download of the same data every 2 hours). */
export const REFRESH_MS = 4 * 3_600_000;
/** Past this age the elements are flagged as stale. */
export const STALE_MS = 3 * 86_400_000;
/** After a failed request. */
const BACKOFF_MS = 3_600_000;
const TIMEOUT_MS = 20_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; Nebulis/2.0; +https://github.com/nebulis-app/nebulis)';

export interface IssTle {
  record: TLERecord;
  /** The elements' epoch, ISO UTC. */
  epoch: string;
  ageHours: number;
  /** Older than STALE_MS: passes may be minutes off. */
  stale: boolean;
  /** Where they came from: the station's own request, or the satellite catalog (fetched or bundled). */
  source: 'iss' | 'catalog';
}

interface Kept { fetchedAt: string; record: TLERecord }

const filePath = () => path.join(DATA_DIR, 'iss-tle.json');
let memory: Kept | null = null;
let backoffUntil = 0;
let inFlight: Promise<Kept | null> | null = null;

function readKept(): Kept | null {
  if (memory) return memory;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    const p = parsed as Partial<Kept>;
    if (typeof p.fetchedAt === 'string' && p.record && typeof p.record.line1 === 'string' && typeof p.record.line2 === 'string') {
      memory = { fetchedAt: p.fetchedAt, record: p.record as TLERecord };
    }
  } catch { /* none kept */ }
  return memory;
}

function writeKept(kept: Kept): void {
  memory = kept;
  try {
    fs.writeFileSync(filePath(), JSON.stringify(kept));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[iss] could not keep the TLE');
  }
}

export type TleFetch = (url: string) => Promise<string>;

const defaultFetch: TleFetch = async url => {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CelesTrak answered HTTP ${res.status}`);
  return res.text();
};

async function refresh(fetcher: TleFetch, now: number): Promise<Kept | null> {
  // The catalog's own backoff means CelesTrak is refusing this machine: do not add to it.
  if (now < backoffUntil || satelliteCatalog.backoffRemainingMs() > 0) return null;
  try {
    const records = satelliteCatalog.parseTLEText(await fetcher(ISS_TLE_URL));
    const record = records.find(r => r.noradId === ISS_NORAD_ID);
    if (!record || !tleEpoch(record.line1)) throw new Error('CelesTrak answered without the ISS elements');
    const kept = { fetchedAt: new Date(now).toISOString(), record };
    writeKept(kept);
    return kept;
  } catch (err) {
    backoffUntil = now + BACKOFF_MS;
    log.warn({ err: err instanceof Error ? err.message : String(err) }, '[iss] TLE refresh failed');
    return null;
  }
}

/**
 * The freshest ISS elements on hand. With `allowFetch`, asks CelesTrak when the kept ones are older than REFRESH_MS.
 * Null only when there are none at all (no request ever succeeded and the catalog has no ISS).
 */
export async function getIssTle(opts: { allowFetch?: boolean; now?: Date; fetcher?: TleFetch } = {}): Promise<IssTle | null> {
  const now = (opts.now ?? new Date()).getTime();
  let kept = readKept();
  if (opts.allowFetch && (!kept || now - Date.parse(kept.fetchedAt) >= REFRESH_MS)) {
    inFlight ??= refresh(opts.fetcher ?? defaultFetch, now).finally(() => { inFlight = null; });
    kept = (await inFlight) ?? kept;
  }
  // Only the copy already in memory (the server loads the catalog at start): asking for the catalog here could start a
  // bulk download from CelesTrak, the one request its usage policy watches most closely.
  const fromCatalog = satelliteCatalog.getByNoradId(ISS_NORAD_ID);

  const candidates: { record: TLERecord; source: IssTle['source'] }[] = [];
  if (kept) candidates.push({ record: kept.record, source: 'iss' });
  if (fromCatalog) candidates.push({ record: fromCatalog, source: 'catalog' });
  let best: { record: TLERecord; source: IssTle['source']; epoch: Date } | null = null;
  for (const c of candidates) {
    const epoch = tleEpoch(c.record.line1);
    if (epoch && (!best || epoch > best.epoch)) best = { ...c, epoch };
  }
  if (!best) return null;
  const ageMs = now - best.epoch.getTime();
  return {
    record: best.record,
    epoch: best.epoch.toISOString(),
    ageHours: Math.round(ageMs / 360_000) / 10,
    stale: ageMs > STALE_MS,
    source: best.source,
  };
}

export function _resetIssTleForTests(): void {
  memory = null;
  backoffUntil = 0;
  inFlight = null;
  try { fs.rmSync(filePath(), { force: true }); } catch { /* none */ }
}
