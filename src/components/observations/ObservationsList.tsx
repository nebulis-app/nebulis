import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Telescope as TelescopeIcon } from 'lucide-react';
import type { ObservationSummary } from '../../lib/api/observations';
import type { TelescopeProfile } from '../../lib/api/telescopes';
import { resolveObjectLabel, formatObservationDate } from '../../lib/observationDisplay';
import { cleanCatalogId } from '../../lib/utils';
import { useTheme } from '../../hooks/useTheme';
import { nightSafeColor } from '../../lib/nightSafeColor';
import { rigLabel } from '../../lib/rigLabel';

type SortKey = 'object' | 'catalog' | 'rig' | 'date';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 25;

/** Label per sort column. A Record, so every SortKey must have one and the
 *  lookup in describeSort can't come back empty. */
const SORT_LABEL_KEY: Record<SortKey, string> = {
  object: 'list.columnObject',
  catalog: 'list.columnCatalog',
  // Telescope + optical train; only shown when there is more than one rig.
  rig: 'list.columnRig',
  date: 'list.columnDate',
};

/** Header order. */
const SORT_COLUMNS: { id: SortKey; labelKey: string }[] = (['object', 'catalog', 'rig', 'date'] satisfies SortKey[])
  .map(id => ({ id, labelKey: SORT_LABEL_KEY[id] }));

/** Human-readable statement of the current sort, for the share card's subtitle
 *  (it has no month to anchor it the way the calendar card does, so it needs
 *  to say what "the list" means). */
function describeSort(key: SortKey, dir: SortDir, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (key === 'date') return dir === 'desc' ? t('list.sortedByDateNewest') : t('list.sortedByDateOldest');
  const column = t(SORT_LABEL_KEY[key]).toLowerCase();
  return dir === 'asc' ? t('list.sortedByColumnAz', { column }) : t('list.sortedByColumnZa', { column });
}

/** Declared at module scope: a component defined inside a render remounts on
 *  every parent render, losing focus from the header button mid-interaction. */
function SortHeader({
  id, label, active, dir, isDark, onSort,
}: {
  id: SortKey;
  label: string;
  active: boolean;
  dir: SortDir;
  isDark: boolean;
  onSort: (key: SortKey) => void;
}) {
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`text-left text-xs font-semibold uppercase tracking-wide px-4 py-2.5 ${
        isDark ? 'text-slate-400' : 'text-slate-500'
      }`}
    >
      <button
        type="button"
        onClick={() => onSort(id)}
        className={`inline-flex items-center gap-1 rounded transition ${
          isDark ? 'hover:text-slate-200' : 'hover:text-slate-800'
        } ${active ? (isDark ? 'text-slate-200' : 'text-slate-800') : ''}`}
      >
        {label}
        {active && (dir === 'asc'
          ? <ArrowUp className="w-3 h-3" />
          : <ArrowDown className="w-3 h-3" />)}
      </button>
    </th>
  );
}

interface Props {
  observations: ObservationSummary[];
  telescopeById: Map<string, TelescopeProfile>;
  showTelescopeUI: boolean;
  isDark: boolean;
  /** Reports the currently sorted row order (and a label describing the
   *  sort), so the parent's "Share" action can export exactly what's on
   *  screen rather than an unsorted list. */
  onSortedRowsChange?: (rows: ObservationSummary[], sortLabel: string) => void;
}

/**
 * Flat table of every observation, as an alternative to the month-scoped
 * calendar and the map.
 *
 * Unlike the calendar this is not limited to one month: the point of the list
 * is to see the whole log at once and sort it, so it renders everything the
 * telescope filter allows.
 */
export function ObservationsList({
  observations, telescopeById, showTelescopeUI, isDark, onSortedRowsChange,
}: Props) {
  const { t } = useTranslation('observations');
  const { isNight } = useTheme();
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Dates are most useful newest-first; names read best A to Z.
      setSortDir(key === 'date' ? 'desc' : 'asc');
    }
  };

  const noRig = t('list.noRig');
  const rigOf = (o: ObservationSummary) =>
    rigLabel(o.telescopeId ? telescopeById.get(o.telescopeId) : null, o.optics, noRig);
  const columns = showTelescopeUI ? SORT_COLUMNS : SORT_COLUMNS.filter(c => c.id !== 'rig');

  const rows = useMemo(() => {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const fallback = t('list.noRig');
    const rigName = (o: ObservationSummary) =>
      rigLabel(o.telescopeId ? telescopeById.get(o.telescopeId) : null, o.optics, fallback);
    const sorted = [...observations].sort((a, b) => {
      switch (sortKey) {
        case 'rig': {
          // Grouped by rig, newest night first inside each.
          const byRig = collator.compare(rigName(a), rigName(b));
          // Ties are ordered so they read newest-first after the final
          // reverse that a descending sort applies.
          return byRig !== 0 ? byRig : (sortDir === 'asc' ? 1 : -1) * b.date.localeCompare(a.date);
        }
        case 'object':
          return collator.compare(a.objectName || a.objectId, b.objectName || b.objectId);
        case 'catalog':
          return collator.compare(cleanCatalogId(a.catalogId || a.objectId), cleanCatalogId(b.catalogId || b.objectId));
        case 'date': {
          // `date` is YYYY-MM-DD, so a plain string compare is chronological.
          // Ties fall back to startTime, which orders sessions within a night.
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          return (a.startTime ?? '').localeCompare(b.startTime ?? '');
        }
      }
    });
    return sortDir === 'asc' ? sorted : sorted.reverse();
  }, [observations, sortKey, sortDir, telescopeById, t]);

  useEffect(() => {
    onSortedRowsChange?.(rows, describeSort(sortKey, sortDir, t));
  }, [rows, sortKey, sortDir, onSortedRowsChange, t]);

  // Re-sorting or the underlying set changing (month/telescope filter) can
  // easily leave `page` pointing past the new last page, so jump back to the
  // first page whenever what's being paginated changes. Adjusted during
  // render (React's "reset state when a value changes" pattern) rather than
  // in an effect, which would cause an extra render pass on every change.
  const [prevRows, setPrevRows] = useState(rows);
  if (prevRows !== rows) {
    setPrevRows(rows);
    setPage(0);
  }

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const pageRows = useMemo(
    () => rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [rows, page],
  );

  if (observations.length === 0) {
    return (
      <div className="px-6 py-16 text-center">
        <p className={`font-medium ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{t('list.empty')}</p>
        <p className={`text-sm mt-1 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
          {t('list.emptyHint')}
        </p>
      </div>
    );
  }

  return (
    // The page wraps this (and the toolbar above it) in one bordered card.
    <div className="overflow-hidden">
      {/* Wide tables scroll inside their own container rather than pushing the page sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">
            {t('list.caption')}
          </caption>
          <thead className={`border-b ${isDark ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-slate-50'}`}>
            <tr>
              {columns.map(col => (
                <SortHeader
                  key={col.id}
                  id={col.id}
                  label={t(col.labelKey)}
                  active={sortKey === col.id}
                  dir={sortDir}
                  isDark={isDark}
                  onSort={toggleSort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map(obs => {
              const scope = obs.telescopeId ? telescopeById.get(obs.telescopeId) : null;
              const { display, catalog } = resolveObjectLabel(obs);

              return (
                <tr
                  key={obs.id}
                  className={`border-b last:border-0 transition ${
                    isDark
                      ? 'border-slate-800 hover:bg-slate-800/60'
                      : 'border-slate-100 hover:bg-slate-50'
                  }`}
                >
                  <td className="px-4 py-2.5">
                    <Link
                      to={`/observations/${encodeURIComponent(obs.objectId)}/${encodeURIComponent(obs.date)}`}
                      className={`flex items-center gap-2 text-sm font-medium ${
                        isDark ? 'text-slate-200 hover:text-white' : 'text-slate-800 hover:text-slate-950'
                      }`}
                    >
                      {showTelescopeUI && scope && (
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: nightSafeColor(scope.color, isNight) }}
                          title={scope.name}
                        />
                      )}
                      {display}
                    </Link>
                  </td>
                  <td className={`px-4 py-2.5 text-sm tabular-nums ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {catalog}
                  </td>
                  {showTelescopeUI && (
                    <td className={`px-4 py-2.5 text-sm whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      {rigOf(obs)}
                    </td>
                  )}
                  <td className={`px-4 py-2.5 text-sm tabular-nums whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {formatObservationDate(obs.date)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={`px-4 py-2.5 border-t text-xs flex items-center justify-between gap-3 ${
        isDark ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'
      }`}>
        <span className="flex items-center gap-2">
          {showTelescopeUI && <TelescopeIcon className="w-3.5 h-3.5" />}
          {totalPages > 1
            ? t('list.showingRange', {
                from: page * PAGE_SIZE + 1,
                to: Math.min((page + 1) * PAGE_SIZE, rows.length),
                total: rows.length,
              })
            : t('list.count', { count: rows.length })}
        </span>

        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label={t('list.previousPage')}
              className={`flex h-7 w-7 items-center justify-center rounded-lg transition disabled:opacity-30 disabled:cursor-not-allowed ${
                isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
              }`}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="tabular-nums px-1">
              {t('list.pageOfTotal', { page: page + 1, totalPages })}
            </span>
            <button
              type="button"
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              aria-label={t('list.nextPage')}
              className={`flex h-7 w-7 items-center justify-center rounded-lg transition disabled:opacity-30 disabled:cursor-not-allowed ${
                isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
              }`}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
