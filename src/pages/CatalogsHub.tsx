/**
 * Hub listing all available observing catalog progress boards.
 * Route: /catalogs
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, ChevronRight } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { getCatalogProgress } from '../lib/api/catalogs';
import type { ObjectClass } from '../lib/api/catalogs';

const CATALOG_LIST: { id: string; label: string; description: string; total: number }[] = [
  {
    id: 'messier',
    label: 'Messier',
    description: 'Charles Messier\'s 1774 catalog of 110 nebulae and star clusters. The classic deep-sky checklist for visual and photographic observers.',
    total: 110,
  },
  {
    id: 'caldwell',
    label: 'Caldwell',
    description: 'Patrick Moore\'s 1995 catalog of 109 objects not found in the Messier list. Covers galaxies, nebulae, and clusters visible from both hemispheres.',
    total: 109,
  },
  {
    id: 'herschel400',
    label: 'Herschel 400',
    description: 'The Astronomical League\'s 400-object challenge drawn from William Herschel\'s historic discoveries. A rewarding step up from Messier for serious deep-sky observers.',
    total: 400,
  },
];

const TYPE_COLORS: Record<ObjectClass, string> = {
  galaxy:  'bg-violet-500',
  nebula:  'bg-cyan-500',
  cluster: 'bg-amber-500',
  other:   'bg-slate-500',
};

const TYPE_ORDER: ObjectClass[] = ['galaxy', 'nebula', 'cluster', 'other'];

function CatalogCard({
  id, label, description, total, isDark, isNight, isSpace,
}: {
  id: string;
  label: string;
  description: string;
  total: number;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
}) {
  const progressQuery = useQuery({
    queryKey: ['catalog-progress', id],
    queryFn: () => getCatalogProgress(id),
    staleTime: 60_000,
  });

  const progress = progressQuery.data;
  const imaged = progress?.imagedCount ?? 0;
  const pct = total > 0 ? Math.round((imaged / total) * 100) : 0;

  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-amber-400';
  const accentFill = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';

  const r = 28;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;

  return (
    <Link
      to={`/catalogs/${id}`}
      className={`group relative flex gap-5 items-center p-5 rounded-2xl border transition-all duration-200 hover:scale-[1.015] ${
        isDark
          ? 'bg-slate-900/70 border-slate-800 hover:border-slate-600 hover:bg-slate-900'
          : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-md'
      }`}
    >
      {/* Progress ring */}
      <div className="relative w-20 h-20 shrink-0">
        <svg viewBox="0 0 64 64" className="w-full h-full -rotate-90">
          <circle cx="32" cy="32" r={r} fill="none" strokeWidth="5" className={isDark ? 'stroke-slate-800' : 'stroke-slate-200'} />
          <circle
            cx="32" cy="32" r={r}
            fill="none"
            strokeWidth="5"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ stroke: accentFill, transition: 'stroke-dashoffset 0.7s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-lg font-display font-bold leading-none ${accentText}`}>{pct}%</span>
        </div>
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <h2 className={`text-lg font-display font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {label}
          </h2>
          <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {progress ? `${imaged} / ${total}` : `${total} objects`}
          </span>
        </div>
        <p className={`text-sm leading-snug ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          {description}
        </p>

        {/* Type breakdown mini-bars */}
        {progress && (
          <div className="flex items-center gap-1 mt-3">
            {TYPE_ORDER.map(cls => {
              const { imaged: im, total: tot } = progress.byType[cls];
              if (tot === 0) return null;
              return (
                <div key={cls} className="flex flex-col items-center gap-0.5">
                  <div className="w-8 h-1 rounded-full bg-slate-700/40 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${TYPE_COLORS[cls]}`}
                      style={{ width: `${(im / tot) * 100}%` }}
                    />
                  </div>
                  <span className={`text-[9px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                    {im}/{tot}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ChevronRight className={`w-5 h-5 shrink-0 transition-transform group-hover:translate-x-0.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
    </Link>
  );
}

export function CatalogsHub() {
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-amber-400';

  return (
    <div>
      <h1 className={`font-display text-3xl font-bold tracking-tight flex items-center gap-3 pb-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>
        <BookOpen className={`w-7 h-7 ${accentText}`} />
        Catalogs
      </h1>
      <p className={`text-sm mb-8 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        Track your imaging progress through classic observing programs.
      </p>

      <div className="space-y-4 max-w-2xl">
        {CATALOG_LIST.map(c => (
          <CatalogCard
            key={c.id}
            {...c}
            isDark={isDark}
            isNight={isNight}
            isSpace={isSpace}
          />
        ))}
      </div>
    </div>
  );
}
