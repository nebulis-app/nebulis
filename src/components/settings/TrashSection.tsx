import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, RotateCw } from 'lucide-react';
import {
  getDeletedObjects,
  getDeletedSessions,
  restoreLibraryObject,
  restoreLibrarySession,
  type DeletedObject,
  type DeletedSession,
} from '../../lib/api/library';
import { Sec } from './SettingsUI';

function formatDeletedAt(deletedAt: string | null): string {
  if (!deletedAt) return 'Date unknown';
  const ms = Date.parse(deletedAt);
  if (Number.isNaN(ms)) return 'Date unknown';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatSessionDate(date: string): string {
  const ms = Date.parse(`${date}T12:00:00`);
  if (Number.isNaN(ms)) return date;
  return new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * The trash: objects and sessions deleted locally but not yet restored.
 *
 * Deleting was a one-way door: the confirm dialog said "this cannot be undone"
 * and meant it two different ways at once. Local files really are gone the
 * moment you confirm — nothing here brings them back. But the *decision* to
 * block that object or session from ever re-syncing was also permanent, with
 * no way to change your mind, and that half didn't need to be. This is that
 * second door. Restoring re-enables sync; the data itself only comes back if
 * the telescope (or another import source) still has it.
 */
export function TrashSection({ isDark }: { isDark: boolean }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const objectsQuery = useQuery({
    queryKey: ['deleted-objects'],
    queryFn: getDeletedObjects,
    staleTime: 15_000,
  });
  const sessionsQuery = useQuery({
    queryKey: ['deleted-sessions'],
    queryFn: getDeletedSessions,
    staleTime: 15_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['deleted-objects'] });
    queryClient.invalidateQueries({ queryKey: ['deleted-sessions'] });
    // The library grid and object detail both filter on `deleted`, so a
    // restore has to be visible there too, not just in this list.
    queryClient.invalidateQueries({ queryKey: ['library-objects'] });
  };

  const restoreObject = useMutation({
    mutationFn: (objectId: string) => restoreLibraryObject(objectId),
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });
  const restoreSession = useMutation({
    mutationFn: ({ objectId, date }: { objectId: string; date: string }) => restoreLibrarySession(objectId, date),
    onSuccess: invalidate,
    onError: (err: Error) => setError(err.message),
  });

  const objects: DeletedObject[] = objectsQuery.data ?? [];
  const sessions: DeletedSession[] = sessionsQuery.data ?? [];
  const isEmpty = objects.length === 0 && sessions.length === 0;

  const rowBase = 'flex items-center justify-between gap-3 py-2.5';
  const nameClass = `text-[13px] font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`;
  const metaClass = `text-[12px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`;
  const restoreBtn = `shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
    isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
  }`;

  return (
    <Sec
      title="Trash"
      description="Objects and observations you deleted, blocked from re-syncing until restored."
      isDark={isDark}
    >
      <div className="px-5 py-5 space-y-5">
        {isEmpty ? (
          <p className={`text-[13px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            Nothing in the trash. When you delete an object or an observation, it stays listed here so
            you can undo the block on re-syncing it. Local files are removed immediately and deleting
            them cannot be undone; only the block on re-syncing can.
          </p>
        ) : (
          <>
            {objects.length > 0 && (
              <div>
                <h4 className={`text-[11px] font-semibold uppercase tracking-widest mb-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  Objects
                </h4>
                <ul className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-slate-100'}`}>
                  {objects.map(obj => (
                    <li key={obj.objectId} className={rowBase}>
                      <div className="min-w-0">
                        <p className={nameClass}>{obj.objectName || obj.objectId}</p>
                        <p className={metaClass}>Deleted {formatDeletedAt(obj.deletedAt)}</p>
                      </div>
                      <button
                        type="button"
                        className={restoreBtn}
                        disabled={restoreObject.isPending && restoreObject.variables === obj.objectId}
                        onClick={() => { setError(null); restoreObject.mutate(obj.objectId); }}
                      >
                        {restoreObject.isPending && restoreObject.variables === obj.objectId
                          ? <RotateCw className="w-3.5 h-3.5 animate-spin" />
                          : <RotateCcw className="w-3.5 h-3.5" />}
                        Restore
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {sessions.length > 0 && (
              <div>
                <h4 className={`text-[11px] font-semibold uppercase tracking-widest mb-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  Observations
                </h4>
                <ul className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-slate-100'}`}>
                  {sessions.map(session => {
                    const key = `${session.objectId}:${session.date}`;
                    const pending = restoreSession.isPending
                      && restoreSession.variables?.objectId === session.objectId
                      && restoreSession.variables?.date === session.date;
                    return (
                      <li key={key} className={rowBase}>
                        <div className="min-w-0">
                          <p className={nameClass}>
                            {session.objectName || session.objectId}
                            <span className={isDark ? 'text-slate-500' : 'text-slate-400'}> · {formatSessionDate(session.date)}</span>
                          </p>
                          <p className={metaClass}>Deleted {formatDeletedAt(session.deletedAt)}</p>
                        </div>
                        <button
                          type="button"
                          className={restoreBtn}
                          disabled={pending}
                          onClick={() => { setError(null); restoreSession.mutate({ objectId: session.objectId, date: session.date }); }}
                        >
                          {pending ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                          Restore
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}

        {error && (
          <div className={`rounded-lg px-3.5 py-3 text-[12px] ${isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'}`}>
            {error}
          </div>
        )}
      </div>
    </Sec>
  );
}
