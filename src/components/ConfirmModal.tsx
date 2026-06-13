import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const { isDark } = useTheme();

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={title}
      className={`rounded-2xl border p-6 w-full max-w-sm shadow-2xl mx-4 ${
        isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
      }`}
    >
      <h2 className={`text-base font-semibold mb-2 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
        {title}
      </h2>
      <p className={`text-sm mb-6 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        {message}
      </p>
      <div className="flex justify-end gap-3">
        <button
          onClick={onCancel}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
            isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="px-4 py-2 rounded-xl text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition"
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
