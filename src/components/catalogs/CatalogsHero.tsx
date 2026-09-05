/**
 * Banner for the Catalogs hub.
 *
 * The page is a grid of per-program progress panels, so the hero does not
 * repeat them. It answers the one thing the grid makes you add up in your
 * head: across every program, how far along are you? A progress ring on the
 * right carries that at a glance, with the two raw counts beside the title.
 *
 * Dark in every theme, matching the Catalogs panels themselves, the planner's
 * night hero and the observations record, which is why it takes the bright
 * `accent` hex directly rather than `accent-*` utilities and styles its own
 * text white.
 */
import { BookOpen } from 'lucide-react';
import { HeroBackdrop } from '../ui/HeroBackdrop';
import { PAGE_HERO } from '../../lib/heroImagery';

interface Props {
  /** Unique objects imaged across every program (payload already deduped on
   *  the shared NGC id, so a target in two catalogs counts once). */
  imaged: number;
  /** Unique objects across every program. */
  total: number;
  /** `imaged / total` as a whole percentage. */
  pct: number;
  /** False until every program's progress query has resolved. */
  loaded: boolean;
  accent: string;
}

/** Circular imaged/total gauge. The percentage sits in the middle because a
 *  ring on its own can't be read to any precision. */
function ProgressRing({ pct, accent }: { pct: number; accent: string }) {
  const r = 46;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <svg
      viewBox="0 0 112 112"
      className="h-24 w-24 shrink-0 sm:h-28 sm:w-28"
      role="img"
      aria-label={`${clamped}% of catalog objects imaged`}
    >
      <circle cx="56" cy="56" r={r} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="10" />
      <circle
        cx="56"
        cy="56"
        r={r}
        fill="none"
        stroke={accent}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped / 100)}
        transform="rotate(-90 56 56)"
        style={{ transition: 'stroke-dashoffset 700ms ease-out' }}
      />
      <text
        x="56"
        y="56"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#fff"
        fontSize="23"
        className="font-display font-bold tabular-nums"
      >
        {clamped}%
      </text>
    </svg>
  );
}

export function CatalogsHero({ imaged, total, pct, loaded, accent }: Props) {
  const stats: { value: string; label: string }[] = [
    { value: imaged.toLocaleString(), label: 'Imaged' },
    { value: total.toLocaleString(), label: 'Catalog objects' },
  ];

  return (
    <section className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel">
      <HeroBackdrop image={PAGE_HERO.catalogs} />

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

      <div className="relative flex min-h-[9.5rem] flex-col justify-center gap-6 p-5 sm:min-h-[11.5rem] sm:flex-row sm:items-center sm:justify-between sm:p-7">
        <div className="min-w-0">
          <h1 className="font-display flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            <BookOpen className="h-6 w-6 sm:h-7 sm:w-7" style={{ color: accent }} />
            Catalogs
          </h1>
          <p className="mt-2 text-[13px] text-white/55">
            Track your imaging progress through classic observing programs.
          </p>

          {loaded && (
            <div className="mt-6 flex flex-wrap items-end gap-x-12 gap-y-4 sm:gap-x-16">
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

        {loaded && <ProgressRing pct={pct} accent={accent} />}
      </div>
    </section>
  );
}
