/**
 * Display form for catalog designations in "also known as" lists.
 *
 * The catalog data carries designations in whatever shape their source used
 * ("Mel022", "MEL022", "IC0434"). This fixes the casing of the well-known
 * prefixes and drops leading zeros, keeping the compact style the rest of the
 * app already uses ("IC434", "NGC1976"). It is a presentation helper only: the
 * API strings are left alone, and anything that is not a known prefix plus a
 * number (common names, "Sh2-132") comes back exactly as it was.
 */
const PREFIXES: Record<string, string> = {
  m: 'M', ngc: 'NGC', ic: 'IC', b: 'B', c: 'C', mel: 'Mel', cr: 'Cr', tr: 'Tr', ldn: 'LDN', lbn: 'LBN',
};

const DESIGNATION = /^([A-Za-z]{1,3})\s?0*(\d+)([A-Za-z]?)$/;

export function formatDesignation(name: string): string {
  const match = DESIGNATION.exec(name.trim());
  if (!match) return name;
  const prefix = PREFIXES[match[1].toLowerCase()];
  if (!prefix) return name;
  return `${prefix}${match[2]}${match[3].toUpperCase()}`;
}

/** Formats each name, then keeps the first of any that now match, ignoring case and spacing. */
export function formatAliases(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const display = formatDesignation(name);
    const key = display.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(display);
  }
  return out;
}
