/**
 * Banner for the library.
 *
 * The page used to open on a bare title, then jump straight to the object grid.
 * What was missing was the shape of the collection itself: how many objects,
 * how many nights they came from, and what kind of sky they are.
 *
 * Text only, deliberately. This carried a contact sheet of the four most
 * recently imported objects, which sat directly above a grid of those same
 * objects at a larger size: the banner and the page under it were showing the
 * same pictures, and the smaller copy won nothing. The stats are what the grid
 * cannot tell you at a glance, so they are all that is left here.
 *
 * Dark in every theme, matching the Catalogs panels, the planner's night hero
 * and the observations record, which is also why it takes the bright `accent`
 * hex directly rather than `accent-*` utilities and styles its own text white.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Library } from 'lucide-react';
import { CollapsibleHero, HeroSummary } from '../ui/CollapsibleHero';
import { PAGE_HERO } from '../../lib/heroImagery';
import type { AstroObject } from '../../types';
import { formatDate, formatRelativeDuration, formatNumber } from '../../lib/formatLocale';
import { classOfType, type ObjectClass } from '../../lib/objectCategories';
import { useTheme } from '../../hooks/useTheme';

interface Props {
  /** Objects the hero describes. Already narrowed by the telescope facet so the
   *  counts match what `filteredLabel` claims; search and type chips do not
   *  touch it, so the numbers describe the whole library, not the current view. */
  objects: AstroObject[];
  accent: string;
  /** Set when a telescope facet is active, so the counts read honestly. */
  filteredLabel: string | null;
}

/** i18next plural key per coarse class, resolved with `t(key, { count })` at
 *  render time — a module-level array can't call useTranslation() itself. */
const CLASS_META: Record<ObjectClass, { key: string; dot: string }> = {
  galaxy:  { key: 'libraryHero.class.galaxy',  dot: '#a78bfa' },
  nebula:  { key: 'libraryHero.class.nebula',  dot: '#22d3ee' },
  cluster: { key: 'libraryHero.class.cluster', dot: '#fbbf24' },
};

/** Same class dots, collapsed to a brightness-only red ladder for red-light
 *  mode — raw hex in a `style` prop, so .night's CSS variable overrides in
 *  index.css can't reach it. */
const NIGHT_CLASS_DOT: Record<ObjectClass, string> = {
  galaxy: '#dd3333',
  nebula: '#a02828',
  cluster: '#661a1a',
};

/** Display order for the class breakdown. Deliberately separate from the shared
 *  module's precedence order: this is how the chips are laid out, not which
 *  family wins when a type belongs to two. */
const BREAKDOWN_ORDER: readonly ObjectClass[] = ['galaxy', 'nebula', 'cluster'];

/**
 * The most recent capture date, as something you read rather than parse.
 *
 * Answers the question the raw counts cannot: is any of this recent? A library
 * that has not grown in three months should say so plainly, and one you added
 * to last night should feel current.
 */
function lastNightLabel(date: string, t: (key: string) => string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  // Constructed local, not parsed from the ISO string: `new Date('2026-08-11')`
  // is UTC midnight and reads as the 10th west of Greenwich.
  const then = new Date(y, m - 1, d);
  const today = new Date();
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - then.getTime())
    / 86_400_000,
  );
  // See objectStats.ts's nightsAgo for why 'Tonight'/'Yesterday'/'Last week'
  // stay short domain phrases while the numeric buckets go through
  // Intl.RelativeTimeFormat (via formatRelativeDuration).
  if (days <= 0) return t('libraryHero.lastNight.tonight');
  if (days === 1) return t('libraryHero.lastNight.yesterday');
  if (days < 7) return formatRelativeDuration(days, 'day');
  if (days < 14) return t('libraryHero.lastNight.lastWeek');
  if (days < 60) return formatRelativeDuration(Math.round(days / 7), 'week');
  return formatDate(then, { month: 'short', year: 'numeric' });
}

export function LibraryHero({ objects, accent, filteredLabel }: Props) {
  const { t } = useTranslation('library');
  const { isNight } = useTheme();
  const { total, observations, favorites, breakdown, lastNight } = useMemo(() => {
    let obs = 0;
    let favs = 0;
    let last: string | null = null;
    const counts: Record<ObjectClass, number> = { galaxy: 0, nebula: 0, cluster: 0 };
    for (const o of objects) {
      obs += o.sessionCount ?? 0;
      if (o.isFavorite) favs += 1;
      const cls = classOfType(o.type);
      if (cls) counts[cls] += 1;
      // `YYYY-MM-DD` compares lexicographically in date order.
      if (o.lastSessionDate && (last === null || o.lastSessionDate > last)) last = o.lastSessionDate;
    }
    return {
      total: objects.length,
      observations: obs,
      favorites: favs,
      breakdown: BREAKDOWN_ORDER
        .filter(c => counts[c] > 0)
        .map(c => ({ cls: c, count: counts[c] })),
      lastNight: last,
    };
  }, [objects]);

  const empty = total === 0;

  // `prose` marks a value that is words rather than a figure. One step down
  // from the number size (not all the way to text-base, which read as a
  // caption next to the figures rather than a peer stat).
  const stats: { value: string; label: string; prose?: boolean }[] = [
    { value: formatNumber(total), label: t('libraryHero.stats.objects', { count: total }) },
    { value: formatNumber(observations), label: t('libraryHero.stats.observations', { count: observations }) },
  ];
  if (favorites > 0) stats.push({ value: formatNumber(favorites), label: t('libraryHero.stats.favorites') });
  if (lastNight) stats.push({ value: lastNightLabel(lastNight, t), label: t('libraryHero.stats.lastObservation'), prose: true });

  return (
    <CollapsibleHero
      page="library"
      image={PAGE_HERO.library}
      accent={accent}
      icon={<Library className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />}
      title={t('libraryHero.title')}
      summary={empty ? undefined : <HeroSummary stats={stats} />}
      contentClassName="flex hero-min-h flex-col justify-center p-4 sm:p-6"
    >
        {/* The collection. Held to a share of the width on a wide screen so the
            artwork behind has somewhere to be seen. */}
        <div className="min-w-0 lg:max-w-[52%]">
          <h1 className="font-display flex items-center gap-2.5 text-xl font-bold tracking-tight text-white sm:text-4xl">
            <Library className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />
            {t('libraryHero.title')}
          </h1>

          {/* The breakdown/count line and the stat row below both restate
              numbers the object grid shows on the very next scroll, so on a
              phone they cost more space than they earn: hidden there, the
              title alone leaves room for the grid to start immediately. */}
          <p className="mt-2 hidden text-[0.8125rem] text-white/55 sm:block">
            {empty ? (
              t('libraryHero.emptyHint')
            ) : (
              <>
                {breakdown.length > 0 ? (
                  <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 align-middle">
                    {breakdown.map(({ cls, count }) => (
                      <span key={cls} className="inline-flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: isNight ? NIGHT_CLASS_DOT[cls] : CLASS_META[cls].dot }} />
                        <span className="tabular-nums text-white/70">{count}</span>
                        <span>{t(CLASS_META[cls].key, { count })}</span>
                      </span>
                    ))}
                  </span>
                ) : (
                  t('libraryHero.allCaptured')
                )}
                {filteredLabel && <span className="text-white/40"> · {filteredLabel}</span>}
              </>
            )}
          </p>

          {!empty && (
            <div className="mt-6 hidden flex-wrap items-end gap-x-12 gap-y-4 sm:flex sm:gap-x-16">
              {stats.map(({ value, label, prose }) => (
                <div key={label} className="min-w-0">
                  <div className={`font-display font-bold leading-none tracking-tight text-white ${
                    prose ? 'text-xl' : 'text-2xl tabular-nums'
                  }`}>
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

    </CollapsibleHero>
  );
}
