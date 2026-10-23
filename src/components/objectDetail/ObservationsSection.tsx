/**
 * Every night this object has been shot, newest first.
 *
 * Grouped by year, and only when there is more than one: a target you have come
 * back to over three seasons is a different thing from one you shot twice last
 * week, and an undivided grid of near-identical thumbnails hides which it is.
 * A single year gets no heading, because a heading that never varies is noise.
 *
 * When the object was shot through more than one rig (telescope + optical
 * train, see server/lib/library/sessionOptics.ts), the nights can instead be
 * grouped by rig, each with its night count and integration: data from two
 * rigs is stacked separately, so that is how a campaign is counted.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, FolderOpen, RotateCcw } from 'lucide-react';
import { ObservationCard, type ObservationCardModel } from './ObservationCard';
import { formatDuration } from '../../lib/captureMetrics';
import { nightSafeColor } from '../../lib/nightSafeColor';
import { useTheme } from '../../hooks/useTheme';

type GroupBy = 'year' | 'rig';
const GROUP_BY_KEY = 'nebulis.objectDetail.observationsGroupBy';

function readGroupBy(): GroupBy {
  try {
    return localStorage.getItem(GROUP_BY_KEY) === 'rig' ? 'rig' : 'year';
  } catch {
    return 'year';
  }
}

interface RigGroup {
  key: string;
  label: string;
  color: string | null;
  observations: ObservationCardModel[];
  integrationSec: number | null;
}

/** Rigs in order of their most recent night (observations come newest first). */
function groupByRig(observations: ObservationCardModel[], noRig: string): RigGroup[] {
  const groups = new Map<string, RigGroup>();
  for (const o of observations) {
    const key = o.rigKey ?? '-|-';
    let g = groups.get(key);
    if (!g) {
      const label = [o.telescope?.name, o.opticsLabel].filter(Boolean).join(' · ') || noRig;
      g = { key, label, color: o.telescope?.color ?? null, observations: [], integrationSec: null };
      groups.set(key, g);
    }
    g.observations.push(o);
    if (o.integrationSec != null) g.integrationSec = (g.integrationSec ?? 0) + o.integrationSec;
  }
  return [...groups.values()];
}

interface Props {
  observations: ObservationCardModel[];
  isDark: boolean;
  loading: boolean;
  tempUnit: 'celsius' | 'fahrenheit';
  onDelete: ((o: ObservationCardModel) => void) | null;
  /** Count of deleted-but-not-restored items (object + observations) under
   *  this object. Zero or `onOpenTrash` unset renders nothing — this stays
   *  invisible for the overwhelming majority of objects, which have never
   *  had anything deleted. */
  trashCount?: number;
  onOpenTrash?: (() => void) | null;
}

export function ObservationsSection({
  observations, isDark, loading, tempUnit, onDelete, trashCount = 0, onOpenTrash,
}: Props) {
  const { t } = useTranslation('library');
  const { isNight } = useTheme();
  const yearOf = (date: string): string => date.slice(0, 4) || t('objectDetail.observationsSection.unknownYear');
  const years = [...new Set(observations.map(o => yearOf(o.date)))];
  const rigs = groupByRig(observations, t('objectDetail.observationsSection.noRig'));
  const [groupByChoice, setGroupByChoice] = useState<GroupBy>(readGroupBy);
  // "By rig" only means something with two rigs or more.
  const groupBy: GroupBy = rigs.length > 1 ? groupByChoice : 'year';
  const grouped = groupBy === 'rig' || years.length > 1;
  const chooseGroupBy = (g: GroupBy) => {
    setGroupByChoice(g);
    try { localStorage.setItem(GROUP_BY_KEY, g); } catch { /* per-browser nicety only */ }
  };
  const sections = groupBy === 'rig'
    ? rigs.map(r => ({
      key: r.key,
      title: r.label,
      color: r.color,
      observations: r.observations,
      detail: r.integrationSec
        ? t('objectDetail.observationsSection.rigSummary', { count: r.observations.length, integration: formatDuration(r.integrationSec) })
        : String(r.observations.length),
    }))
    : years.map(year => {
      const inYear = observations.filter(o => yearOf(o.date) === year);
      return { key: year, title: year, color: null, observations: inYear, detail: String(inYear.length) };
    });

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className={`font-display flex items-center gap-2 text-lg font-semibold tracking-tight ${
          isDark ? 'text-slate-100' : 'text-slate-900'
        }`}>
          <Calendar className="h-4 w-4 text-accent-500" />
          {t('objectDetail.observationsSection.heading')}
        </h2>
        <div className="flex items-center gap-3">
          {rigs.length > 1 && (
            <div
              role="radiogroup"
              aria-label={t('objectDetail.observationsSection.groupBy')}
              className={`inline-flex rounded-lg border p-0.5 text-[0.75rem] font-medium ${
                isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-100/70'
              }`}
            >
              {(['year', 'rig'] as const).map(g => (
                <button
                  key={g}
                  type="button"
                  role="radio"
                  aria-checked={groupBy === g}
                  onClick={() => chooseGroupBy(g)}
                  className={`rounded-md px-2.5 py-1 transition-colors ${
                    groupBy === g
                      ? isDark ? 'bg-slate-800 text-white shadow-sm' : 'bg-white text-slate-900 shadow-sm'
                      : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {t(`objectDetail.observationsSection.groupBy_${g}`)}
                </button>
              ))}
            </div>
          )}
          {trashCount > 0 && onOpenTrash && (
            <button
              type="button"
              onClick={onOpenTrash}
              className={`inline-flex items-center gap-1.5 text-[0.75rem] font-medium transition-colors ${
                isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'
              }`}
              title={t('objectDetail.observationsSection.deletedTooltip')}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('objectDetail.observationsSection.deletedCount', { count: trashCount })}
            </button>
          )}
          {observations.length > 0 && (
            // Observations, not nights: a variant shot alongside its base on one
            // night is two cards here, and calling that two nights would be wrong.
            <span className={`text-sm tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t('objectDetail.observationsSection.count', { count: observations.length })}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className={`overflow-hidden rounded-2xl border ${
              isDark ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white'
            }`}>
              <div className="img-placeholder h-44" />
              <div className="p-4">
                <div className={`h-4 w-2/3 rounded ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`} />
              </div>
            </div>
          ))}
        </div>
      ) : observations.length === 0 ? (
        <div className={`rounded-2xl border py-12 text-center ${
          isDark ? 'border-slate-800 bg-slate-900 text-slate-500' : 'border-slate-200 bg-white text-slate-400 shadow-sm'
        }`}>
          <FolderOpen className="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p className="text-sm">{t('objectDetail.observationsSection.empty')}</p>
        </div>
      ) : grouped ? (
        sections.map(sec => (
          <div key={sec.key} className="space-y-3">
            <div className="flex items-center gap-3">
              {sec.color && (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: nightSafeColor(sec.color, isNight) }} />
              )}
              <span className={`font-display text-sm font-semibold tabular-nums ${
                isDark ? 'text-slate-400' : 'text-slate-500'
              }`}>
                {sec.title}
              </span>
              <span className={`h-px flex-1 ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} />
              <span className={`text-xs tabular-nums ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                {sec.detail}
              </span>
            </div>
            <Grid
              observations={sec.observations}
              isDark={isDark}
              tempUnit={tempUnit}
              onDelete={onDelete}
            />
          </div>
        ))
      ) : (
        <Grid observations={observations} isDark={isDark} tempUnit={tempUnit} onDelete={onDelete} />
      )}
    </section>
  );
}

function Grid({ observations, isDark, tempUnit, onDelete }: {
  observations: ObservationCardModel[];
  isDark: boolean;
  tempUnit: 'celsius' | 'fahrenheit';
  onDelete: ((o: ObservationCardModel) => void) | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {observations.map(o => (
        <ObservationCard
          key={`${o.objectId}-${o.id}`}
          observation={o}
          isDark={isDark}
          tempUnit={tempUnit}
          onDelete={onDelete ? () => onDelete(o) : null}
        />
      ))}
    </div>
  );
}
