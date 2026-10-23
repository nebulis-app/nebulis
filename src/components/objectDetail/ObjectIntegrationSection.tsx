import { useState } from 'react';
import { usePanelHalfOpen } from './usePanelHalfOpen';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Hourglass, ChevronRight, ChevronDown, Pencil, Plus, X, Loader2, AlertTriangle } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import {
  getIntegrationByFilter,
  saveIntegrationGoals,
  type FilterIntegration,
  type IntegrationGoal,
} from '../../lib/api/library';
import { formatDuration } from '../../lib/captureMetrics';
import { formatDate } from '../../lib/formatLocale';

/**
 * Object-level integration per filter, with an optional goal per filter
 * (`server/lib/library/integration.ts`). Answers "how much OIII do I have on
 * this object, and how much is left?" for multi-night campaigns.
 *
 * Same collapsed-when-empty convention as the processed / project-archive
 * sections: an object with no subs and no goals doesn't take up space open.
 */

/** One row in goal-edit mode. `hours` stays a string while typing so "1." or
 *  "" don't get coerced mid-edit. */
interface GoalDraft {
  key: string;
  filter: string | null;
  hours: string;
  /** Rows added by the user in edit mode have an editable name. */
  isNew: boolean;
}

function goalHoursString(goalSec: number | null): string {
  if (!goalSec) return '';
  const h = goalSec / 3600;
  return Number.isInteger(h) ? String(h) : h.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function parseHours(value: string): number | null {
  const trimmed = value.trim().replace(',', '.');
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : null;
}

export function ObjectIntegrationSection({
  objectId,
  isAdmin,
  bare = false,
}: {
  objectId: string;
  isAdmin: boolean;
  /** Drop the card's own border and surface, for a section that sits inside
   *  ObjectProjectPanel's shared card. */
  bare?: boolean;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('library');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['integration-by-filter', objectId],
    queryFn: () => getIntegrationByFilter(objectId),
    enabled: !!objectId,
  });

  const filters = data?.filters ?? [];
  const hasContent = filters.length > 0;

  // Same null-means-follow-default / reset-on-object-change pattern as
  // ObjectProcessedSection.
  const [manualOpen, setOwnOpen] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<GoalDraft[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prevObjectId, setPrevObjectId] = useState(objectId);
  if (objectId !== prevObjectId) {
    setPrevObjectId(objectId);
    setOwnOpen(null);
    setExpanded(null);
    setDrafts(null);
    setError(null);
  }
  const { isOpen, setOpen: setManualOpen } = usePanelHalfOpen('integration', hasContent, [manualOpen, setOwnOpen]);
  const editing = drafts !== null;

  const filterLabel = (f: string | null) => f ?? t('objectDetail.integrationSection.noFilter');
  const rowKey = (f: string | null) => f ?? '\u0000none';

  const startEditing = () => {
    setError(null);
    setManualOpen(true);
    setDrafts(filters.map(f => ({
      key: rowKey(f.filter),
      filter: f.filter,
      hours: goalHoursString(f.goalSec),
      isNew: false,
    })));
  };

  const addDraft = () => {
    setDrafts(d => [...(d ?? []), { key: `new-${Date.now()}`, filter: '', hours: '', isNew: true }]);
  };

  const save = async () => {
    if (!drafts || saving) return;
    const goals: IntegrationGoal[] = [];
    for (const d of drafts) {
      const hours = parseHours(d.hours);
      if (hours === null) {
        setError(t('objectDetail.integrationSection.invalidHours'));
        return;
      }
      const name = d.isNew ? (d.filter ?? '').trim() : d.filter;
      if (d.isNew && !name) {
        if (hours > 0) {
          setError(t('objectDetail.integrationSection.missingFilterName'));
          return;
        }
        continue; // empty new row: ignore
      }
      goals.push({ filter: name, goalSec: Math.round(hours * 3600) });
    }
    setSaving(true);
    setError(null);
    try {
      await saveIntegrationGoals(objectId, goals);
      await queryClient.invalidateQueries({ queryKey: ['integration-by-filter', objectId] });
      await queryClient.invalidateQueries({ queryKey: ['integration-progress'] });
      setDrafts(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('objectDetail.integrationSection.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const muted = isDark ? 'text-slate-500' : 'text-slate-400';
  const strong = isDark ? 'text-slate-200' : 'text-slate-800';
  const subtle = isDark ? 'text-slate-400' : 'text-slate-600';
  const inputCls = `px-2.5 py-1.5 rounded-lg border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/30 ${
    isDark ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder-slate-600' : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400'
  }`;
  const buttonCls = `shrink-0 inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg transition disabled:opacity-50 ${
    isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
  }`;

  const summary = data && data.totalFrames > 0
    ? t('objectDetail.integrationSection.summary', {
      total: formatDuration(data.totalExposureSec),
      count: filters.filter(f => f.frames > 0).length,
    })
    : t('objectDetail.integrationSection.noneYet');

  return (
    <div className={bare
      ? 'min-w-0'
      : `rounded-2xl border ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
      <div className={`flex items-center gap-2 p-4 min-h-[68px] ${isOpen ? `border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}` : ''}`}>
        <button
          type="button"
          onClick={() => setManualOpen(!isOpen)}
          aria-expanded={isOpen}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          {isOpen
            ? <ChevronDown className={`w-4 h-4 shrink-0 ${muted}`} />
            : <ChevronRight className={`w-4 h-4 shrink-0 ${muted}`} />}
          <Hourglass className={`w-4 h-4 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
          <span className={`text-sm font-semibold ${strong}`}>
            {t('objectDetail.integrationSection.heading')}
          </span>
          <span className={`text-xs truncate ${muted}`}>{isLoading ? '…' : summary}</span>
        </button>
        {isAdmin && !editing && (
          <button type="button" onClick={startEditing} className={buttonCls}>
            <Pencil className="w-3.5 h-3.5" />
            {t('objectDetail.integrationSection.editGoals')}
          </button>
        )}
      </div>

      {isOpen && !editing && (
        <>
          {!hasContent && !isLoading && (
            <p className={`p-4 text-sm ${subtle}`}>
              {t('objectDetail.integrationSection.emptyHint')}
            </p>
          )}
          {hasContent && (
            <div className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-slate-100'}`}>
              {filters.map(f => (
                <FilterRow
                  key={rowKey(f.filter)}
                  row={f}
                  label={filterLabel(f.filter)}
                  isDark={isDark}
                  open={expanded === rowKey(f.filter)}
                  onToggle={() => setExpanded(e => (e === rowKey(f.filter) ? null : rowKey(f.filter)))}
                />
              ))}
            </div>
          )}
          {data && data.unreadableFrames > 0 && (
            <p className={`flex items-center gap-1.5 px-4 pb-3 pt-2 text-xs ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {t('objectDetail.integrationSection.unreadable', { count: data.unreadableFrames })}
            </p>
          )}
        </>
      )}

      {isOpen && editing && (
        <div className="p-4 space-y-3">
          <p className={`text-xs ${muted}`}>{t('objectDetail.integrationSection.editHint')}</p>
          {drafts.length === 0 && (
            <p className={`text-sm ${subtle}`}>{t('objectDetail.integrationSection.noFiltersYet')}</p>
          )}
          {drafts.map((d, i) => (
            <div key={d.key} className="flex items-center gap-2">
              {d.isNew ? (
                <input
                  type="text"
                  value={d.filter ?? ''}
                  maxLength={64}
                  placeholder={t('objectDetail.integrationSection.filterPlaceholder')}
                  aria-label={t('objectDetail.integrationSection.filterPlaceholder')}
                  onChange={e => setDrafts(ds => ds!.map((x, j) => (j === i ? { ...x, filter: e.target.value } : x)))}
                  className={`flex-1 min-w-0 ${inputCls}`}
                />
              ) : (
                <span className={`flex-1 min-w-0 truncate text-sm font-medium ${strong}`}>{filterLabel(d.filter)}</span>
              )}
              <input
                type="text"
                inputMode="decimal"
                value={d.hours}
                placeholder="0"
                aria-label={t('objectDetail.integrationSection.goalHoursFor', { filter: filterLabel(d.filter) || '…' })}
                onChange={e => setDrafts(ds => ds!.map((x, j) => (j === i ? { ...x, hours: e.target.value } : x)))}
                className={`w-20 text-right ${inputCls}`}
              />
              <span className={`text-xs w-3 ${muted}`}>{t('objectDetail.integrationSection.hoursUnit')}</span>
              {d.isNew && (
                <button
                  type="button"
                  onClick={() => setDrafts(ds => ds!.filter((_, j) => j !== i))}
                  className={`p-1.5 rounded-lg ${isDark ? 'text-slate-500 hover:bg-slate-800' : 'text-slate-400 hover:bg-slate-100'}`}
                  aria-label={t('objectDetail.integrationSection.removeRow')}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
          {error && <p className={`text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</p>}
          <div className="flex items-center gap-2 pt-1">
            <button type="button" onClick={addDraft} className={buttonCls}>
              <Plus className="w-3.5 h-3.5" />
              {t('objectDetail.integrationSection.addFilter')}
            </button>
            <div className="flex-1" />
            <button type="button" onClick={() => { setDrafts(null); setError(null); }} disabled={saving} className={buttonCls}>
              {t('objectDetail.integrationSection.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t('objectDetail.integrationSection.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterRow({
  row,
  label,
  isDark,
  open,
  onToggle,
}: {
  row: FilterIntegration;
  label: string;
  isDark: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation('library');
  const pct = row.goalSec ? Math.min(100, Math.round((row.exposureSec / row.goalSec) * 100)) : null;
  const done = pct !== null && pct >= 100;
  const remaining = row.goalSec ? Math.max(0, row.goalSec - row.exposureSec) : 0;
  const hasNights = row.nights.length > 0;

  return (
    <div className="px-4 py-3">
      <button
        type="button"
        onClick={hasNights ? onToggle : undefined}
        aria-expanded={hasNights ? open : undefined}
        className={`w-full text-left ${hasNights ? '' : 'cursor-default'}`}
      >
        <div className="flex items-baseline gap-2">
          <span className={`text-sm font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{label}</span>
          <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {t('objectDetail.integrationSection.frames', { count: row.frames })}
          </span>
          <span className="flex-1" />
          <span className={`text-sm tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            {formatDuration(row.exposureSec)}
            {row.goalSec ? (
              <span className={isDark ? 'text-slate-500' : 'text-slate-400'}> / {formatDuration(row.goalSec)}</span>
            ) : null}
          </span>
        </div>
        {pct !== null && (
          <>
            <div
              className={`mt-2 h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label={label}
            >
              <div
                className={`h-full rounded-full ${done ? 'bg-emerald-500' : 'bg-accent-500'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className={`mt-1 text-[0.6875rem] ${done ? (isDark ? 'text-emerald-400' : 'text-emerald-600') : (isDark ? 'text-slate-500' : 'text-slate-400')}`}>
              {done
                ? t('objectDetail.integrationSection.goalReached')
                : t('objectDetail.integrationSection.remaining', { duration: formatDuration(remaining), pct })}
            </p>
          </>
        )}
      </button>
      {open && hasNights && (
        <ul className={`mt-2 space-y-0.5 text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          {row.nights.map(n => (
            <li key={n.date} className="flex gap-2 tabular-nums">
              <span className="flex-1">
                {n.date === 'unknown'
                  ? t('objectDetail.integrationSection.unknownNight')
                  : formatDate(new Date(`${n.date}T12:00:00`), { year: 'numeric', month: 'short', day: 'numeric' })}
              </span>
              <span>{t('objectDetail.integrationSection.frames', { count: n.frames })}</span>
              <span className="w-16 text-right">{formatDuration(n.exposureSec)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
