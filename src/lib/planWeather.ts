import type { PlanWeatherSummary } from './planTypes';

/** Merge back-to-back skipped slots into ranges for the preview note. */
export function mergeSkipped(slots: PlanWeatherSummary['skippedSlots']): { start: Date; end: Date; cloudCover: number }[] {
  const out: { start: Date; end: Date; cloudCover: number }[] = [];
  for (const s of [...slots].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const last = out[out.length - 1];
    if (last && last.end.getTime() >= s.start.getTime()) {
      last.end = new Date(Math.max(last.end.getTime(), s.end.getTime()));
      last.cloudCover = Math.max(last.cloudCover, s.cloudCover);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}
