/**
 * Restore for sessions a sync keeps leaving on the telescope because they were
 * deleted locally. The "files belonging to sessions you deleted" line on the
 * Backup Status page points here.
 *
 * Deleting a session tombstones its date so it never re-imports. This is the
 * undo for that block: it does not bring back files that were on disk, it only
 * clears the block so the next sync brings the session across again. That is
 * exactly what the skipped files on the Backup page need, since they were never
 * imported in the first place.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, RotateCw, Trash2, X } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { getDeletedSessions, restoreLibrarySession, type DeletedSession } from '../../lib/api/library';
import { formatRelativeTime } from '../../lib/timeFormat';

function formatSessionDate(date: string): string {
  const ms = Date.parse(`${date}T12:00:00`);
  if (Number.isNaN(ms)) return date;
  return new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export function DeletedSessionsModal({
  isOpen, isDark, onClose,
}: {
  isOpen: boolean;
  isDark: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const { data: sessions } = useQuery({
    queryKey: ['deleted-sessions'],
    queryFn: getDeletedSessions,
    enabled: isOpen,
  });

  const restore = useMutation({
    mutationFn: ({ objectId, date }: { objectId: string; date: string }) => restoreLibrarySession(objectId, date),
    onMutate: ({ objectId, date }) => { setPendingKey(`${objectId}:${date}`); setError(null); },
    onError: (err) => setError(err instanceof Error ? err.message : 'Restore failed'),
    onSettled: () => {
      setPendingKey(null);
      queryClient.invalidateQueries({ queryKey: ['deleted-sessions'] });
      queryClient.invalidateQueries({ queryKey: ['import-history'] });
      queryClient.invalidateQueries({ queryKey: ['import-status'] });
    },
  });

  const restoreAll = async (rows: DeletedSession[]) => {
    for (const s of rows) {
      try {
        await restore.mutateAsync({ objectId: s.objectId, date: s.date });
      } catch {
        break; // onError already surfaced it
      }
    }
  };

  const rows = sessions ?? [];
  const restoreBtn = `shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
    isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
  }`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Deleted sessions"
      className={`flex max-h-[75vh] w-full max-w-md flex-col overflow-hidden rounded-2xl ${
        isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white shadow-xl'
      }`}
    >
      <div className={`flex items-center justify-between border-b px-5 py-4 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <h2 className={`font-display flex items-center gap-2 font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
          <Trash2 className="h-4 w-4 text-accent-500" />
          Deleted sessions
        </h2>
        <button
          onClick={onClose}
          aria-label="Close"
          className={`rounded-lg p-1.5 transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          These dates are blocked from syncing. Restore one and the next sync brings its files across.
        </p>

        {rows.length === 0 ? (
          <p className={`mt-6 text-center text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            No deleted sessions. Sessions you delete show up here so you can bring them back.
          </p>
        ) : (
          <ul className={`mt-3 divide-y ${isDark ? 'divide-slate-800' : 'divide-slate-100'}`}>
            {rows.map(session => {
              const key = `${session.objectId}:${session.date}`;
              const pending = pendingKey === key;
              return (
                <li key={key} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className={`truncate text-[13px] font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                      <span>{session.objectName || session.folderName}</span>
                      <span className={`ml-1.5 font-normal ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        {formatSessionDate(session.date)}
                      </span>
                    </p>
                    {session.deletedAt && (
                      <p className={`text-[12px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        Deleted {formatRelativeTime(session.deletedAt)}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    className={restoreBtn}
                    disabled={pending}
                    onClick={() => restore.mutate({ objectId: session.objectId, date: session.date })}
                  >
                    {pending ? <RotateCw className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    Restore
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {error && (
          <div className={`mt-4 rounded-lg px-3.5 py-3 text-xs ${isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'}`}>
            {error}
          </div>
        )}
      </div>

      {rows.length > 1 && (
        <div className={`border-t px-5 py-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <button
            type="button"
            disabled={restore.isPending}
            onClick={() => void restoreAll(rows)}
            className={`w-full rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${
              isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
            }`}
          >
            Restore all {rows.length}
          </button>
        </div>
      )}
    </Modal>
  );
}
