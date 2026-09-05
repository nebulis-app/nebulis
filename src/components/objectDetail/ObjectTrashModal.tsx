/**
 * Deleting an object or an observation blocks it from re-syncing, but that
 * block isn't meant to be permanent the way the local file deletion is. This
 * modal is the undo for the block, scoped to whatever the caller has already
 * filtered down to this object (base id + variants) — the counterpart used to
 * live as one global list in Settings, which put "can this re-sync?" three
 * clicks away from the object it was actually about.
 */
import { RotateCcw, RotateCw, X } from 'lucide-react';
import { Modal } from '../ui/Modal';
import type { DeletedObject, DeletedSession } from '../../lib/api/library';

interface Props {
  isDark: boolean;
  objectName: string;
  deletedObjects: DeletedObject[];
  deletedSessions: DeletedSession[];
  onRestoreObject: (objectId: string) => void;
  onRestoreSession: (args: { objectId: string; date: string }) => void;
  restoringObjectId: string | null;
  restoringSession: { objectId: string; date: string } | null;
  error: string | null;
  onClose: () => void;
}

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

export function ObjectTrashModal({
  isDark,
  objectName,
  deletedObjects,
  deletedSessions,
  onRestoreObject,
  onRestoreSession,
  restoringObjectId,
  restoringSession,
  error,
  onClose,
}: Props) {
  const rowBase = 'flex items-center justify-between gap-3 py-2.5';
  const nameClass = `text-[13px] font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`;
  const metaClass = `text-[12px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`;
  const restoreBtn = `shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
    isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
  }`;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Deleted from ${objectName}`}
      className={`relative w-full max-w-md rounded-2xl shadow-2xl flex flex-col ${
        isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white shadow-xl'
      }`}
    >
      <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        <div className="flex items-center gap-2">
          <RotateCcw className="w-4 h-4 text-accent-500" />
          <h2 className={`font-display font-semibold text-base ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            Deleted from {objectName}
          </h2>
        </div>
        <button
          onClick={onClose}
          className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 max-h-96">
        <p className={`text-[12px] leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          Blocked from re-syncing until restored. Local files are already gone; restoring only lets
          the telescope send this back next time it images the same target.
        </p>

        {deletedObjects.length > 0 && (
          <div>
            <h4 className={`text-[11px] font-semibold uppercase tracking-widest mb-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Object
            </h4>
            <ul className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-slate-100'}`}>
              {deletedObjects.map(obj => (
                <li key={obj.objectId} className={rowBase}>
                  <div className="min-w-0">
                    <p className={nameClass}>{obj.objectName || obj.objectId}</p>
                    <p className={metaClass}>Deleted {formatDeletedAt(obj.deletedAt)}</p>
                  </div>
                  <button
                    type="button"
                    className={restoreBtn}
                    disabled={restoringObjectId === obj.objectId}
                    onClick={() => onRestoreObject(obj.objectId)}
                  >
                    {restoringObjectId === obj.objectId
                      ? <RotateCw className="w-3.5 h-3.5 animate-spin" />
                      : <RotateCcw className="w-3.5 h-3.5" />}
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {deletedSessions.length > 0 && (
          <div>
            <h4 className={`text-[11px] font-semibold uppercase tracking-widest mb-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Observations
            </h4>
            <ul className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-slate-100'}`}>
              {deletedSessions.map(session => {
                const key = `${session.objectId}:${session.date}`;
                const pending = restoringSession?.objectId === session.objectId && restoringSession?.date === session.date;
                return (
                  <li key={key} className={rowBase}>
                    <div className="min-w-0">
                      <p className={nameClass}>{formatSessionDate(session.date)}</p>
                      <p className={metaClass}>Deleted {formatDeletedAt(session.deletedAt)}</p>
                    </div>
                    <button
                      type="button"
                      className={restoreBtn}
                      disabled={pending}
                      onClick={() => onRestoreSession({ objectId: session.objectId, date: session.date })}
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

        {error && (
          <div className={`rounded-lg px-3.5 py-3 text-[12px] ${isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'}`}>
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
