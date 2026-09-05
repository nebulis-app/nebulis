/**
 * Confirmation for the two destructive things an object page can do: delete the
 * object, or delete one of its nights.
 *
 * Built on the shared Modal primitive rather than a hand-rolled fixed overlay,
 * which is what gets focus trapping, Escape, scroll locking and a real
 * `role="dialog"`. It is not the plain ConfirmModal because both of these can
 * genuinely fail server-side (an unreachable library answers 503), and a delete
 * dialog that closes on a failure it never reported is worse than no dialog.
 */
import { AlertTriangle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Modal } from '../ui/Modal';
import { useTheme } from '../../hooks/useTheme';

export function DangerConfirm({
  title, body, confirmLabel = 'Delete permanently', pending, error, onConfirm, onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { isDark } = useTheme();

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={title}
      className={`mx-4 w-full max-w-md space-y-4 rounded-2xl p-6 ${
        isDark ? 'border border-slate-800 bg-slate-900' : 'bg-white shadow-xl'
      }`}
    >
      <div className="flex items-center gap-3 text-red-500">
        <AlertTriangle className="h-6 w-6 shrink-0" />
        <h3 className="font-display text-lg font-semibold">{title}</h3>
      </div>

      <div className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{body}</div>

      {error != null && (
        <p className="text-sm text-red-500">
          {error instanceof Error ? error.message : 'That did not work. Try again.'}
        </p>
      )}

      <div className="flex justify-end gap-3">
        <button
          onClick={onCancel}
          className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
            isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium
            text-white transition hover:bg-red-700 disabled:opacity-50"
        >
          {pending && <RotateCw className="h-4 w-4 animate-spin" />}
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
