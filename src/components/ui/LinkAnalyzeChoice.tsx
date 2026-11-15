import { useTranslation } from 'react-i18next';

/**
 * "Measure this folder's sub-frames at night". Shared by the link wizard's last screen and the Linked folders edit
 * dialog, like LinkRefreshChoice. Controlled: the caller owns `checked`.
 */
export function LinkAnalyzeChoice({ checked, onChange, isDark, disabled = false }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  isDark: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation('library');
  const border = isDark ? 'border-slate-800' : 'border-slate-200';
  return (
    <label
      className={`flex items-start gap-3 p-3.5 rounded-xl border transition ${disabled ? 'opacity-60' : 'cursor-pointer'} ${border} ${
        isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="mt-1 accent-amber-500"
      />
      <span className="min-w-0">
        <span className={`block text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{t('linkFolderWizard.analyzeFrames')}</span>
        <span className={`block text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{t('linkFolderWizard.analyzeFramesHint')}</span>
      </span>
    </label>
  );
}
