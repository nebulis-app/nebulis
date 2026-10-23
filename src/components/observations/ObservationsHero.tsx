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
import { useTranslation } from 'react-i18next';
import { CalendarDays } from 'lucide-react';
import { CollapsibleHero, HeroSummary } from '../ui/CollapsibleHero';
import { PAGE_HERO } from '../../lib/heroImagery';
import type { MonthBucket, ObservationTotals } from '../../lib/observationStats';
import { formatDate, formatNumber } from '../../lib/formatLocale';
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
  return formatDate(new Date(y, m - 1, 1), { month: 'short', year: 'numeric' });
}

function spanLabel(totals: ObservationTotals, t: (key: string, opts?: Record<string, unknown>) => string): string | null {
  if (!totals.firstDate || !totals.lastDate) return null;
  const from = monthYear(totals.firstDate);
  const to = monthYear(totals.lastDate);
  return from === to ? from : t('hero.spanRange', { from, to });
}

export function ObservationsHero({
  totals, year, buckets, selectedMonth, onSelectMonth, onYearChange,
  yearsWithData, accent, filteredLabel,
}: Props) {
  const { t } = useTranslation('observations');
  const span = spanLabel(totals, t);

  const stats: { value: string; label: string }[] = [
    { value: formatNumber(totals.nights), label: t('hero.nights', { count: totals.nights }) },
    { value: formatNumber(totals.objects), label: t('hero.objects', { count: totals.objects }) },
    { value: formatNumber(totals.sessions), label: t('hero.sessions', { count: totals.sessions }) },
  ];
  if (totals.files > 0) {
    stats.push({ value: formatNumber(totals.files), label: t('hero.files') });
  }

  return (
    <CollapsibleHero
      page="observations"
      image={PAGE_HERO.observations}
      intensity={0.34}
      accent={accent}
      icon={<CalendarDays className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />}
      title={t('hero.title')}
      summary={totals.sessions === 0 ? undefined : <HeroSummary stats={stats} />}
      contentClassName="flex flex-col gap-7 p-4 sm:p-6 lg:flex-row lg:items-center lg:gap-10"
    >
        {/* The record */}
        <div className="min-w-0 lg:w-[38%] lg:shrink-0">
          <h1 className="font-display flex items-center gap-2.5 text-xl font-bold tracking-tight text-white sm:text-4xl">
            <CalendarDays className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />
            {t('hero.title')}
          </h1>

          <p className="mt-2 hidden text-[0.8125rem] text-white/55 sm:block">
            {totals.sessions === 0
              ? t('hero.emptyHint')
              : span}
            {filteredLabel && (
              <span className="text-white/40"> · {filteredLabel}</span>
            )}
          </p>

          {totals.sessions > 0 && (
            <div className="mt-5 hidden flex-wrap gap-x-8 gap-y-4 sm:flex">
              {stats.map(({ value, label }) => (
                <div key={label} className="min-w-0">
                  <div className="font-display text-2xl font-bold leading-none tracking-tight text-white tabular-nums">
                    {value}
                  </div>
                  <div className="mt-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-white/45">
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
    </CollapsibleHero>
  );
}
