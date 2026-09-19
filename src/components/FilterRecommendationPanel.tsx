/**
 * Filter recommendation panel — shows color-rig and mono-rig filter
 * suggestions derived from the object's type.
 *
 * Kept as a separate component so it can be reused wherever catalog detail
 * info is rendered (CatalogObjectModal, a future object-detail page info card,
 * etc.) without coupling to any specific page layout.
 *
 * Rendering logic only — no state, no data-fetching.  The recommendation
 * values come from the `CatalogObjectInfo.filterRecommendations` field
 * already attached by the server's /info route.
 */
import type { FilterRecommendation, FilterRecommendationKey } from '../lib/filterRecommendations';
import { FILTER_RECOMMENDATION_META } from '../lib/filterRecommendations';

// ─── Per-key colour palette ───────────────────────────────────────────────────

/** Two-tone palettes: subtle chip for the "No filter" group, richer for
 *  narrowband keys.  Light/dark variants follow FitBadge's convention. */
const KEY_STYLE: Record<FilterRecommendationKey, { light: string; dark: string }> = {
  'no-filter': {
    light: 'bg-slate-100 text-slate-600 border-slate-200',
    dark:  'bg-slate-800 text-slate-400 border-slate-700',
  },
  'no-filter-lrgb': {
    light: 'bg-slate-100 text-slate-600 border-slate-200',
    dark:  'bg-slate-800 text-slate-400 border-slate-700',
  },
  'lrgb': {
    light: 'bg-sky-50 text-sky-700 border-sky-200',
    dark:  'bg-sky-500/10 text-sky-400 border-sky-500/20',
  },
  'luminance': {
    light: 'bg-slate-50 text-slate-600 border-slate-300',
    dark:  'bg-slate-700/60 text-slate-300 border-slate-600',
  },
  'ha-dual': {
    light: 'bg-rose-50 text-rose-700 border-rose-200',
    dark:  'bg-rose-500/10 text-rose-400 border-rose-500/20',
  },
  'ha-oiii': {
    light: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200',
    dark:  'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20',
  },
  'oiii-ha': {
    light: 'bg-cyan-50 text-cyan-700 border-cyan-200',
    dark:  'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  },
  'sho': {
    light: 'bg-amber-50 text-amber-700 border-amber-200',
    dark:  'bg-amber-500/10 text-amber-400 border-amber-500/20',
  },
};

interface RecommendationChipProps {
  filterKey: FilterRecommendationKey;
  isDark: boolean;
}

function RecommendationChip({ filterKey, isDark }: RecommendationChipProps) {
  const meta = FILTER_RECOMMENDATION_META[filterKey];
  const style = KEY_STYLE[filterKey];
  return (
    <span
      title={meta.rationale}
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium leading-none whitespace-nowrap ${
        isDark ? style.dark : style.light
      }`}
    >
      {meta.label}
    </span>
  );
}

interface FilterRecommendationPanelProps {
  recommendations: FilterRecommendation;
  isDark: boolean;
  /** Extra class(es) on the container — use for spacing adjustments. */
  className?: string;
}

export function FilterRecommendationPanel({
  recommendations,
  isDark,
  className = '',
}: FilterRecommendationPanelProps) {
  return (
    <div
      className={`rounded-xl p-4 ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'} ${className}`}
    >
      <p className={`text-xs font-medium mb-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        Filter recommendations
      </p>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        {/* Color rig row */}
        <span className={`text-xs font-medium shrink-0 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Color
        </span>
        <RecommendationChip filterKey={recommendations.color} isDark={isDark} />

        {/* Mono rig row */}
        <span className={`text-xs font-medium shrink-0 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Mono
        </span>
        <RecommendationChip filterKey={recommendations.mono} isDark={isDark} />
      </div>
    </div>
  );
}
