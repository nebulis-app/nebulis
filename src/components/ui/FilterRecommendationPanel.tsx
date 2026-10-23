/**
 * Filter recommendation UI: the chips for one catalog object, derived from the
 * object's type.
 *
 * Two shapes, one source of truth:
 *   - `FilterRecommendationPanel` — the two-row grid (color rig, mono rig)
 *     used where there is room, such as the catalog object popup and Object
 *     Detail.
 *   - `FilterRecommendationChip` — a one-line variant for tight surfaces such
 *     as the Planner target list.
 *
 * Rendering only. Neither fetches anything or holds state; the caller computes
 * the pair with `filterRecommendations(object.type)` from
 * `src/lib/filterRecommendations.ts`. That keeps the rule table reusable from
 * any surface while the wording stays in `catalogs.json` where the other three
 * languages can see it.
 */
import { useTranslation } from 'react-i18next';
import {
  isFilterRecommendationKey,
  type FilterRecommendation,
  type FilterRecommendationKey,
} from '../../lib/filterRecommendations';

const CHIP_BASE = 'inline-flex items-center rounded-full border font-medium leading-none whitespace-nowrap';
const CHIP_SIZE = 'px-2.5 py-1 text-xs';
const CHIP_SIZE_COMPACT = 'px-2 py-0.5 text-[0.625rem]';

/** Per-key chip palettes, following the light/dark convention FitBadge uses:
 *  muted slate for the broadband keys, a saturated hue per narrowband set so
 *  the two rigs are told apart quickly. */
const KEY_STYLE: Record<FilterRecommendationKey, { light: string; dark: string }> = {
  'no-filter': {
    light: 'bg-slate-100 text-slate-600 border-slate-200',
    dark: 'bg-slate-800 text-slate-400 border-slate-700',
  },
  'no-filter-lrgb': {
    light: 'bg-slate-100 text-slate-600 border-slate-200',
    dark: 'bg-slate-800 text-slate-400 border-slate-700',
  },
  'lrgb': {
    light: 'bg-sky-50 text-sky-700 border-sky-200',
    dark: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  },
  'luminance': {
    light: 'bg-slate-50 text-slate-600 border-slate-300',
    dark: 'bg-slate-700/60 text-slate-300 border-slate-600',
  },
  'ha-dual': {
    light: 'bg-rose-50 text-rose-700 border-rose-200',
    dark: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  },
  'ha-oiii': {
    light: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200',
    dark: 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20',
  },
  'oiii-ha': {
    light: 'bg-cyan-50 text-cyan-700 border-cyan-200',
    dark: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  },
  'sho': {
    light: 'bg-amber-50 text-amber-700 border-amber-200',
    dark: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  },
};

/** Worn by a key this build does not know about, so an unrecognised chip is
 *  still styled rather than crashing on an undefined palette. */
const FALLBACK_STYLE = KEY_STYLE['no-filter-lrgb'];

/** The subset of react-i18next's `t` this module's plain helpers need. */
type TFunc = (key: string, opts?: Record<string, unknown>) => string;

interface ResolvedChip {
  style: { light: string; dark: string };
  label: string;
  short: string;
  rationale: string;
}

/**
 * Resolve one recommendation key to its palette and its copy.
 *
 * `filterKey` is a plain string on purpose. Every chip rendered today carries
 * a valid key, but this is the obvious landing spot for a recommendation that
 * arrives over the API later, and an unknown key must degrade to the generic
 * entry instead of indexing KEY_STYLE and throwing on `style.dark` mid-render.
 */
function resolveChip(t: TFunc, filterKey: string): ResolvedChip {
  const known = isFilterRecommendationKey(filterKey) ? filterKey : null;
  const base = known ? `filterRecommendations.keys.${known}` : 'filterRecommendations.unknown';
  return {
    style: known ? KEY_STYLE[known] : FALLBACK_STYLE,
    label: t(`${base}.label`),
    short: t(`${base}.short`),
    rationale: t(`${base}.rationale`),
  };
}

interface RecommendationChipProps {
  filterKey: string;
  isDark: boolean;
  /** Use the short label, for the one-row layout. */
  short?: boolean;
}

function RecommendationChip({ filterKey, isDark, short = false }: RecommendationChipProps) {
  const { t } = useTranslation('catalogs');
  const chip = resolveChip(t, filterKey);
  // `justify-self-start` matters: this chip is a grid item in the panel's
  // two-column grid, and a grid item stretches to fill its cell on the inline
  // axis by default. Without it the pill ran the whole width of its column,
  // which on the object hero meant the full width of the panel.
  return (
    <span
      title={chip.rationale}
      className={`${CHIP_BASE} ${CHIP_SIZE} justify-self-start ${isDark ? chip.style.dark : chip.style.light}`}
    >
      {short ? chip.short : chip.label}
    </span>
  );
}

interface FilterRecommendationPanelProps {
  recommendations: FilterRecommendation;
  isDark: boolean;
  /** Extra class(es) on the container, for spacing where it is dropped in. */
  className?: string;
  /** Drop the boxed surface and padding, for sitting directly on a background
   *  the caller already provides (the object hero). */
  bare?: boolean;
  /** Heading and both rigs on one wrapping row with the short chip labels,
   *  for a panel where three rows would set its height (the object hero). */
  inline?: boolean;
}

export function FilterRecommendationPanel({
  recommendations,
  isDark,
  className = '',
  bare = false,
  inline = false,
}: FilterRecommendationPanelProps) {
  const { t } = useTranslation('catalogs');
  if (inline) {
    const rigClass = `text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`;
    return (
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 ${className}`}>
        <span className={`mr-1 text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          {t('filterRecommendations.heading')}
        </span>
        <span className={rigClass}>{t('filterRecommendations.colorRig')}</span>
        <RecommendationChip filterKey={recommendations.color} isDark={isDark} short />
        <span className={`ml-1 ${rigClass}`}>{t('filterRecommendations.monoRig')}</span>
        <RecommendationChip filterKey={recommendations.mono} isDark={isDark} short />
      </div>
    );
  }
  const rigLabelClass = `text-xs font-medium shrink-0 ${isDark ? 'text-slate-400' : 'text-slate-500'}`;
  const surfaceClass = bare ? '' : `rounded-xl p-4 ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`;

  return (
    <div className={`${surfaceClass} ${className}`}>
      <p className={`text-xs font-medium mb-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        {t('filterRecommendations.heading')}
      </p>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        <span className={rigLabelClass}>{t('filterRecommendations.colorRig')}</span>
        <RecommendationChip filterKey={recommendations.color} isDark={isDark} />

        <span className={rigLabelClass}>{t('filterRecommendations.monoRig')}</span>
        <RecommendationChip filterKey={recommendations.mono} isDark={isDark} />
      </div>
    </div>
  );
}

interface FilterRecommendationChipProps {
  recommendations: FilterRecommendation;
  isDark: boolean;
  className?: string;
}

/**
 * One-line variant: the color and mono short labels either side of a slash.
 * Both rigs are spelled out in the tooltip, since a list row has no space for
 * the two-row grid. The order matches the panel's, color first.
 */
export function FilterRecommendationChip({
  recommendations,
  isDark,
  className = '',
}: FilterRecommendationChipProps) {
  const { t } = useTranslation('catalogs');
  const color = resolveChip(t, recommendations.color);
  const mono = resolveChip(t, recommendations.mono);
  const colorRig = t('filterRecommendations.colorRig');
  const monoRig = t('filterRecommendations.monoRig');
  const detail = `${colorRig}: ${color.label}. ${color.rationale}\n${monoRig}: ${mono.label}. ${mono.rationale}`;

  return (
    <span
      title={detail}
      aria-label={`${t('filterRecommendations.heading')}. ${detail}`}
      className={`${CHIP_BASE} ${CHIP_SIZE_COMPACT} ${isDark ? FALLBACK_STYLE.dark : FALLBACK_STYLE.light} ${className}`}
    >
      {color.short}
      {/* Separator between the two rigs, not copy: kept as an expression so the
          no-hardcoded-jsx-text rule stays meaningful for real strings. */}
      {' / '}
      {mono.short}
    </span>
  );
}
