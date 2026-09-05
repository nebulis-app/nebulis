/**
 * Every night this object has been shot, newest first.
 *
 * Grouped by year, and only when there is more than one: a target you have come
 * back to over three seasons is a different thing from one you shot twice last
 * week, and an undivided grid of near-identical thumbnails hides which it is.
 * A single year gets no heading, because a heading that never varies is noise.
 */
import { Calendar, FolderOpen, RotateCcw } from 'lucide-react';
import { ObservationCard, type ObservationCardModel } from './ObservationCard';

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

function yearOf(date: string): string {
  return date.slice(0, 4) || 'Unknown';
}

export function ObservationsSection({
  observations, isDark, loading, tempUnit, onDelete, trashCount = 0, onOpenTrash,
}: Props) {
  const years = [...new Set(observations.map(o => yearOf(o.date)))];
  const grouped = years.length > 1;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className={`font-display flex items-center gap-2 text-lg font-semibold tracking-tight ${
          isDark ? 'text-slate-100' : 'text-slate-900'
        }`}>
          <Calendar className="h-4 w-4 text-accent-500" />
          Observations
        </h2>
        <div className="flex items-center gap-3">
          {trashCount > 0 && onOpenTrash && (
            <button
              type="button"
              onClick={onOpenTrash}
              className={`inline-flex items-center gap-1.5 text-[12px] font-medium transition-colors ${
                isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'
              }`}
              title="See deleted items you can restore to allow re-syncing"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {trashCount} deleted
            </button>
          )}
          {observations.length > 0 && (
            // Observations, not nights: a variant shot alongside its base on one
            // night is two cards here, and calling that two nights would be wrong.
            <span className={`text-sm tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {observations.length} observation{observations.length !== 1 ? 's' : ''}
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
          <p className="text-sm">Nothing captured for this object yet.</p>
        </div>
      ) : grouped ? (
        years.map(year => (
          <div key={year} className="space-y-3">
            <div className="flex items-center gap-3">
              <span className={`font-display text-sm font-semibold tabular-nums ${
                isDark ? 'text-slate-400' : 'text-slate-500'
              }`}>
                {year}
              </span>
              <span className={`h-px flex-1 ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} />
              <span className={`text-xs tabular-nums ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                {observations.filter(o => yearOf(o.date) === year).length}
              </span>
            </div>
            <Grid
              observations={observations.filter(o => yearOf(o.date) === year)}
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
