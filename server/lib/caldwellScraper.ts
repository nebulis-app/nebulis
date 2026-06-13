/**
 * Scraper for the NASA Hubble Caldwell Catalog.
 *
 * Fetches detail pages from:
 *   https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-caldwell-catalog/caldwell-{N}/
 *
 * Each page contains:
 *   - A high-res Hubble image (webp, served from NASA's WordPress CDN)
 *   - A descriptive paragraph about the object
 *   - The NGC/IC designation (used to map back to our catalog IDs)
 *
 * NASA content is public domain — no license restrictions on caching or display.
 * Attribution: NASA, ESA, and the Hubble Heritage Team.
 *
 * https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-caldwell-catalog/
 */

const BASE_URL =
  'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-caldwell-catalog';
const USER_AGENT = 'Nebulis/1.0 (astronomy companion app)';
const TIMEOUT_MS = 12_000;
// Request images at a thumbnail-friendly width via WordPress's CDN resize param.
const IMAGE_WIDTH = 600;

export interface CaldwellEntry {
  /** Caldwell number (1-109) */
  caldwellNum: number;
  /**
   * Canonical catalog ID to use for cache filenames and catalogCache rows.
   * Derived from the NGC/IC designation found on the page, e.g. "NGC188".
   * Falls back to "C{num}" for objects without an NGC/IC alias (e.g. Hyades).
   */
  catalogId: string;
  /** 1-3 sentence plain-text description from the page's opening paragraph. */
  description: string;
  /**
   * Direct URL to the primary Hubble webp image, sized at IMAGE_WIDTH px.
   * Caller is responsible for fetching and caching to disk.
   */
  imageUrl: string;
  /** The NASA detail page URL — stored as the source URL in catalogCache. */
  pageUrl: string;
}

/**
 * Fetch and parse one Caldwell detail page.
 *
 * Returns null when:
 *   - The page doesn't exist (404) — not all 109 numbers have Hubble imagery
 *   - No webp image can be found in the HTML
 *   - A network error occurs (caller should count it as a soft error)
 *
 * Throws only on AbortError (so the prefetch job can cancel cleanly).
 */
export async function fetchCaldwellEntry(
  num: number,
  signal?: AbortSignal,
): Promise<CaldwellEntry | null> {
  const pageUrl = `${BASE_URL}/caldwell-${num}/`;

  const timeoutCtrl = new AbortController();
  const timeout = setTimeout(() => timeoutCtrl.abort(), TIMEOUT_MS);
  const [combined, cleanupSignal] = signal
    ? anySignal([signal, timeoutCtrl.signal])
    : [timeoutCtrl.signal, () => {}];

  try {
    const res = await fetch(pageUrl, {
      signal: combined,
      headers: { 'User-Agent': USER_AGENT },
    });

    if (res.status === 404) return null;
    if (!res.ok) return null;

    const html = await res.text();

    // Image URL — find first NASA CDN webp in any img src or srcset.
    // The WordPress CDN strips ?w= from the stored URL; we add our own.
    const imgMatch = html.match(
      /(https:\/\/science\.nasa\.gov\/wp-content\/uploads\/\d{4}\/\d{2}\/[^\s"'?]+\.webp)/,
    );
    if (!imgMatch) return null;
    const imageUrl = `${imgMatch[1]}?w=${IMAGE_WIDTH}`;

    const description = extractDescription(html, num);
    const catalogId = extractCatalogId(html, num);

    return { caldwellNum: num, catalogId, description, imageUrl, pageUrl };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) {
      throw err;
    }
    return null;
  } finally {
    clearTimeout(timeout);
    cleanupSignal();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function extractDescription(html: string, num: number): string {
  const stripTags = (s: string) =>
    s
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

  // Strategy 1: og:description meta tag (most reliable)
  const metaMatch =
    html.match(/<meta\s[^>]*property=["']og:description["'][^>]*content=["']([^"']{40,})["']/i) ??
    html.match(/<meta\s[^>]*content=["']([^"']{40,})["'][^>]*property=["']og:description["']/i) ??
    html.match(/<meta\s[^>]*name=["']description["'][^>]*content=["']([^"']{40,})["']/i);
  if (metaMatch) return stripTags(metaMatch[1]);

  // Strategy 2: first <p> with substantial astronomical content
  const paraRe = /<p[^>]*>([\s\S]{80,?}?)<\/p>/gi;
  const astronomical =
    /caldwell|nebula|galaxy|cluster|star|binary|dwarf|emission|globular|open|elliptical|spiral|supernova|remnant|planetary/i;
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(html)) !== null) {
    const text = stripTags(m[1]);
    if (text.length >= 80 && astronomical.test(text)) return text;
  }

  return `Caldwell ${num}`;
}

function extractCatalogId(html: string, num: number): string {
  // Most Caldwell objects are identified by an NGC or IC number.
  const ngcMatch = html.match(/\bNGC\s+(\d+)\b/i);
  if (ngcMatch) return `NGC${ngcMatch[1]}`;

  const icMatch = html.match(/\bIC\s+(\d+)\b/i);
  if (icMatch) return `IC${icMatch[1]}`;

  // A handful (Hyades, Coalsack, Coma Cluster, etc.) have no NGC/IC number.
  return `C${num}`;
}

function anySignal(signals: AbortSignal[]): [AbortSignal, () => void] {
  const ctrl = new AbortController();
  const handlers: Array<() => void> = [];

  function cleanup() {
    for (let i = 0; i < signals.length; i++) {
      signals[i].removeEventListener('abort', handlers[i]);
    }
  }

  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); return [ctrl.signal, () => {}]; }
    const h = () => { ctrl.abort(); cleanup(); };
    handlers.push(h);
    s.addEventListener('abort', h);
  }

  return [ctrl.signal, cleanup];
}
