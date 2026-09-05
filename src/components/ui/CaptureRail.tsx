/**
 * The session's headline numbers, ruled along the base of the hero.
 *
 * Same idea as the type strip under the catalog banner: the picture answers
 * "what did I get", this row answers "what did it cost". It replaces both the
 * old metrics tile grid and the separate Capture Settings card, which listed
 * four of the same values from a different source and could disagree with it.
 * The values themselves are rolled up in lib/captureMetrics.
 *
 * Lives on the hero, so it is white-on-dark in every theme.
 */
import type { CaptureMetric } from '../../lib/captureMetrics';

/**
 * Column count, written out as whole class names so Tailwind's scanner sees
 * them. Computed from the real count rather than left to auto-fit, so a session
 * with three metrics gets three even columns instead of three narrow ones and a
 * gap.
 */
const COLS: Record<number, string> = {
  1: 'sm:grid-cols-1',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
  5: 'sm:grid-cols-5',
  6: 'sm:grid-cols-3 lg:grid-cols-6',
  7: 'sm:grid-cols-4 lg:grid-cols-7',
  8: 'sm:grid-cols-4 lg:grid-cols-8',
};

export function CaptureRail({ metrics, accent }: { metrics: CaptureMetric[]; accent: string }) {
  if (metrics.length === 0) return null;

  return (
    <div className={`relative grid grid-cols-2 ${COLS[metrics.length] ?? 'sm:grid-cols-4'} border-y border-white/10`}>
      {metrics.map(({ key, value, label, hint, bar }, idx) => (
        <div
          key={key}
          className={`min-w-0 border-white/10 px-4 py-3.5 sm:px-5
            ${idx % 2 === 0 ? 'border-r' : ''} sm:border-r
            ${idx < metrics.length - (metrics.length % 2 === 0 ? 2 : 1) ? 'border-b' : ''} sm:border-b-0
            last:border-r-0`}
        >
          <div className="font-display truncate text-lg font-bold leading-none tracking-tight text-white tabular-nums">
            {value}
          </div>
          <div className="mt-1.5 truncate text-[10px] font-medium uppercase tracking-[0.14em] text-white/45">
            {label}
          </div>
          {hint && (
            <div className="mt-1 truncate text-[11px] tabular-nums text-white/40">{hint}</div>
          )}
          {bar != null && (
            <div
              className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"
              role="progressbar"
              aria-valuenow={bar}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${bar}% of attempted frames stacked`}
            >
              <div
                className="h-full rounded-full transition-all duration-700 ease-out"
                style={{ width: `${bar}%`, background: accent }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
