/** Bodies shorter than this stay plain: a bold lead only helps a skimmer when there is a wall to skim. */
const MIN_WORDS_FOR_LEAD = 40;
/** Wide enough that German (longer sentences) keeps the lead as often as English does. */
const MAX_LEAD_CHARS = 200;
const ABBREVIATION_BEFORE_DOT = /(?:e\.g|i\.e|vs|etc|approx|z\.\s?B|bzw|ca|p\.\s?ex|c\.-à-d|d\.\s?h|bijv|enz)$/i;

/**
 * Splits `text` into a short first sentence and the rest, or returns null when it should stay one plain
 * paragraph: too short to need a lead, carries `<1>`-style `<Trans>` tags, has no clean sentence end, or its
 * first sentence is longer than `max` characters.
 */
export function blockFromText(text: string, max = MAX_LEAD_CHARS): { lead: string; rest: string } | null {
  if (/<\/?\d+>/.test(text)) return null;
  if (text.trim().split(/\s+/).length < MIN_WORDS_FOR_LEAD) return null;
  const boundary = /[.!?](?=\s+[A-ZÀ-ÖØ-Þ"“‘'(¿¡\d])/g;
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    const end = m.index + 1;
    const before = text.slice(0, m.index);
    if (ABBREVIATION_BEFORE_DOT.test(before)) continue;
    // "version 2.1. Then" ends a sentence; "10. Spiral" in a list or a lone initial does not.
    if (/(?:^|\s)[A-Za-z]$/.test(before)) continue;
    if (end > max) return null;
    return { lead: text.slice(0, end), rest: text.slice(end).trimStart() };
  }
  return null;
}
