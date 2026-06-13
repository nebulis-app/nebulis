import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, X } from 'lucide-react';
import { reassignTelescopeSessions, type TelescopeProfile } from '../../lib/api/telescopes';

/**
 * "Move all sessions from telescope A → B" picker.
 *
 * Used for hardware replacement (e.g. broken S30 → new S50). Lists every
 * non-archived telescope except the source as a target, calls the bulk
 * reassign endpoint, and reports how many rows moved.
 */
export function ReassignTelescopeModal({
  source,
  candidates,
  isDark,
  onClose,
}: {
  source: TelescopeProfile;
  candidates: TelescopeProfile[];
  isDark: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [targetId, setTargetId] = useState<string>(candidates[0]?.id ?? '');
  const [result, setResult] = useState<{ sessionsUpdated: number; objectsUpdated: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => reassignTelescopeSessions(source.id, targetId),
    onSuccess: data => {
      setResult(data);
      setErrorMsg(null);
      queryClient.invalidateQueries({ queryKey: ['telescopes'] });
      queryClient.invalidateQueries({ queryKey: ['objects'] });
      queryClient.invalidateQueries({ queryKey: ['observations'] });
    },
    onError: (e: Error) => setErrorMsg(e.message),
  });

  const sessionCount = source.sessionCount ?? 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reassign telescope sessions"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className={`w-full max-w-md rounded-2xl border shadow-xl ${
          isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200/60 dark:border-slate-800/60">
          <h3 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-slate-800'}`}>
            Move sessions
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {result ? (
            <div className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Moved <strong>{result.sessionsUpdated}</strong> session{result.sessionsUpdated === 1 ? '' : 's'} and{' '}
              <strong>{result.objectsUpdated}</strong> object attribution{result.objectsUpdated === 1 ? '' : 's'}.
              Future syncs of those sessions will hit the new telescope.
            </div>
          ) : (
            <>
              <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                Move every session captured by <strong>{source.name}</strong>
                {sessionCount > 0 && <> ({sessionCount} session{sessionCount === 1 ? '' : 's'})</>}
                {' '}to another telescope. Existing local files stay where they are; only the attribution changes,
                so future re-syncs will hit the new telescope.
              </p>

              <div className="flex items-center gap-3">
                {/* Source — read-only */}
                <div className={`flex-1 rounded-lg border px-3 py-2 ${
                  isDark ? 'bg-slate-800/50 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
                }`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: source.color || '#8b5cf6' }}
                    />
                    <span className="text-sm truncate">{source.name}</span>
                  </div>
                </div>

                <ArrowRight className={`shrink-0 w-4 h-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />

                {/* Target — picker */}
                {candidates.length === 0 ? (
                  <div className={`flex-1 rounded-lg border px-3 py-2 text-sm italic ${
                    isDark ? 'bg-slate-800/50 border-slate-700 text-slate-500' : 'bg-slate-50 border-slate-200 text-slate-400'
                  }`}>
                    No other active telescope
                  </div>
                ) : (
                  <select
                    value={targetId}
                    onChange={e => setTargetId(e.target.value)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm ${
                      isDark
                        ? 'bg-slate-800 border-slate-700 text-slate-200'
                        : 'bg-white border-slate-200 text-slate-700'
                    }`}
                  >
                    {candidates.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                )}
              </div>

              {errorMsg && (
                <p className="text-sm text-rose-500">{errorMsg}</p>
              )}
            </>
          )}
        </div>

        <div className={`flex items-center justify-end gap-2 px-5 py-3 border-t ${
          isDark ? 'border-slate-800' : 'border-slate-200/60'
        }`}>
          {result ? (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-accent-500 text-white text-sm font-medium hover:bg-accent-600 transition"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => mutation.mutate()}
                disabled={!targetId || mutation.isPending || candidates.length === 0}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
                  !targetId || candidates.length === 0
                    ? isDark ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'bg-accent-500 text-white hover:bg-accent-600'
                }`}
              >
                {mutation.isPending ? 'Moving…' : 'Move sessions'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
