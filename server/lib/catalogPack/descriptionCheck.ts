/**
 * Guards a Wikipedia summary against being about something else.
 *
 * The pack builder searched Wikipedia by name and trusted the first hit, so the
 * Beehive Cluster got the article on a beehive and NGC 6445 got a stage play.
 * A summary is accepted only when its opening names the object: its name or one
 * of its catalog numbers.
 */
import type { DsoRecord } from '../dsoCatalogData.js';

const squash = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/** Patterns that read "NGC 6445", "M 44" / "Messier 44", "IC 434", "Sh 2-12", "C 14" in running text. */
function numberPatterns(designation: string): RegExp[] {
  const m = /^(NGC|IC|M|C|SH2-|MEL|CR|B|LDN|LBN)(\d+)([A-Z]?)$/.exec(designation);
  if (!m) return [];
  const [, prefix, n, suffix] = m;
  const tail = `${n}${suffix}`;
  const b = '(?![0-9])';
  switch (prefix) {
    case 'M': return [new RegExp(`\\b(?:Messier|M)[\\s\\u00a0]?${tail}${b}`, 'i')];
    case 'SH2-': return [new RegExp(`\\bSh[\\s\\u00a0]?2[-\\s\\u00a0]?${tail}${b}`, 'i')];
    case 'C': return [new RegExp(`\\bC(?:aldwell)?[\\s\\u00a0]?${tail}${b}`)];
    case 'MEL': return [new RegExp(`\\bMel(?:otte)?[\\s\\u00a0]?${tail}${b}`, 'i')];
    case 'CR': return [new RegExp(`\\bCollinder[\\s\\u00a0]?${tail}${b}`, 'i')];
    default: return [new RegExp(`\\b${prefix}[\\s\\u00a0]?${tail}${b}`)];
  }
}

export function descriptionLooksRight(extract: string, record: Pick<DsoRecord, 'name' | 'names' | 'designations'>): boolean {
  const opening = extract.slice(0, 400);
  const flat = squash(opening);
  for (const name of [record.name, ...record.names]) {
    const key = squash(name);
    // A bare catalog number as the "name" is covered by the number patterns below.
    if (key.length >= 4 && !/^(ngc|ic|m|c|sh2)\d+$/.test(key) && flat.includes(key)) return true;
  }
  return record.designations.some(d => numberPatterns(d).some(re => re.test(opening)));
}
