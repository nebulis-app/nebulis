/**
 * Negative cache for catalog enrichment.
 *
 * Enrichment selects objects by the *absence* of a result (no wikiUrl, no
 * sizeArcmin, no description). Nothing recorded that a lookup had already been
 * tried and come back empty, so an object neither Wikipedia nor SIMBAD can
 * resolve stayed selected permanently: re-queried on every server start and
 * again on every import, forever.
 *
 * That is a standing network tax on the user and an unreasonable use of a free
 * academic service, and it scales with how unusual their target list is (dark
 * nebulae, obscure designations, hand-typed names) — exactly the wrong way
 * round. The fix is generic: it keys off the outcome of a lookup, never off
 * which object it was.
 *
 * Pure so it can be tested without a database; the columns it reads
 * (`enrichmentAttemptedAt`, `enrichmentAttempts`) live on libraryObjects.
 */

/**
 * Days to wait before looking up an object that came back empty, indexed by how
 * many attempts it has already had. The last entry is the steady state.
 *
 * The first step is short because a miss can be a transient network failure.
 * After that it settles long: catalog data for a fixed object does not change,
 * so a genuine miss stays a miss. A user who corrects an object's name can
 * force a fresh lookup rather than waiting the cooldown out.
 */
export const ENRICHMENT_RETRY_DAYS = [1, 7, 30] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** True when this object was looked up recently enough that trying again now
 *  would just repeat a request whose answer we already have. */
export function isEnrichmentCoolingDown(
  attemptedAt: string | null | undefined,
  attempts: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!attemptedAt) return false;
  const last = Date.parse(attemptedAt);
  if (Number.isNaN(last)) return false;
  // A clock that moved backwards (timezone change, NTP correction) would
  // otherwise make every row look freshly attempted, so a future timestamp is
  // treated as no cooldown rather than an indefinite one.
  if (last > now) return false;
  const index = Math.min(Math.max((attempts ?? 1) - 1, 0), ENRICHMENT_RETRY_DAYS.length - 1);
  return now - last < ENRICHMENT_RETRY_DAYS[index] * DAY_MS;
}
