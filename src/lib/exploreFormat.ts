/** Formatting helpers for Explore's server-provided month abbreviations. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct" (the server's English abbreviation) in the UI language. */
export function monthLabel(abbr: string | null, language: string): string {
  const i = abbr ? MONTHS.indexOf(abbr) : -1;
  if (i < 0) return abbr ?? '';
  try {
    return new Intl.DateTimeFormat(language, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, i, 15)));
  } catch {
    return abbr ?? '';
  }
}

/** "Sat, Oct 11" for a YYYY-MM-DD night, pinned to UTC so the calendar date never shifts with the viewer's timezone. */
export function nightLabel(date: string, language: string): string {
  try {
    return new Intl.DateTimeFormat(language, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${date}T12:00:00Z`));
  } catch {
    return date;
  }
}

/** True for a plausible YYYY-MM-DD, so a hand-edited URL can't send a nonsense night to the server. */
export function isNightKey(v: string | null): v is string {
  return v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
