/**
 * Banner at the top of a catalog board.
 *
 * The hub renders each program as a tall poster; this is the same treatment
 * turned on its side, so arriving on a board feels like walking through the
 * panel you clicked. Sky imagery under a scrim, the program's story, live
 * progress, and a type strip that doubles as the type filter.
 *
 * Like the hub panels, this sits on dark imagery in every theme, so it takes
 * the bright accent value directly rather than the light-mode-darkened token
 * and styles its own text white instead of branching on isDark.
 */
import { Link } from 'react-router-dom';
import { ChevronLeft, Images, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ByTypeStats, ObjectClass } from '../../lib/api/catalogs';
import type { CatalogMeta } from '../../lib/catalogMeta';
import { CatalogHeroImage } from './CatalogHeroImage';
import { useTheme } from '../../hooks/useTheme';
import { everyMember } from '../unionList';

interface Props {
  /** Undefined for a catalog slug we carry no editorial copy for. */
  meta: CatalogMeta | undefined;
  label: string;
  total: number;
  imagedCount: number;
  /** Part of imagedCount credited through another object's frame. */
  imagedInFrameCount?: number;
  byType: ByTypeStats;
  accent: string;
  typeFilter: ObjectClass | null;
  onTypeFilterChange: (cls: ObjectClass | null) => void;
  /** Null when the observer has no location set, or nothing is left to plan. */
  onPlan: (() => void) | null;
  /** Catalog slug, for the link to the user's own wall. */
  catalogId?: string;
}

const TYPE_META: Record<ObjectClass, { labelKey: string; dot: string }> = {
  galaxy:  { labelKey: 'objectClass.galaxy',  dot: '#a78bfa' },
  nebula:  { labelKey: 'objectClass.nebula',  dot: '#22d3ee' },
  cluster: { labelKey: 'objectClass.cluster', dot: '#fbbf24' },
  other:   { labelKey: 'objectClass.other',   dot: '#94a3b8' },
};

/** Same category dots, collapsed to a brightness-only red ladder for
 *  red-light mode — raw hex in a `style` prop, so .night's CSS variable
 *  overrides in index.css can't reach it. */
const NIGHT_TYPE_DOT: Record<ObjectClass, string> = {
  galaxy: '#dd3333',
  nebula: '#a02828',
  cluster: '#661a1a',
  other: '#4d1414',
};

const TYPE_ORDER = everyMember<ObjectClass>()(['galaxy', 'nebula', 'cluster', 'other']);

/**
 * Column count for the type strip. Written out as whole class names so
 * Tailwind's scanner sees them.
 */
const SM_COLS: Record<number, string> = {
  1: 'sm:grid-cols-1',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
};

/**
 * Divider borders for one type cell. Computed from the real index rather than
 * nth-child, because classes that never appear (a catalog with no "other"
 * objects) would otherwise leave a rule hanging off the end of a short row.
 */
function cellBorders(idx: number, count: number): string {
  const parts: string[] = [];
  // Two-column layout (mobile).
  if (idx % 2 === 0 && idx + 1 < count) parts.push('border-r');
  if (idx < count - (count % 2 === 0 ? 2 : 1)) parts.push('border-b');
  // Single-row layout from sm up.
  parts.push('sm:border-b-0');
  parts.push(idx < count - 1 ? 'sm:border-r' : 'sm:border-r-0');
  return parts.join(' ');
}

/** Wide crop, sized for the banner rather than the hub's portrait poster. */
const HERO_WIDTH = 1600;
const HERO_HEIGHT = 620;

const RING_RADIUS = 52;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function CatalogHero({
  meta, label, total, imagedCount, imagedInFrameCount = 0, byType,
  accent, typeFilter, onTypeFilterChange, onPlan, catalogId,
}: Props) {
  const { t } = useTranslation('catalogs');
  const { isNight } = useTheme();
  const pct = total > 0 ? Math.round((imagedCount / total) * 100) : 0;
  const remaining = total - imagedCount;
  const ringOffset = RING_CIRCUMFERENCE - (pct / 100) * RING_CIRCUMFERENCE;
  const visibleTypes = TYPE_ORDER.filter(cls => (byType[cls]?.total ?? 0) > 0);

  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel"
    >
      {/* Sky imagery */}
      <div className="absolute inset-0 overflow-hidden">
        <CatalogHeroImage
          ids={meta?.heroIds ?? []}
          width={HERO_WIDTH}
          height={HERO_HEIGHT}
          className="saturate-125 contrast-[1.08] brightness-[0.85] scale-105"
        />
      </div>

      {/* Scrim: keeps every line readable over any sky field */}
      <div className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/85 to-slate-950/45" />
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-transparent to-slate-950/40" />

      {/* Accent bloom behind the progress ring */}
      <div
        className="absolute inset-y-0 right-0 w-2/3 opacity-50"
        style={{ background: `radial-gradient(60% 90% at 78% 40%, ${accent}2e 0%, transparent 70%)` }}
      />

      {/* Hairline border */}
      <div
        className="absolute inset-0 rounded-3xl pointer-events-none"
        style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }}
      />

      <div className="relative flex flex-col gap-8 p-6 sm:p-8 lg:flex-row lg:items-end lg:justify-between lg:gap-12">

        {/* Story */}
        <div className="min-w-0 max-w-2xl">
          <Link
            to="/catalogs"
            className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] py-1 pl-1.5 pr-3
              text-[0.6875rem] font-medium text-white/70 ring-1 ring-inset ring-white/15 backdrop-blur-md
              transition-colors hover:bg-white/15 hover:text-white
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            {t('catalogHero.allCatalogs')}
          </Link>

          {meta && (
            <div className="mt-4 text-[0.6875rem] font-medium uppercase tracking-[0.18em] text-white/55">
              {meta.credit}
            </div>
          )}
          <h1 className="font-display text-4xl sm:text-5xl font-bold tracking-tight text-white mt-1.5">
            {label}
          </h1>
          {meta && (
            <p className="mt-3 text-[0.8125rem] sm:text-sm leading-relaxed text-white/70">
              {t(meta.taglineKey)}
            </p>
          )}
        </div>

        {/* Progress */}
        <div className="flex shrink-0 items-center gap-5 sm:gap-6">
          <div className="relative w-28 h-28 sm:w-32 sm:h-32 shrink-0">
            <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
              <circle
                cx="60" cy="60" r={RING_RADIUS}
                fill="none" strokeWidth="7"
                stroke="rgba(255,255,255,0.12)"
              />
              <circle
                cx="60" cy="60" r={RING_RADIUS}
                fill="none" strokeWidth="7"
                stroke={accent}
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={ringOffset}
                strokeLinecap="round"
                className="transition-all duration-700 ease-out"
                style={{ filter: `drop-shadow(0 0 7px ${accent}99)` }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span
                className="font-display text-2xl sm:text-3xl font-bold leading-none tabular-nums"
                style={{ color: accent, textShadow: `0 0 22px ${accent}59` }}
              >
                {pct}%
              </span>
              <span className="mt-1 text-[0.625rem] uppercase tracking-[0.14em] text-white/50">
                {t('catalogHero.imaged')}
              </span>
            </div>
          </div>

          <div className="min-w-0">
            <div className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-white tabular-nums leading-none">
              {imagedCount}
              <span className="text-xl sm:text-2xl font-medium text-white/40"> / {total}</span>
            </div>
            <div className="mt-2 text-[0.8125rem] text-white/65">
              {remaining === 0 ? t('catalogHero.programComplete') : t('catalogHero.stillToImage', { count: remaining })}
            </div>
            {imagedInFrameCount > 0 && (
              <div className="mt-1 text-[0.75rem] text-white/45">
                {t('catalogHero.inFrameNote', { count: imagedInFrameCount })}
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
            {catalogId && imagedCount > 0 && (
              <Link
                to={`/catalogs/${catalogId}/mine`}
                className="inline-flex items-center gap-2 rounded-full bg-white/[0.07] px-4 py-2
                  text-[0.8125rem] font-semibold text-white ring-1 ring-inset ring-white/15 backdrop-blur-md
                  transition-colors hover:bg-white/15
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <Images className="w-4 h-4" style={{ color: accent }} />
                {t('catalogHero.myCatalog', { label })}
              </Link>
            )}
            {onPlan && (
              <button
                onClick={onPlan}
                className="inline-flex items-center gap-2 rounded-full bg-white/[0.07] px-4 py-2
                  text-[0.8125rem] font-semibold text-white ring-1 ring-inset ring-white/15 backdrop-blur-md
                  transition-colors hover:bg-white/15
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                title={t('catalogHero.planTonightTitle', { label })}
              >
                <Sparkles className="w-4 h-4" style={{ color: accent }} />
                {t('catalogHero.planTonight')}
              </button>
            )}
            </div>
          </div>
        </div>
      </div>

      {/* Type strip. Each cell is also the filter for that object class. */}
      <div className={`relative grid grid-cols-2 ${SM_COLS[visibleTypes.length] ?? 'sm:grid-cols-4'} border-t border-white/10`}>
        {visibleTypes.map((cls, idx) => {
          const stats = byType[cls];
          const { labelKey: typeLabelKey, dot: dotColorLight } = TYPE_META[cls];
          const dot = isNight ? NIGHT_TYPE_DOT[cls] : dotColorLight;
          const typeLabel = t(typeLabelKey);
          const barPct = stats.total > 0 ? (stats.imaged / stats.total) * 100 : 0;
          const active = typeFilter === cls;

          return (
            <button
              key={cls}
              onClick={() => onTypeFilterChange(active ? null : cls)}
              aria-pressed={active}
              className={`group relative px-5 py-4 text-left transition-colors
                border-white/10 ${cellBorders(idx, visibleTypes.length)}
                ${active ? 'bg-white/[0.09]' : 'hover:bg-white/[0.05]'}
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/50`}
            >
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 shrink-0 rounded-full" style={{ background: dot }} />
                <span className={`text-[0.6875rem] font-medium ${active ? 'text-white' : 'text-white/60'}`}>
                  {typeLabel}
                </span>
                <span className="ml-auto text-[0.6875rem] tabular-nums text-white/45">
                  {stats.imaged}/{stats.total}
                </span>
              </div>
              <div className="mt-2.5 h-1 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${barPct}%`, background: dot, opacity: active ? 1 : 0.75 }}
                />
              </div>
              {/* Active cell reads as a selected tab */}
              <span
                className={`absolute inset-x-0 bottom-0 h-0.5 transition-opacity duration-200 ${active ? 'opacity-100' : 'opacity-0'}`}
                style={{ background: accent }}
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}
