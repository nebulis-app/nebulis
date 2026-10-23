import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { REFRESH_CHOICES } from '../../lib/linkRefresh';

/**
 * One-time or ongoing, and how often. Shared by the link wizard's last screen and the Linked folders
 * edit dialog, so a folder is described the same way when it is linked and when it is changed later.
 * Controlled: the caller owns `ongoing` and `minutes`.
 */
export function LinkRefreshChoice({
  ongoing,
  minutes,
  onOngoingChange,
  onMinutesChange,
  isDark,
  inputCls,
  disabled = false,
}: {
  ongoing: boolean;
  minutes: number;
  onOngoingChange: (ongoing: boolean) => void;
  onMinutesChange: (minutes: number) => void;
  isDark: boolean;
  inputCls: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('library');
  const groupName = useId();
  const strong = isDark ? 'text-slate-200' : 'text-slate-800';
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';
  const mutedText = isDark ? 'text-slate-500' : 'text-slate-400';
  const border = isDark ? 'border-slate-800' : 'border-slate-200';

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label={t('linkFolderWizard.scheduleTitle')} className="space-y-2">
        {([false, true] as const).map(isOngoing => {
          const selectedMode = ongoing === isOngoing;
          return (
            <label
              key={String(isOngoing)}
              className={`flex items-start gap-3 p-3.5 rounded-xl border transition ${disabled ? 'opacity-60' : 'cursor-pointer'} ${
                selectedMode
                  ? isDark ? 'border-accent-500/70 bg-accent-500/10' : 'border-accent-500 bg-accent-50'
                  : `${border} ${isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'}`
              }`}
            >
              <input
                type="radio"
                name={groupName}
                checked={selectedMode}
                disabled={disabled}
                onChange={() => onOngoingChange(isOngoing)}
                className="mt-1 accent-amber-500"
              />
              <span className="min-w-0">
                <span className={`block text-sm font-medium ${strong}`}>
                  {t(isOngoing ? 'linkFolderWizard.refreshOngoing' : 'linkFolderWizard.refreshOnce')}
                </span>
                <span className={`block text-xs mt-0.5 ${subText}`}>
                  {t(isOngoing ? 'linkFolderWizard.refreshOngoingHint' : 'linkFolderWizard.refreshOnceHint')}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {ongoing && (
        <label className="block">
          <span className={`text-xs font-medium ${subText}`}>{t('linkFolderWizard.refreshFrequency')}</span>
          <select
            value={minutes}
            disabled={disabled}
            onChange={e => onMinutesChange(Number(e.target.value))}
            className={`${inputCls} w-full mt-1`}
          >
            {REFRESH_CHOICES.map(c => (
              <option key={c.minutes} value={c.minutes}>{t(c.labelKey)}</option>
            ))}
          </select>
          <span className={`block text-xs mt-1 ${mutedText}`}>{t('linkFolderWizard.refreshOfflineHint')}</span>
        </label>
      )}
    </div>
  );
}
