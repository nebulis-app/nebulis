import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Telescope as TelescopeIcon } from 'lucide-react';
import type { ObservationSummary } from '../../lib/api/observations';
import type { TelescopeProfile } from '../../lib/api/telescopes';
import { resolveObjectLabel, formatObservationDate } from '../../lib/observationDisplay';
import { cleanCatalogId } from '../../lib/utils';

type SortKey = 'object' | 'catalog' | 'date';
type SortDir = 'asc' | 'desc';

const SORT_COLUMNS: { id: SortKey; label: string }[] = [
  { id: 'object', label: 'Object' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'date', label: 'Date' },
];

/** Human-readable statement of the current sort, for the share card's subtitle
 *  (it has no month to anchor it the way the calendar card does, so it needs
 *  to say what "the list" means). */
function describeSort(key: SortKey, dir: SortDir): string {
  if (key === 'date') return `Sorted by date, ${dir === 'desc' ? 'newest first' : 'oldest first'}`;
  const label = SORT_COLUMNS.find(c => c.id === key)!.label.toLowerCase();
  return `Sorted by ${label}, ${dir === 'asc' ? 'A to Z' : 'Z to A'}`;
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
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Dates are most useful newest-first; names read best A to Z.
      setSortDir(key === 'date' ? 'desc' : 'asc');
    }
  };

  const rows = useMemo(() => {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const sorted = [...observations].sort((a, b) => {
      switch (sortKey) {
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
  }, [observations, sortKey, sortDir]);

  useEffect(() => {
    onSortedRowsChange?.(rows, describeSort(sortKey, sortDir));
  }, [rows, sortKey, sortDir, onSortedRowsChange]);

  if (observations.length === 0) {
    return (
      <div className={`rounded-2xl border px-6 py-16 text-center ${
        isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'
      }`}>
        <p className={`font-medium ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>No observations yet</p>
        <p className={`text-sm mt-1 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
          Import from a telescope or add one manually to see it here.
        </p>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border overflow-hidden ${
      isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'
    }`}>
      {/* Wide tables scroll inside their own container rather than pushing the page sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">
            All observations, sortable by object, catalog identifier, or date.
          </caption>
          <thead className={`border-b ${isDark ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-slate-50'}`}>
            <tr>
              {SORT_COLUMNS.map(col => (
                <SortHeader
                  key={col.id}
                  id={col.id}
                  label={col.label}
                  active={sortKey === col.id}
                  dir={sortDir}
                  isDark={isDark}
                  onSort={toggleSort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(obs => {
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
                          style={{ backgroundColor: scope.color }}
                          title={scope.name}
                        />
                      )}
                      {display}
                    </Link>
                  </td>
                  <td className={`px-4 py-2.5 text-sm tabular-nums ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {catalog}
                  </td>
                  <td className={`px-4 py-2.5 text-sm tabular-nums whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {formatObservationDate(obs.date)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={`px-4 py-2.5 border-t text-xs flex items-center gap-2 ${
        isDark ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'
      }`}>
        {showTelescopeUI && <TelescopeIcon className="w-3.5 h-3.5" />}
        {rows.length} {rows.length === 1 ? 'observation' : 'observations'}
      </div>
    </div>
  );
}
