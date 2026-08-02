import { Link } from 'react-router-dom';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Calendar, Clock, Pencil, CheckCircle2, Merge, Trash2, NotebookPen } from 'lucide-react';
import { reassignSessionTelescope } from '../../lib/api/telescopes';
import type { TelescopeProfile } from '../../lib/api/telescopes';
import type { ObservationDetail } from '../../lib/api/observations';
import { useTheme } from '../../hooks/useTheme';

function formatTime(timestamp: string): string {
  try {
    // YYYYMMDD-HHMMSS format (e.g. 20260330-201431)
    const m = timestamp.match(/^\d{8}-(\d{2})(\d{2})/);
    if (m) return `${m[1]}:${m[2]}`;
    const d = new Date(timestamp);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    return timestamp;
  }
}

/** Breadcrumbs + title/meta row + the telescope reassign popover (a fully
 *  self-contained feature: its own state, outside-click effect, and
 *  mutation don't leak anywhere else in the page) + Move/Delete actions. */
export function ObservationHeader({
  objectId,
  date,
  displayName,
  formattedDate,
  observation,
  isAdmin,
  showTelescopeUI,
  telescopeForObs,
  telescopes,
  onMove,
  onDelete,
  onOpenNotes,
  hasNote,
  canOpenNotes,
}: {
  objectId: string;
  date: string;
  displayName: string;
  formattedDate: string;
  observation: ObservationDetail | undefined;
  isAdmin: boolean;
  showTelescopeUI: boolean;
  telescopeForObs: TelescopeProfile | null;
  telescopes: TelescopeProfile[];
  onMove: () => void;
  onDelete: () => void;
  onOpenNotes: () => void;
  /** Whether a note already exists, which switches the button to "edit". */
  hasNote: boolean;
  canOpenNotes: boolean;
}) {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();

  const [showReassign, setShowReassign] = useState(false);
  const reassignWrapRef = useRef<HTMLSpanElement>(null);
  // Close on outside click / Escape so the popover doesn't linger after the
  // user moves on. Listener is only attached while open.
  useEffect(() => {
    if (!showReassign) return;
    function handleClick(e: MouseEvent) {
      if (
        reassignWrapRef.current &&
        e.target instanceof Node &&
        !reassignWrapRef.current.contains(e.target)
      ) {
        setShowReassign(false);
      }
    }
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setShowReassign(false); }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showReassign]);

  const reassignMutation = useMutation({
    mutationFn: (newTelescopeId: string) => {
      if (!objectId || !date) throw new Error('No session loaded');
      return reassignSessionTelescope(objectId, date, newTelescopeId);
    },
    onSuccess: () => {
      setShowReassign(false);
      queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
      queryClient.invalidateQueries({ queryKey: ['observations'] });
      queryClient.invalidateQueries({ queryKey: ['telescopes'] });
      queryClient.invalidateQueries({ queryKey: ['library-sessions', objectId] });
    },
  });

  return (
    <>
      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 text-sm">
        <Link to="/observations" className={`transition ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}>
          Observations
        </Link>
        <span className={isDark ? 'text-slate-700' : 'text-slate-300'}>/</span>
        <Link to={`/object/${encodeURIComponent(objectId)}`} className={`transition ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}>
          {displayName}
        </Link>
        <span className={isDark ? 'text-slate-700' : 'text-slate-300'}>/</span>
        <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>{formattedDate}</span>
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <Link
            to={`/object/${encodeURIComponent(objectId)}`}
            className={`inline-flex items-center gap-2 text-sm font-medium mb-2 transition ${isDark ? 'text-slate-400 hover:text-accent-400' : 'text-slate-500 hover:text-accent-600'}`}
          >
            <ArrowLeft className="w-4 h-4" />
            Back to {displayName}
          </Link>
          <h1 className={`font-display text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {displayName}
          </h1>
          <div className={`flex flex-wrap items-center gap-4 text-sm mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            <span className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" />
              {formattedDate}
            </span>
            {observation?.startTime && (
              <span className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                {formatTime(observation.startTime)}
                {observation.endTime && observation.endTime !== observation.startTime && (
                  <> - {formatTime(observation.endTime)}</>
                )}
              </span>
            )}
            {observation?.type && (
              <span className={`px-2 py-0.5 rounded-full text-xs ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                {observation.type}
              </span>
            )}
            {/* Telescope chip — only when multiple telescopes are configured.
                Click to filter the calendar; admins can reassign via popover. */}
            {showTelescopeUI && telescopeForObs && (
              <span ref={reassignWrapRef} className="relative inline-flex items-center">
                <Link
                  to={`/observations?telescopeId=${encodeURIComponent(telescopeForObs.id)}`}
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium transition ${
                    isDark ? 'bg-slate-800 hover:bg-slate-700' : 'bg-slate-100 hover:bg-slate-200'
                  }`}
                  title={`Captured on ${telescopeForObs.name}. Click to filter.`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: telescopeForObs.color }}
                    aria-hidden="true"
                  />
                  <span className={isDark ? 'text-slate-300' : 'text-slate-600'}>
                    {telescopeForObs.name}
                  </span>
                </Link>
                {isAdmin && (
                  <button
                    onClick={() => setShowReassign(s => !s)}
                    className={`ml-1 p-1 rounded transition ${
                      isDark ? 'text-slate-500 hover:text-accent-400 hover:bg-slate-800' : 'text-slate-400 hover:text-accent-600 hover:bg-slate-100'
                    }`}
                    title="Reassign to a different telescope"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
                {showReassign && (
                  <div className={`absolute left-0 top-full mt-1 z-30 w-56 rounded-xl border shadow-lg p-2 ${
                    isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
                  }`}>
                    <div className={`px-2 py-1 text-[11px] font-semibold uppercase tracking-wider ${
                      isDark ? 'text-slate-500' : 'text-slate-400'
                    }`}>
                      Reassign to
                    </div>
                    {telescopes.map(t => (
                      <button
                        key={t.id}
                        onClick={() => reassignMutation.mutate(t.id)}
                        disabled={reassignMutation.isPending || t.id === telescopeForObs.id}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left transition disabled:opacity-50 ${
                          isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-50 text-slate-700'
                        }`}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: t.color }}
                        />
                        <span className="flex-1 truncate">{t.name}</span>
                        {t.id === telescopeForObs.id && <CheckCircle2 className="w-3 h-3 text-teal-500" />}
                      </button>
                    ))}
                    {reassignMutation.isError && (
                      <div className={`mt-1 px-2 py-1 text-[11px] rounded ${
                        isDark ? 'text-red-400' : 'text-red-600'
                      }`}>
                        Reassignment failed
                      </div>
                    )}
                  </div>
                )}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {observation && (
            <>
              {/* Notes is an action, so it sits with the other actions. It used
                  to be an amber tile inside the session-metrics grid, where it
                  outweighed every actual measurement on the page. Bordered like
                  its siblings so it reads as a button at rest, not only on
                  hover — a bare hover-tint doesn't signal "clickable" until the
                  cursor happens to land on it. */}
              {canOpenNotes && (isAdmin || hasNote) && (
                <button
                  onClick={onOpenNotes}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border transition ${
                    hasNote
                      ? isDark
                        ? 'border-accent-500/30 bg-accent-500/10 text-accent-400 hover:bg-accent-500/15'
                        : 'border-accent-300 bg-accent-50 text-accent-700 hover:bg-accent-100'
                      : isDark
                        ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                  title={isAdmin ? (hasNote ? 'Edit session notes' : 'Add session notes') : 'View session notes'}
                >
                  <NotebookPen className="w-4 h-4" />
                  Notes
                  {hasNote && <CheckCircle2 className="w-3.5 h-3.5" />}
                </button>
              )}
              {isAdmin && (
                <button
                  onClick={onMove}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border transition ${
                    isDark
                      ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                  title="Combine this session with another object's observation"
                >
                  <Merge className="w-4 h-4" />
                  Combine
                </button>
              )}
              {isAdmin && (
                <button
                  onClick={onDelete}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border transition ${
                    isDark
                      ? 'border-red-500/30 text-red-400 hover:bg-red-500/10'
                      : 'border-red-200 text-red-600 hover:bg-red-50'
                  }`}
                  title="Delete observation"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
