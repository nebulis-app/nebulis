/** IANA time zones as the browser knows them, for pickers and defaults. */

/** Every IANA zone this browser knows, for a picker's suggestions. Empty when the browser cannot list them. */
export function knownTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/** This browser's own zone, or '' when it cannot tell. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
}
