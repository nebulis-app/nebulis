import { useTranslation } from 'react-i18next';
import { useTheme } from '../../hooks/useTheme';
import { Modal } from './Modal';

interface PlanConflictDialogProps {
  /** "tonight" or a formatted date, for the copy. */
  nightLabel: string;
  /** How many blocks are already scheduled for that night. */
  existingCount: number;
  /** Wipe the night's existing blocks, then create the new plan. */
  onReplace: () => void;
  /** Keep the existing blocks and add the new ones alongside them. */
  onAdd: () => void;
  onCancel: () => void;
  /** Disables the action buttons while the create/delete work runs. */
  pending?: boolean;
}

/**
 * Shown when "Plan Tonight" from a catalog would land on a night that already
 * has a plan. Three ways out: replace it, add to it, or back out.
 */
export function PlanConflictDialog({
  nightLabel,
  existingCount,
  onReplace,
  onAdd,
  onCancel,
  pending = false,
}: PlanConflictDialogProps) {
  const { t } = useTranslation('planner');
  const { isDark } = useTheme();
  const title = t('planConflictDialog.title', { nightLabel });

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
        {t('planConflictDialog.body', { count: existingCount, nightLabel })}
      </p>
      <div className="flex flex-col gap-2">
        <button
          onClick={() => { if (!pending) onReplace(); }}
          disabled={pending}
          className="px-4 py-2 rounded-xl text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t('planConflictDialog.replace')}
        </button>
        <button
          onClick={() => { if (!pending) onAdd(); }}
          disabled={pending}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${
            isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          {t('planConflictDialog.addToExisting')}
        </button>
        <button
          onClick={onCancel}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
            isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
          }`}
        >
          {t('planConflictDialog.cancel')}
        </button>
      </div>
    </Modal>
  );
}
