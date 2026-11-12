import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Filter, Grid3x3, ImagePlus, LayoutGrid, ScanSearch, SlidersHorizontal, Star } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useSunWording } from './solarObjectContext';
import { nightSafeColor } from '../../lib/nightSafeColor';
import { formatDate } from '../../lib/formatLocale';
import { TOOLBAR_BTN, popoverSurface } from '../filters/toolbarStyles';
import { ActiveFilterChips, FilterSection, Pill, PopoverResetButton, type ActiveChip } from '../filters/toolbarParts';
import type { ObjectMedia } from '../../lib/api/library';
import { MEDIA_GROUPS, MEDIA_SORTS, MEDIA_TABS, defaultGroupFor, type MediaCounts, type MediaViewState } from './useObjectMedia';
import { TILE_DEFAULT, TILE_MAX, TILE_MIN, TILE_STEP, type TileSize } from './tileSizing';

interface Props {
  state: MediaViewState;
  update: (patch: Partial<MediaViewState>) => void;
  clearFilters: () => void;
  activeFilterCount: number;
  counts: MediaCounts | undefined;
  facets: ObjectMedia['facets'] | undefined;
  size: TileSize;
  onSizeChange: (size: TileSize) => void;
  /** Admin only: opens the file picker for a processed-image upload. */
  onUpload: (() => void) | null;
  /** Admin only: opens the frame review on the Subframes tab, where it takes the place of Add image. */
  onReview: (() => void) | null;
}

export function MediaTabs({ state, update, counts, isAdmin, solar = false, trailing }: Pick<Props, 'state' | 'update' | 'counts'> & {
  isAdmin: boolean;
  /** The Sun: its Nights tab reads Days. */
  solar?: boolean;
  /** The page's controls, shown at the right of the tab row. */
  trailing?: React.ReactNode;
}) {
  const { t } = useTranslation('library');
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  const accentBorder = isNight ? 'border-red-400' : isSpace ? 'border-violet-400' : 'border-accent-500';
  // Hide a tab with nothing in it, but never the one you are on, Images, Subframes, Nights, or (for an admin, who can
  // add to it) Projects. Subframes explains how to get them when there are none.
  const tabs = MEDIA_TABS.filter(id => id === 'all' || id === 'sub' || id === 'nights' || (id === 'project' && isAdmin)
    || id === state.tab || (counts?.[id] ?? 0) > 0);

  // Same underlined row as the observation page's ObservationTabs, so the two pages navigate alike.
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b pb-2 sm:pb-0 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
    <div role="tablist" aria-label={t('objectMedia.tabsLabel')} className="flex min-w-0 items-center gap-1 overflow-x-auto no-scrollbar">
      {tabs.map(id => {
        const active = id === state.tab;
        const count = counts?.[id] ?? 0;
        return (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => update({ tab: id })}
            className={`font-display text-[0.8125rem] font-medium inline-flex items-center gap-2 px-3.5 py-2.5 border-b-2 -mb-px whitespace-nowrap transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
              active
                ? `${accentText} ${accentBorder}`
                : `border-transparent ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800'}`
            }`}
          >
            {t(`objectMedia.tab.${solar && id === 'nights' ? 'days' : id}`)}
            {count > 0 && (
              <span className={`text-[0.6875rem] font-sans tabular-nums px-1.5 py-px rounded-full ${
                active
                  ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-300 text-accent-700'
                  : isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-500'
              }`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
    {trailing && <div className="sm:pb-1.5">{trailing}</div>}
    </div>
  );
}

/** Popover anchored to its button's right edge, because the controls sit at the right of the row, like the Library's. */
const POPOVER_RIGHT = 'absolute right-0 top-full mt-1.5 z-30 rounded-2xl border shadow-lg';

function ToolbarButton({ icon, label, open, active, badge, onClick }: {
  icon: React.ReactNode;
  label: string;
  open: boolean;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  const { isDark } = useTheme();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={`${TOOLBAR_BTN} ${
        active
          ? isDark ? 'bg-accent-500/15 text-accent-400 ring-accent-500/30' : 'bg-accent-500 text-white ring-accent-500'
          : isDark ? 'bg-slate-900/70 text-slate-200 ring-slate-700/60 hover:bg-slate-800' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-100'
      }`}
    >
      {icon}
      {label}
      {badge ? (
        <span className={`min-w-[1.25rem] px-1 rounded-full text-xs text-center ${isDark ? 'bg-accent-500/25' : 'bg-white/25'}`}>{badge}</span>
      ) : null}
      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  );
}

/** View, Filters and the tab's add button. Sits at the right of the tab row. */
export function MediaToolbar({
  state, update, clearFilters, activeFilterCount, counts, facets, size, onSizeChange, onUpload, onReview,
}: Props) {
  const { t } = useTranslation('library');
  const { isDark } = useTheme();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {state.tab !== 'nights' && <ViewPopover state={state} update={update} size={size} onSizeChange={onSizeChange} />}
      <FilterPopover state={state} update={update} clearFilters={clearFilters} count={activeFilterCount} facets={facets} counts={counts} />
      {state.tab === 'sub' ? onReview && (
        <button
          type="button"
          onClick={onReview}
          title={t('objectMedia.analyzeFramesTitle')}
          className={`${TOOLBAR_BTN} font-semibold ${
            isDark
              ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 ring-accent-500/30'
              : 'bg-accent-500 text-white hover:bg-accent-600 ring-accent-500'
          }`}
        >
          <ScanSearch className="h-4 w-4" />
          {t('objectMedia.toolbar.reviewFrames')}
        </button>
      ) : state.tab !== 'nights' && onUpload && (
        <button
          type="button"
          onClick={onUpload}
          className={`${TOOLBAR_BTN} font-semibold ${
            isDark
              ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 ring-accent-500/30'
              : 'bg-accent-500 text-white hover:bg-accent-600 ring-accent-500'
          }`}
        >
          <ImagePlus className="h-4 w-4" />
          {t('objectMedia.toolbar.addImage')}
        </button>
      )}
    </div>
  );
}

/** One removable chip per active filter, under the tab row. */
export function MediaFilterChips({ state, update, clearFilters, facets }: Pick<Props, 'state' | 'update' | 'clearFilters' | 'facets'>) {
  const { t } = useTranslation('library');
  const { isDark } = useTheme();

  const chips: ActiveChip[] = [];
  if (state.telescope) {
    chips.push({
      key: 'telescope',
      label: facets?.telescopes.find(s => s.id === state.telescope)?.name ?? t('objectMedia.filters.telescope'),
      clear: () => update({ telescope: '' }),
    });
  }
  if (state.filter) chips.push({ key: 'filter', label: state.filter, clear: () => update({ filter: '' }) });
  if (state.format) chips.push({ key: 'format', label: state.format, clear: () => update({ format: '' }) });
  if (state.night) {
    chips.push({
      key: 'night',
      label: formatDate(new Date(`${state.night}T12:00:00`), { year: 'numeric', month: 'short', day: 'numeric' }),
      clear: () => update({ night: '' }),
    });
  }
  if (state.favorites) chips.push({ key: 'favorites', label: t('objectMedia.filters.favoritesOnly'), clear: () => update({ favorites: false }) });

  return (
    <ActiveFilterChips
      chips={chips}
      isDark={isDark}
      removeLabel={name => t('objectMedia.filters.remove', { name })}
      clearAllLabel={t('objectMedia.filters.clear')}
      onClearAll={clearFilters}
    />
  );
}

/** Group by and sort, as pills in the same "View" popover the Library uses. */
function ViewPopover({ state, update, size, onSizeChange }: Pick<Props, 'state' | 'update' | 'size' | 'onSizeChange'>) {
  const { t } = useTranslation('library');
  const sun = useSunWording();
  const { isDark } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), { enabled: open, closeOnEscape: true });
  // Tile size is a display preference, so it resets with the rest but doesn't light the dot.
  const custom = state.group !== defaultGroupFor(state.tab) || state.sort !== 'newest';

  return (
    <div ref={ref} className="relative">
      <ToolbarButton
        icon={<SlidersHorizontal className="h-4 w-4" />}
        label={t('objectMedia.toolbar.view')}
        open={open}
        active={false}
        onClick={() => setOpen(o => !o)}
      />
      {custom && <span className="pointer-events-none absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-accent-400" aria-hidden="true" />}
      {open && (
        <div className={`${POPOVER_RIGHT} w-[22rem] max-w-[calc(100vw-2rem)] space-y-4 p-4 ${popoverSurface(isDark)}`}>
          <PopoverResetButton
            isDark={isDark}
            label={t('gallery.reset')}
            disabled={!custom && size === TILE_DEFAULT}
            onReset={() => { update({ group: defaultGroupFor(state.tab), sort: 'newest' }); onSizeChange(TILE_DEFAULT); }}
          />
          <FilterSection title={t('objectMedia.toolbar.groupBy')} isDark={isDark}>
            {MEDIA_GROUPS.map(id => (
              <Pill key={id} active={state.group === id} isDark={isDark} onClick={() => update({ group: id })}>
                {t(`objectMedia.groupBy.${id}`, sun)}
              </Pill>
            ))}
          </FilterSection>
          <FilterSection title={t('objectMedia.toolbar.sort')} isDark={isDark}>
            {MEDIA_SORTS.map(id => (
              <Pill key={id} active={state.sort === id} isDark={isDark} onClick={() => update({ sort: id })}>
                {t(`objectMedia.sort.${id}`)}
              </Pill>
            ))}
          </FilterSection>
          <FilterSection title={t('objectMedia.toolbar.tileSize')} isDark={isDark}>
            <div className="flex w-full items-center gap-2">
              <Grid3x3 className={`h-4 w-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
              <input
                type="range"
                min={TILE_MIN}
                max={TILE_MAX}
                step={TILE_STEP}
                value={size}
                onChange={e => onSizeChange(Number(e.target.value))}
                aria-label={t('objectMedia.toolbar.tileSize')}
                className="flex-1 cursor-pointer accent-amber-400"
              />
              <LayoutGrid className={`h-4 w-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
            </div>
          </FilterSection>
        </div>
      )}
    </div>
  );
}

function FilterPopover({ state, update, clearFilters, count, facets, counts }: {
  state: MediaViewState;
  update: (patch: Partial<MediaViewState>) => void;
  clearFilters: () => void;
  count: number;
  facets: ObjectMedia['facets'] | undefined;
  counts: MediaCounts | undefined;
}) {
  const { t } = useTranslation('library');
  const sun = useSunWording();
  const { isDark, isNight } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false), { enabled: open, closeOnEscape: true });

  // A facet with a single value cannot change what you see, so it is not offered
  // (unless it is the one currently selected, which must stay removable).
  const telescopes = (facets?.telescopes.length ?? 0) > 1 || state.telescope ? facets?.telescopes ?? [] : [];
  const lightFilters = (facets?.filters.length ?? 0) > 1 || state.filter ? facets?.filters ?? [] : [];
  const formats = (facets?.formats.length ?? 0) > 1 || state.format ? facets?.formats ?? [] : [];
  const nights = (facets?.nights.length ?? 0) > 1 || state.night ? facets?.nights ?? [] : [];
  const showFavorites = state.favorites || (counts?.all ?? 0) > 0;
  const countStyle = 'tabular-nums opacity-60';

  return (
    <div ref={ref} className="relative">
      <ToolbarButton
        icon={<Filter className="h-4 w-4" />}
        label={t('objectMedia.toolbar.filters')}
        open={open}
        active={count > 0}
        badge={count}
        onClick={() => setOpen(o => !o)}
      />
      {open && (
        <div className={`${POPOVER_RIGHT} max-h-[75vh] w-[22rem] max-w-[calc(100vw-2rem)] space-y-4 overflow-y-auto p-4 ${popoverSurface(isDark)}`}>
          <PopoverResetButton isDark={isDark} label={t('gallery.reset')} disabled={count === 0} onReset={clearFilters} />

          {telescopes.length > 0 && (
            <FilterSection title={t('objectMedia.filters.telescope')} isDark={isDark}>
              {telescopes.map(s => (
                <Pill key={s.id} active={state.telescope === s.id} isDark={isDark} onClick={() => update({ telescope: state.telescope === s.id ? '' : s.id })}>
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: nightSafeColor(s.color, isNight) }} />
                  {s.name}
                  <span className={countStyle}>{s.count}</span>
                </Pill>
              ))}
            </FilterSection>
          )}

          {lightFilters.length > 0 && (
            <FilterSection title={t('objectMedia.filters.lightFilter')} isDark={isDark}>
              {lightFilters.map(f => (
                <Pill key={f.value} active={state.filter === f.value} isDark={isDark} onClick={() => update({ filter: state.filter === f.value ? '' : f.value })}>
                  {f.value}
                  <span className={countStyle}>{f.count}</span>
                </Pill>
              ))}
            </FilterSection>
          )}

          {formats.length > 0 && (
            <FilterSection title={t('objectMedia.filters.format')} isDark={isDark}>
              {formats.map(f => (
                <Pill key={f.value} active={state.format === f.value} isDark={isDark} onClick={() => update({ format: state.format === f.value ? '' : f.value })}>
                  {f.value}
                  <span className={countStyle}>{f.count}</span>
                </Pill>
              ))}
            </FilterSection>
          )}

          {nights.length > 0 && (
            <FilterSection title={t('objectMedia.filters.night', sun)} isDark={isDark}>
              <div className="flex max-h-40 w-full flex-wrap gap-1.5 overflow-y-auto">
                {nights.map(n => (
                  <Pill key={n.date} active={state.night === n.date} isDark={isDark} onClick={() => update({ night: state.night === n.date ? '' : n.date })}>
                    {formatDate(new Date(`${n.date}T12:00:00`), { year: 'numeric', month: 'short', day: 'numeric' })}
                    <span className={countStyle}>{n.count}</span>
                  </Pill>
                ))}
              </div>
            </FilterSection>
          )}

          {showFavorites && (
            <FilterSection title={t('objectMedia.filters.favorites')} isDark={isDark}>
              <Pill active={state.favorites} isDark={isDark} onClick={() => update({ favorites: !state.favorites })}>
                <Star className={`h-3.5 w-3.5 ${state.favorites ? 'fill-current' : ''}`} />
                {t('objectMedia.filters.favoritesOnly')}
              </Pill>
            </FilterSection>
          )}
        </div>
      )}
    </div>
  );
}
