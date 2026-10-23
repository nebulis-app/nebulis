/**
 * Single entry point for locale-aware Intl formatting.
 *
 * Uses the app's active DISPLAY LANGUAGE (Settings -> General -> Language,
 * src/hooks/useLanguage.ts) rather than the browser's raw Accept-Language, so
 * switching the language dropdown actually changes date/number formatting
 * too — which is what the i18n issue asks for ("Localization of Dates,
 * Times, and Units ... using Intl"). A future "regional format independent
 * of UI language" setting is a reasonable follow-up but is not in scope
 * here; nothing below forecloses adding one later.
 *
 * Locale and timezone are kept strictly separate: every helper here takes an
 * OPTIONAL timeZone and never derives one from the locale. Timezone is
 * resolved per observing site elsewhere (server/lib/observerTimezone.ts) and
 * threaded through explicitly, so only one axis changes at a time.
 *
 * What NOT to route through this module: a handful of call sites use
 * `'en-US'`/`'en-CA'` + `Intl` for PARSING, not display — pulling digits out
 * via `formatToParts` or generating a stable YYYY-MM-DD sort key. Those are
 * locale-invariant by design and must keep their hardcoded locale. They are
 * commented individually at each site (src/lib/nightWindow.ts, src/lib/altaz.ts,
 * src/lib/forecastScore.ts, src/lib/timeFormat.ts's secondsIntoHour,
 * src/lib/forecastNights.ts, src/pages/ForecastPage.tsx).
 */
import i18n from '../i18n';

export function activeLocale(): string {
  return i18n.language || 'en';
}

export function formatDate(date: Date, options: Intl.DateTimeFormatOptions = {}): string {
  return date.toLocaleDateString(activeLocale(), options);
}

/** Generic locale-aware time formatting, letting Intl pick 12h vs 24h by
 *  locale default (unlike formatTime24/formatTime12 below, which pin one). */
export function formatTimeAuto(date: Date, options: Intl.DateTimeFormatOptions = {}): string {
  return date.toLocaleTimeString(activeLocale(), options);
}

/**
 * Always renders a 24-hour clock (hour:minute) regardless of locale — a
 * deliberate domain choice, not an English-language artifact: observing
 * sessions routinely cross midnight, and AM/PM is genuinely ambiguous right
 * at 00:00/12:00 for that use case. `hourCycle: 'h23'` (not `hour12: false`)
 * because some WebKit builds render midnight as "24:00" under `hour12: false`
 * — this is the same fix src/lib/timeFormat.ts's formatHm already carried
 * under a hardcoded 'en-GB', just generalized to the active locale. Locale
 * still governs digit script and the hour/minute separator.
 */
export function formatTime24(date: Date, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (!timeZone) return date.toLocaleTimeString(activeLocale(), options);
  try {
    // timeZone can be a site record or forecast-response value, not a string
    // literal — Intl throws synchronously on one it can't parse, so fall back
    // to the device's own zone rather than crash a render path.
    return date.toLocaleTimeString(activeLocale(), { ...options, timeZone });
  } catch {
    return date.toLocaleTimeString(activeLocale(), options);
  }
}

/**
 * 12-hour clock with AM/PM, for the handful of spots (forecast hour labels)
 * that deliberately use it instead of the 24h convention formatTime24 uses
 * elsewhere. Locale-aware, but keeping hour12 fixed true is itself an
 * English-leaning display choice inherited from the existing UI — not
 * something this change introduces or attempts to fix.
 */
export function formatTime12(date: Date, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: true };
  if (!timeZone) return date.toLocaleTimeString(activeLocale(), options);
  try {
    // See formatTime24's comment: timeZone is caller-supplied, not a literal.
    return date.toLocaleTimeString(activeLocale(), { ...options, timeZone });
  } catch {
    return date.toLocaleTimeString(activeLocale(), options);
  }
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(activeLocale(), options);
}

/**
 * "18 minutes ago" / "in 3 days", via Intl.RelativeTimeFormat so pluralization
 * and wording are correct per locale instead of hand-rolled `!== 1 ? 's' : ''`
 * ternaries. `style: 'narrow'` gives the compact form ("18m ago" in English)
 * for tight UI; the default 'long' form suits prose.
 */
export function formatRelativeDuration(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  style: Intl.RelativeTimeFormatStyle = 'long',
): string {
  const rtf = new Intl.RelativeTimeFormat(activeLocale(), { numeric: 'auto', style });
  return rtf.format(-value, unit);
}

/**
 * Weekday abbreviations/names for the active locale, Sunday-first (index 0 =
 * Sunday) to match `Date#getDay()`. Does NOT reorder for locales whose week
 * starts Monday — see `weekStartsOn()` for that axis, kept separate since a
 * caller may need one without the other (e.g. a fixed Sun-Sat header row that
 * only needs translated labels, not reordering).
 */
export function weekdayLabels(style: 'narrow' | 'short' | 'long' = 'short'): string[] {
  // 2023-01-01 is a Sunday; walking forward in UTC sidesteps any DST edge.
  const base = Date.UTC(2023, 0, 1);
  const fmt = new Intl.DateTimeFormat(activeLocale(), { weekday: style, timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(base + i * 86_400_000)));
}

/**
 * 0 = Sunday, 1 = Monday: the first day of the week for the active locale.
 * `Intl.Locale#getWeekInfo()` is recent (Chrome/Safari 17+; not yet in
 * Firefox) and not in TypeScript's lib.dom types, hence the feature
 * detection. Falls back
 * to Sunday, today's hardcoded assumption, when unsupported.
 */
export function weekStartsOn(): number {
  try {
    const locale = new Intl.Locale(activeLocale());
    // Feature-detected rather than cast: the method form is current, the
    // `weekInfo` getter is the older shape some engines shipped first.
    let info: unknown = 'getWeekInfo' in locale && typeof locale.getWeekInfo === 'function'
      ? locale.getWeekInfo()
      : undefined;
    if (info == null && 'weekInfo' in locale) info = locale.weekInfo;
    // Intl reports 1-7 for Mon-Sun; Date#getDay()'s scale is 0-6 for Sun-Sat.
    // 7 % 7 === 0 folds Sunday back to 0; 1-6 pass through unchanged.
    if (typeof info === 'object' && info !== null && 'firstDay' in info && typeof info.firstDay === 'number') {
      return info.firstDay % 7;
    }
  } catch {
    // Intl.Locale or weekInfo unsupported in this runtime.
  }
  return 0;
}

/** Month abbreviations/names for the active locale, January-first (index 0).
 *  'narrow' gives the shortest form (a single character in English: J F M...),
 *  though it is not guaranteed unique across months in every locale. */
export function monthLabels(style: 'narrow' | 'short' | 'long' = 'short'): string[] {
  const fmt = new Intl.DateTimeFormat(activeLocale(), { month: style, timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2023, i, 1))));
}
