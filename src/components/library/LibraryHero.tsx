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
import { Library } from 'lucide-react';
import { HeroBackdrop } from '../ui/HeroBackdrop';
import { PAGE_HERO } from '../../lib/heroImagery';
import type { AstroObject } from '../../types';

interface Props {
  /** Objects the hero describes. Already narrowed by the telescope facet so the
   *  counts match what `filteredLabel` claims; search and type chips do not
   *  touch it, so the numbers describe the whole library, not the current view. */
  objects: AstroObject[];
  accent: string;
  /** Set when a telescope facet is active, so the counts read honestly. */
  filteredLabel: string | null;
}

type CoarseClass = 'galaxy' | 'nebula' | 'cluster';

const CLASS_META: Record<CoarseClass, { label: string; plural: string; dot: string }> = {
  galaxy:  { label: 'galaxy',  plural: 'galaxies', dot: '#a78bfa' },
  nebula:  { label: 'nebula',  plural: 'nebulae',  dot: '#22d3ee' },
  cluster: { label: 'cluster', plural: 'clusters', dot: '#fbbf24' },
};

/** Display order for the class breakdown. Declared with an explicit element
 *  type so the literals are checked against CoarseClass instead of asserted. */
const BREAKDOWN_ORDER: readonly CoarseClass[] = ['galaxy', 'nebula', 'cluster'];

/** Bucket a raw catalog type into one of the three coarse classes, or null for
 *  everything else (double stars, asterisms, dark nebulae we don't want to
 *  mislabel as emission nebulae, etc.). Kept deliberately small. */
function classOf(type: string): CoarseClass | null {
  const t = type.toLowerCase();
  if (t.includes('galax')) return 'galaxy';
  if (t.includes('cluster')) return 'cluster';
  if (t.includes('nebula')) return 'nebula';
  return null;
}

/**
 * The most recent capture date, as something you read rather than parse.
 *
 * Answers the question the raw counts cannot: is any of this recent? A library
 * that has not grown in three months should say so plainly, and one you added
 * to last night should feel current.
 */
function lastNightLabel(date: string): string {
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
  if (days <= 0) return 'Tonight';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'Last week';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return then.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

export function LibraryHero({ objects, accent, filteredLabel }: Props) {
  const { total, observations, favorites, breakdown, lastNight } = useMemo(() => {
    let obs = 0;
    let favs = 0;
    let last: string | null = null;
    const counts: Record<CoarseClass, number> = { galaxy: 0, nebula: 0, cluster: 0 };
    for (const o of objects) {
      obs += o.sessionCount ?? 0;
      if (o.isFavorite) favs += 1;
      const cls = classOf(o.type);
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
    { value: total.toLocaleString(), label: total === 1 ? 'Object' : 'Objects' },
    { value: observations.toLocaleString(), label: observations === 1 ? 'Observation' : 'Observations' },
  ];
  if (favorites > 0) stats.push({ value: favorites.toLocaleString(), label: 'Favorites' });
  if (lastNight) stats.push({ value: lastNightLabel(lastNight), label: 'Last Observation', prose: true });

  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel"
    >
      <HeroBackdrop image={PAGE_HERO.library} />

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

      {/* min-height, not more padding: the artwork needs a band tall enough to
          read as a nebula rather than a smear, and the stats do not fill it. */}
      <div className="relative flex min-h-[9.5rem] flex-col justify-center p-5 sm:min-h-[11.5rem] sm:p-7">
        {/* The collection. Held to a share of the width on a wide screen so the
            artwork behind has somewhere to be seen. */}
        <div className="min-w-0 lg:max-w-[52%]">
          <h1 className="font-display flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            <Library className="h-6 w-6 sm:h-7 sm:w-7" style={{ color: accent }} />
            Library
          </h1>

          <p className="mt-2 text-[13px] text-white/55">
            {empty ? (
              'Nothing here yet. Objects appear once your telescope images are imported.'
            ) : (
              <>
                {breakdown.length > 0 ? (
                  <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 align-middle">
                    {breakdown.map(({ cls, count }) => (
                      <span key={cls} className="inline-flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: CLASS_META[cls].dot }} />
                        <span className="tabular-nums text-white/70">{count}</span>
                        <span>{count === 1 ? CLASS_META[cls].label : CLASS_META[cls].plural}</span>
                      </span>
                    ))}
                  </span>
                ) : (
                  'Everything you have captured, in one place.'
                )}
                {filteredLabel && <span className="text-white/40"> · {filteredLabel}</span>}
              </>
            )}
          </p>

          {!empty && (
            <div className="mt-6 flex flex-wrap items-end gap-x-12 gap-y-4 sm:gap-x-16">
              {stats.map(({ value, label, prose }) => (
                <div key={label} className="min-w-0">
                  <div className={`font-display font-bold leading-none tracking-tight text-white ${
                    prose ? 'text-xl' : 'text-2xl tabular-nums'
                  }`}>
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

      </div>
    </section>
  );
}
