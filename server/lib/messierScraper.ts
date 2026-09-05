/**
 * Scraper for the NASA Hubble Messier Catalog.
 *
 * Fetches detail pages from:
 *   https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-{N}/
 *
 * Each page contains:
 *   - A high-res Hubble image (webp, served from NASA's WordPress CDN)
 *   - A descriptive paragraph about the object
 *
 * NASA content is public domain. Attribution: NASA, ESA, and the Hubble Heritage Team.
 *
 * Used only by scripts/build-catalog-pack.ts (build-time, never by the live server).
 * https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/
 */

const BASE_URL =
  'https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog';
const USER_AGENT = 'Nebulis/1.0 (astronomy companion app)';
const TIMEOUT_MS = 12_000;
const IMAGE_WIDTH = 600;

export interface MessierEntry {
  /** Messier number (1-110) */
  messierNum: number;
  /** Canonical catalog ID, always "M{num}". */
  catalogId: string;
  /** 1-3 sentence plain-text description. */
  description: string;
  /** Direct URL to the primary Hubble webp image at IMAGE_WIDTH px. */
  imageUrl: string;
  /** The NASA detail page URL stored as sourceUrl in catalogCache. */
  pageUrl: string;
}

/**
 * Fetch and parse one Messier detail page.
 * Returns null when the page is missing, has no webp, or a network error occurs.
 * Throws only on AbortError.
 */
export async function fetchMessierEntry(
  num: number,
  signal?: AbortSignal,
): Promise<MessierEntry | null> {
  const pageUrl = `${BASE_URL}/messier-${num}/`;

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

    // og:image is NASA's own canonical pick for the page and is what the
    // fix targets: scanning the page body for the first .webp is fragile
    // because some pages embed an unrelated object's image (e.g. Messier
    // 48's page renders the Crab Nebula's .webp in a "related" widget
    // before M48's own image appears later in the markup — that's a .jpg,
    // not .webp, on top of it), which the old first-match regex silently
    // picked up instead. Only the science.nasa.gov WordPress CDN honors the
    // ?w= resize query param; assets.science.nasa.gov renditions (used for
    // some objects) must be requested as-is.
    const ogImageMatch =
      html.match(/<meta\s[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ??
      html.match(/<meta\s[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    const fallbackWebpMatch = html.match(
      /(https:\/\/science\.nasa\.gov\/wp-content\/uploads\/\d{4}\/\d{2}\/[^\s"'?]+\.webp)/,
    );

    let imageUrl: string | null = null;
    if (ogImageMatch) {
      const url = ogImageMatch[1];
      imageUrl = url.includes('science.nasa.gov/wp-content/uploads/') ? `${url}?w=${IMAGE_WIDTH}` : url;
    } else if (fallbackWebpMatch) {
      imageUrl = `${fallbackWebpMatch[1]}?w=${IMAGE_WIDTH}`;
    }
    if (!imageUrl) return null;

    const description = extractDescription(html, num);
    const catalogId = `M${num}`;

    return { messierNum: num, catalogId, description, imageUrl, pageUrl };
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
      // &amp; decodes last, not first: decoding it first would turn a literal
      // "&amp;lt;" (i.e. the text "&lt;") into "&lt;" and then, on the very
      // next line, into "<" — double-unescaping text that was never meant to
      // become a tag character.
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s{2,}/g, ' ')
      .trim();

  const metaMatch =
    html.match(/<meta\s[^>]*property=["']og:description["'][^>]*content=["']([^"']{40,})["']/i) ??
    html.match(/<meta\s[^>]*content=["']([^"']{40,})["'][^>]*property=["']og:description["']/i) ??
    html.match(/<meta\s[^>]*name=["']description["'][^>]*content=["']([^"']{40,})["']/i);
  if (metaMatch) return stripTags(metaMatch[1]);

  const paraRe = /<p[^>]*>([\s\S]{80,?}?)<\/p>/gi;
  const astronomical =
    /messier|nebula|galaxy|cluster|star|binary|dwarf|emission|globular|open|elliptical|spiral|supernova|remnant|planetary/i;
  let m: RegExpMatchArray | null;
  while ((m = paraRe.exec(html)) !== null) {
    const text = stripTags(m[1]);
    if (text.length >= 80 && astronomical.test(text)) return text;
  }

  return `Messier ${num}`;
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
