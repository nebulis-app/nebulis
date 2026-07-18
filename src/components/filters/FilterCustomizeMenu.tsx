import { Check } from 'lucide-react';
import type { LibraryObjectFilter } from '../../lib/api/library';
import { ALL_FILTER_ID, type TypeFilter } from '../../lib/objectTypeFilters';

interface Row {
  id: string;
  label: string;
  count?: number;
}

interface FilterCustomizeMenuProps {
  groups: LibraryObjectFilter[];
  typeFilters: TypeFilter[];
  enabledIds: Set<string>;
  onToggle: (id: string) => void;
  onClearAll: () => void;
  isDark: boolean;
}

/**
 * Popup panel listing the curated groups and every object type present in the
 * library as checkboxes. Ticking a row pins its chip to the top filter row.
 * Rendered inside a `relative` wrapper the caller owns (which handles
 * positioning and outside-click close). Visual style follows the sort dropdown.
 */
export function FilterCustomizeMenu({
  groups,
  typeFilters,
  enabledIds,
  onToggle,
  onClearAll,
  isDark,
}: FilterCustomizeMenuProps) {
  const groupRows: Row[] = groups
    .filter(g => g.id !== ALL_FILTER_ID)
    .map(g => ({ id: g.id, label: g.label }));
  const typeRows: Row[] = typeFilters.map(t => ({ id: t.id, label: t.label, count: t.count }));

  return (
    <div
      role="menu"
      aria-label="Customize filters"
      className={`absolute left-0 top-full mt-1.5 z-30 w-64 max-h-96 overflow-y-auto rounded-xl border shadow-lg ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
      }`}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          Pick which filters show on the top row.
        </span>
        <button
          type="button"
          onClick={onClearAll}
          disabled={enabledIds.size === 0}
          className={`shrink-0 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-default ${
            isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-600 hover:text-accent-700'
          }`}
        >
          Clear all
        </button>
      </div>

      <Section title="Groups" isDark={isDark} rows={groupRows} enabledIds={enabledIds} onToggle={onToggle} />
      {typeRows.length > 0 && (
        <Section title="Object types" isDark={isDark} rows={typeRows} enabledIds={enabledIds} onToggle={onToggle} />
      )}
    </div>
  );
}

function Section({
  title,
  rows,
  enabledIds,
  onToggle,
  isDark,
}: {
  title: string;
  rows: Row[];
  enabledIds: Set<string>;
  onToggle: (id: string) => void;
  isDark: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div className={`border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
      <div className={`px-4 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide ${
        isDark ? 'text-slate-600' : 'text-slate-400'
      }`}>
        {title}
      </div>
      <div className="pb-1.5">
        {rows.map(row => {
          const checked = enabledIds.has(row.id);
          return (
            <button
              key={row.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={checked}
              onClick={() => onToggle(row.id)}
              className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors ${
                isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <span
                className={`flex items-center justify-center w-4 h-4 rounded border shrink-0 transition-colors ${
                  checked
                    ? 'bg-accent-500 border-accent-500 text-white'
                    : isDark ? 'border-slate-600' : 'border-slate-300'
                }`}
                aria-hidden="true"
              >
                {checked && <Check className="w-3 h-3" strokeWidth={3} />}
              </span>
              <span className="flex-1 truncate">{row.label}</span>
              {row.count !== undefined && (
                <span className={`text-xs tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {row.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
