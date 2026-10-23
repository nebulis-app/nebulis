import { memo, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { nightSafeColor } from '../../lib/nightSafeColor';
import { formatDuration } from '../../lib/captureMetrics';
import { formatDate } from '../../lib/formatLocale';
import type { MediaGroup as MediaGroupModel, MediaGroupBy, MediaItem, MediaTabId, MediaTelescope } from '../../lib/api/library';
import { MediaTile, ProjectCard } from './MediaTile';
import { NightFrameList } from '../frameAnalysis/NightFrameList';
import { TILE_COMPACT, type TileSize } from './tileSizing';

interface Props {
  group: MediaGroupModel;
  items: MediaItem[];
  groupBy: MediaGroupBy;
  tab: MediaTabId;
  size: TileSize;
  /** False when there is only one group: a heading that never varies is noise. */
  showHeader: boolean;
  onOpen: (item: MediaItem) => void;
  onToggleFavorite: (item: MediaItem) => void;
  onMarkProcessed?: (item: MediaItem) => void;
  onMarkUnprocessed?: (item: MediaItem) => void;
  /** The FITS files block folds to its heading when hidden; the choice belongs to the viewer, so the page keeps it. */
  fitsHidden?: boolean;
  onToggleFits?: () => void;
  /** Switch to the Sub-frames tab, scoped to this night. */
  onShowAllSubs: (date: string) => void;
  /** When set, a night's sub-frames render as the analysis list instead of tiles. */
  list?: {
    objectId: string;
    objectName: string;
    isAdmin: boolean;
    onFramesDeleted: () => void;
  };
}

function isTelescopeFits(i: MediaItem): boolean {
  return i.kind === 'telescope' && i.isFits;
}

function gridStyle(size: TileSize): React.CSSProperties {
  return { gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` };
}

export const MediaGroupSection = memo(function MediaGroupSection({
  group, items, groupBy, tab, size, showHeader, onOpen, onToggleFavorite, onMarkProcessed, onMarkUnprocessed, fitsHidden = false, onToggleFits, onShowAllSubs, list,
}: Props) {
  const { t } = useTranslation('library');
  const { isDark, isNight } = useTheme();

  const { pictures, fitsFiles, subs, projects, telescopes } = useMemo(() => {
    const seen = new Map<string, MediaTelescope>();
    for (const i of items) if (i.telescope) seen.set(i.telescope.id, i.telescope);
    return {
      // On the All tab the telescope's FITS files sit apart from the pictures: they are tall, dark
      // data files that would otherwise fill the grid. The Telescope tab keeps them together.
      pictures: items.filter(i => i.kind !== 'sub' && i.kind !== 'project' && !(tab === 'all' && isTelescopeFits(i))),
      fitsFiles: tab === 'all' ? items.filter(isTelescopeFits) : [],
      subs: items.filter(i => i.kind === 'sub'),
      projects: items.filter(i => i.kind === 'project'),
      telescopes: [...seen.values()],
    };
  }, [items, tab]);

  const title = groupTitle(group, groupBy, t);
  // The night page that owns this group's files. A group can span variants, so
  // use the object a file in it really lives under.
  const nightObjectId = items.find(i => i.kind !== 'processed' && i.kind !== 'project')?.objectId ?? items[0]?.objectId;
  const muted = 'text-slate-500';

  const meta: string[] = [];
  if (group.subCount > 0) {
    meta.push(group.exposure
      ? t('objectMedia.group.framesExposure', { count: group.frames, exposure: group.exposure })
      : t('objectMedia.group.frames', { count: group.frames }));
  }
  if (group.integrationSec) meta.push(t('objectMedia.group.integration', { time: formatDuration(group.integrationSec) }));

  return (
    <section aria-label={title} className="[content-visibility:auto] [contain-intrinsic-size:auto_320px]">
      {showHeader && (
        <header className={`sticky top-16 z-20 -mx-1 flex items-center gap-3 px-1 py-2.5 backdrop-blur-md ${
          isDark ? 'bg-slate-950/80' : 'bg-slate-50/85'
        }`}>
          <div className="min-w-0 flex-1">
            <h3 className={`truncate text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{title}</h3>
            {(telescopes.length > 0 || meta.length > 0) && (
              <p className={`mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs ${muted}`}>
                {groupBy === 'night' && telescopes.map(scope => (
                  <span key={scope.id} className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: nightSafeColor(scope.color, isNight) }} />
                    {scope.name}
                  </span>
                ))}
                {meta.map(m => <span key={m}>{m}</span>)}
              </p>
            )}
          </div>
          {group.date && nightObjectId && (
            <Link
              to={`/observations/${encodeURIComponent(nightObjectId)}/${encodeURIComponent(group.date)}`}
              className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 ring-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                isDark
                  ? 'text-accent-400 ring-accent-500/30 hover:bg-accent-500/15'
                  : 'text-accent-600 ring-accent-500/40 hover:bg-accent-500/10'
              }`}
            >
              {t('objectMedia.group.openNight')}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </header>
      )}

      <div className="space-y-4 pb-6">
        {projects.length > 0 && (
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {projects.map(p => <ProjectCard key={p.id} item={p} />)}
          </div>
        )}

        {pictures.length > 0 && (
          <div className="grid gap-2" style={gridStyle(size)}>
            {pictures.map(i => (
              <MediaTile key={i.id} item={i} size={size} onOpen={onOpen} onToggleFavorite={onToggleFavorite} onMarkProcessed={onMarkProcessed} onMarkUnprocessed={onMarkUnprocessed} />
            ))}
          </div>
        )}

        {fitsFiles.length > 0 && (
          <div className="space-y-2">
            <h4 className={`text-xs font-medium uppercase tracking-wide ${muted}`}>
              {onToggleFits ? (
                <button
                  type="button"
                  onClick={onToggleFits}
                  aria-expanded={!fitsHidden}
                  title={fitsHidden ? t('objectMedia.group.showFits') : t('objectMedia.group.hideFits')}
                  className="inline-flex items-center gap-1 rounded uppercase tracking-wide hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                  {fitsHidden ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {t('objectMedia.group.fitsFiles')} · {fitsFiles.length}
                  <span className={`ml-1 normal-case tracking-normal ${isDark ? 'text-accent-400' : 'text-accent-600'}`}>
                    {fitsHidden ? t('objectMedia.group.showFitsShort') : t('objectMedia.group.hideFitsShort')}
                  </span>
                </button>
              ) : (
                <>{t('objectMedia.group.fitsFiles')} · {fitsFiles.length}</>
              )}
            </h4>
            {!fitsHidden && (
              <div className="grid gap-2" style={gridStyle(TILE_COMPACT)}>
                {fitsFiles.map(i => (
                  <MediaTile key={i.id} item={i} size={TILE_COMPACT} onOpen={onOpen} onToggleFavorite={onToggleFavorite} />
                ))}
              </div>
            )}
          </div>
        )}

        {subs.length > 0 && (
          <div className="space-y-2">
            {tab === 'all' && (
              <div className="flex items-center gap-2">
                <h4 className={`text-xs font-medium uppercase tracking-wide ${muted}`}>
                  {t('objectMedia.tab.sub')} · {group.subCount}
                </h4>
                {group.subCount > subs.length && group.date && (
                  <button
                    type="button"
                    onClick={() => { if (group.date) onShowAllSubs(group.date); }}
                    className={`rounded text-xs font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${isDark ? 'text-accent-400' : 'text-accent-600'}`}
                  >
                    {t('objectMedia.group.showAllSubs')}
                  </button>
                )}
              </div>
            )}
            {list && tab === 'sub' && group.date ? (
              <NightFrameList
                objectId={list.objectId}
                objectName={list.objectName}
                date={group.date}
                includeVariants
                isAdmin={list.isAdmin}
                onFramesDeleted={list.onFramesDeleted}
              />
            ) : (
              <div className="grid gap-2" style={gridStyle(tab === 'all' ? TILE_COMPACT : size)}>
                {subs.map(i => (
                  <MediaTile key={i.id} item={i} size={tab === 'all' ? TILE_COMPACT : size} onOpen={onOpen} onToggleFavorite={onToggleFavorite} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
});

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function groupTitle(group: MediaGroupModel, groupBy: MediaGroupBy, t: TFn): string {
  switch (group.key) {
    case '_across': return t('objectMedia.group.across');
    case '_projects': return t('objectMedia.group.projects');
    case 'all': return t('objectMedia.group.all');
    case '_none':
      return groupBy === 'night' ? t('objectMedia.group.noNight')
        : groupBy === 'telescope' ? t('objectMedia.group.noTelescope')
          : groupBy === 'filter' ? t('objectMedia.group.noFilter')
            : t('objectMedia.group.all');
  }
  if (groupBy === 'night' && group.date) {
    return formatDate(new Date(`${group.date}T12:00:00`), { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' });
  }
  if (groupBy === 'type') return t(`objectMedia.tab.${group.key}`);
  return group.label;
}
