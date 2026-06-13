/**
 * Wikipedia REST API client for deep-sky object descriptions.
 *
 * Uses the free, anonymous `/api/rest_v1/page/summary/{title}` endpoint, which
 * returns a normalized 1-3 sentence extract + the canonical page URL. No auth
 * required; rate limits are generous but we still batch politely in the
 * catalog prefetch job.
 *
 * https://en.wikipedia.org/api/rest_v1/
 */

export interface WikipediaSummary {
  /** 1-3 sentence plain-text extract from the article lead */
  extract: string;
  /** Canonical desktop URL for the Wikipedia page */
  wikiUrl: string;
  /** Thumbnail URL if Wikipedia has one — currently unused by the UI */
  thumbnailUrl: string | null;
}

const ENDPOINT = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
// HTTP header values are ASCII-only per spec — Node's undici fetch throws
// synchronously on any codepoint > 255. Keep this string ASCII (no em-dash,
// smart quotes, curly apostrophes, etc.) or every request will fail.
const USER_AGENT = 'Nebulis/1.0 (https://nebulis.app - astronomy companion app)';
const TIMEOUT_MS = 5000;

/**
 * Fetch a Wikipedia page summary for the given title.
 *
 * Returns `null` if the page doesn't exist (404), the response is a
 * disambiguation page, or the request errors out. Throws on AbortError so
 * callers can detect cancellation.
 */
export async function fetchWikipediaSummary(
  title: string,
  signal?: AbortSignal,
): Promise<WikipediaSummary | null> {
  // Wikipedia titles use underscores, not spaces. We also encode once —
  // encodeURIComponent handles spaces + special chars safely.
  const encoded = encodeURIComponent(title.replace(/\s+/g, '_'));
  const url = `${ENDPOINT}${encoded}?redirect=true`;

  const timeoutCtrl = new AbortController();
  const timeout = setTimeout(() => timeoutCtrl.abort(), TIMEOUT_MS);

  // Combine caller signal with internal timeout. cleanup() removes the abort
  // listener from the parent signal even on normal completion, preventing leaks.
  const [combined, cleanupSignal] = signal
    ? anySignal([signal, timeoutCtrl.signal])
    : [timeoutCtrl.signal, () => {}];

  try {
    const res = await fetch(url, {
      signal: combined,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;

    const data = (await res.json()) as {
      type?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
      thumbnail?: { source?: string };
    };

    // Skip disambiguation pages — their "extract" is usually useless.
    if (data.type === 'disambiguation') return null;

    const extract = (data.extract || '').trim();
    if (!extract) return null;

    return {
      extract,
      wikiUrl: data.content_urls?.desktop?.page ?? '',
      thumbnailUrl: data.thumbnail?.source ?? null,
    };
  } catch (err) {
    // Re-throw AbortError from the caller-supplied signal so prefetch jobs
    // can distinguish cancellation from transient network failures.
    if (err instanceof Error && err.name === 'AbortError' && signal?.aborted) {
      throw err;
    }
    // Log network errors distinctly from 404s (which return null silently above).
    console.warn('[wikipedia] Network error fetching summary for', title, '—', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timeout);
    cleanupSignal();
  }
}

/**
 * Combine multiple AbortSignals into one.
 * Returns [combinedSignal, cleanup]. Always call cleanup() in a finally block
 * so abort listeners are removed from the input signals on normal completion —
 * not just when the signal fires. Without this, long-lived parent signals
 * accumulate thousands of leaked listeners across many requests.
 */
function anySignal(signals: AbortSignal[]): [AbortSignal, () => void] {
  const controller = new AbortController();
  const handlers: Array<() => void> = [];

  function cleanup() {
    for (let i = 0; i < signals.length; i++) {
      signals[i].removeEventListener('abort', handlers[i]);
    }
  }

  for (const s of signals) {
    if (s.aborted) {
      controller.abort();
      return [controller.signal, () => {}];
    }
    const h = () => { controller.abort(); cleanup(); };
    handlers.push(h);
    s.addEventListener('abort', h);
  }

  return [controller.signal, cleanup];
}
