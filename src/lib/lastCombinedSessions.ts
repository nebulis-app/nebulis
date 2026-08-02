/**
 * One-shot handoff from CombineSubframesModal (export subframes for external
 * stacking) to UploadProcessedModal (bring the result back in). The user
 * already told the app which nights they were combining once; remembering it
 * here means they don't have to repeat that selection when they come back to
 * upload the stacked result. Consumed once, then cleared — not a sticky
 * default.
 */
const PREFIX = 'nebulis:lastCombinedSessions:';

export function rememberCombinedSessions(objectId: string, dates: string[]): void {
  try {
    sessionStorage.setItem(PREFIX + objectId, JSON.stringify(dates));
  } catch { /* best-effort */ }
}

export function consumeCombinedSessions(objectId: string): string[] | null {
  const key = PREFIX + objectId;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    sessionStorage.removeItem(key);
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : null;
  } catch {
    return null;
  }
}
