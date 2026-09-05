/**
 * Banner for the observing record.
 *
 * The page used to open on a bare title and a month grid that, for most
 * libraries, is mostly empty cells. What was missing was the shape of the
 * record itself: how many nights, over how long, and when. That is what this
 * answers, and the year chart beside it is also how you move the calendar
 * around (see YearActivity).
 *
 * Dark in every theme, matching the Catalogs panels, the planner's night hero
 * and the observation page, which is also why it takes the bright `accent` hex
 * directly rather than `accent-*` utilities.
 */
import { CalendarDays } from 'lucide-react';
import { HeroBackdrop } from '../ui/HeroBackdrop';
import { PAGE_HERO } from '../../lib/heroImagery';
import type { MonthBucket, ObservationTotals } from '../../lib/observationStats';
import { YearActivity } from './YearActivity';

interface Props {
  totals: ObservationTotals;
  year: number;
  buckets: MonthBucket[];
  /** Highlighted column, or null when the calendar is on a different year. */
  selectedMonth: number | null;
  onSelectMonth: (month: number) => void;
  onYearChange: (year: number) => void;
  yearsWithData: number[];
  accent: string;
  /** Whether the counts are narrowed by the telescope filter, which changes
   *  what the numbers honestly describe. */
  filteredLabel: string | null;
}

/** `YYYY-MM-DD` as "Mar 2024", for the span line. */
function monthYear(date: string): string {
  const [y, m] = date.split('-').map(Number);
  if (!y || !m) return date;
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function spanLabel(totals: ObservationTotals): string | null {
  if (!totals.firstDate || !totals.lastDate) return null;
  const from = monthYear(totals.firstDate);
  const to = monthYear(totals.lastDate);
  return from === to ? from : `${from} to ${to}`;
}

export function ObservationsHero({
  totals, year, buckets, selectedMonth, onSelectMonth, onYearChange,
  yearsWithData, accent, filteredLabel,
}: Props) {
  const span = spanLabel(totals);

  const stats: { value: string; label: string }[] = [
    { value: totals.nights.toLocaleString(), label: totals.nights === 1 ? 'Night out' : 'Nights out' },
    { value: totals.objects.toLocaleString(), label: totals.objects === 1 ? 'Object' : 'Objects' },
    { value: totals.sessions.toLocaleString(), label: totals.sessions === 1 ? 'Session' : 'Sessions' },
  ];
  if (totals.files > 0) {
    stats.push({ value: totals.files.toLocaleString(), label: 'Files' });
  }

  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel"
    >
      {/* Lower than the Library banner's: the year chart sits over the right
          half of this one, and its bars have to stay readable. */}
      <HeroBackdrop image={PAGE_HERO.observations} intensity={0.34} />

      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: `radial-gradient(90% 140% at 8% 0%, ${accent}1f 0%, transparent 60%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{ background: `radial-gradient(70% 130% at 95% 100%, ${accent}14 0%, transparent 62%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-3xl"
        style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }}
      />

      <div className="relative flex flex-col gap-7 p-5 sm:p-7 lg:flex-row lg:items-center lg:gap-10">
        {/* The record */}
        <div className="min-w-0 lg:w-[38%] lg:shrink-0">
          <h1 className="font-display flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            <CalendarDays className="h-6 w-6 sm:h-7 sm:w-7" style={{ color: accent }} />
            Observations
          </h1>

          <p className="mt-2 text-[13px] text-white/55">
            {totals.sessions === 0
              ? 'Nothing recorded yet. Sessions appear here once your telescope images are imported.'
              : span}
            {filteredLabel && (
              <span className="text-white/40"> · {filteredLabel}</span>
            )}
          </p>

          {totals.sessions > 0 && (
            <div className="mt-5 flex flex-wrap gap-x-8 gap-y-4">
              {stats.map(({ value, label }) => (
                <div key={label} className="min-w-0">
                  <div className="font-display text-2xl font-bold leading-none tracking-tight text-white tabular-nums">
                    {value}
                  </div>
                  <div className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-white/45">
                    {label}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* The year, which is also the navigation */}
        <div className="min-w-0 flex-1">
          <YearActivity
            year={year}
            buckets={buckets}
            selectedMonth={selectedMonth}
            onSelectMonth={onSelectMonth}
            onYearChange={onYearChange}
            yearsWithData={yearsWithData}
            accent={accent}
          />
        </div>
      </div>
    </section>
  );
}
