/**
 * A year of observing as twelve columns, which is also how you move around the
 * calendar.
 *
 * The month grid shows one month, and the chevrons beside its title gave no
 * clue whether the next one held anything. With nights spread over a couple of
 * years that meant clicking blind through empty months to find your own work.
 * Here the whole year is visible at once: bar height is nights out, the number
 * above it is the count, and clicking a column takes the calendar there. Empty
 * months stay in place, drawn as an empty slot rather than omitted, so the
 * spacing of a season reads honestly.
 *
 * Lives on the hero, so it is white-on-dark in every theme.
 */
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { MonthBucket } from '../../lib/observationStats';
import { monthLabels } from '../../lib/formatLocale';

/** Track height for the bars. Fixed, so a year with one busy month does not
 *  come out taller than a quiet one. */
const TRACK_HEIGHT = 56;
/** Floor so a month with a single night still reads as a mark rather than a
 *  hairline that looks like the empty track. */
const MIN_BAR = 5;

interface Props {
  year: number;
  buckets: MonthBucket[];
  /** Highlighted column, or null when the calendar is showing another year. */
  selectedMonth: number | null;
  onSelectMonth: (month: number) => void;
  onYearChange: (year: number) => void;
  /** Years that hold at least one observation, for the arrows' enabled state. */
  yearsWithData: number[];
  accent: string;
}

export function YearActivity({
  year, buckets, selectedMonth, onSelectMonth, onYearChange, yearsWithData, accent,
}: Props) {
  const { t } = useTranslation('observations');
  const peak = Math.max(1, ...buckets.map(b => b.nights));
  const yearTotal = buckets.reduce((sum, b) => sum + b.sessions, 0);
  const monthInitials = monthLabels('narrow');
  const monthNames = monthLabels('long');

  // Step to the next year that actually holds something, rather than walking
  // through empty ones.
  const earlier = yearsWithData.filter(y => y < year);
  const later = yearsWithData.filter(y => y > year);
  const prevYear = earlier.length ? earlier[earlier.length - 1] : null;
  const nextYear = later.length ? later[0] : null;

  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          {/* Rendered only when there is somewhere to go. A library that is all
              one year showed two permanently greyed arrows, which reads as a
              broken control rather than as "there is no other year". */}
          {prevYear != null && (
            <YearStep direction="prev" target={prevYear} onClick={() => onYearChange(prevYear)} />
          )}
          <span className="font-display min-w-[3.5rem] text-center text-sm font-semibold tabular-nums text-white">
            {year}
          </span>
          {nextYear != null && (
            <YearStep direction="next" target={nextYear} onClick={() => onYearChange(nextYear)} />
          )}
        </div>
        <span className="text-[0.6875rem] tabular-nums text-white/40">
          {yearTotal === 0
            ? t('yearActivity.nothingRecorded')
            : t('yearActivity.sessionsThisYear', { count: yearTotal })}
        </span>
      </div>

      {/* Height comes from the columns, not a guess. A fixed value here was
          shorter than the count + track + baseline + label actually stack to,
          so the columns overflowed upward and the counts collided with the
          year stepper above. */}
      <div className="flex items-end gap-1">
        {buckets.map(({ month, sessions, nights }) => {
          const active = selectedMonth === month;
          const height = nights === 0 ? 0 : Math.max(MIN_BAR, (nights / peak) * TRACK_HEIGHT);
          const label = nights === 0
            ? t('yearActivity.monthNothingRecorded', { month: monthNames[month], year })
            : t('yearActivity.monthSummary', {
                month: monthNames[month],
                year,
                nightsPart: t('yearActivity.nightsCount', { count: nights }),
                sessionsPart: t('yearActivity.sessionsCount', { count: sessions }),
              });

          return (
            <button
              key={month}
              onClick={() => onSelectMonth(month)}
              aria-pressed={active}
              aria-label={label}
              title={label}
              className="group flex min-w-0 flex-1 flex-col items-center gap-1.5 rounded-lg py-1
                outline-none transition-colors hover:bg-white/[0.04]
                focus-visible:ring-2 focus-visible:ring-white/50"
            >
              <span className={`text-[0.625rem] tabular-nums transition-colors ${
                nights === 0 ? 'text-transparent' : active ? 'text-white' : 'text-white/45 group-hover:text-white/75'
              }`}>
                {nights || 0}
              </span>

              {/* Bars sit on a baseline rather than inside a filled track. A
                  track dark enough to see is indistinguishable from a
                  full-height bar, which made every month with nothing in it
                  look like the busiest month of the year. */}
              <span className="flex w-full items-end justify-center" style={{ height: TRACK_HEIGHT }}>
                {height > 0 && (
                  <span
                    className="w-full rounded-t-[3px] transition-all duration-500 ease-out"
                    // The unselected bars used to be 45% accent, which was
                    // legible on a flat panel and turned to mud once artwork
                    // went behind it. They have to hold their own against a
                    // star field, so they carry most of the accent and the
                    // selected month separates on brightness plus its glow.
                    style={{
                      height,
                      background: active ? accent : `${accent}c4`,
                      boxShadow: active ? `0 0 16px ${accent}66` : undefined,
                    }}
                  />
                )}
              </span>

              <span
                className="h-px w-full transition-colors"
                style={{ background: active ? accent : 'rgba(255,255,255,0.22)' }}
              />

              <span className={`text-[0.625rem] font-medium transition-colors ${
                active ? 'text-white' : 'text-white/40 group-hover:text-white/70'
              }`}>
                {monthInitials[month]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function YearStep({ direction, target, onClick }: {
  direction: 'prev' | 'next';
  /** The year this steps to. Never null: the caller omits the control instead. */
  target: number;
  onClick: () => void;
}) {
  const { t } = useTranslation('observations');
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <button
      onClick={onClick}
      aria-label={t('yearActivity.goToYear', { year: target })}
      title={`${target}`}
      className="rounded-lg p-1 text-white/50 outline-none transition-colors
        hover:bg-white/10 hover:text-white
        focus-visible:ring-2 focus-visible:ring-white/50"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
