import { useTranslation } from 'react-i18next';

const STEP_KEYS = ['step1Name', 'step2Name', 'step3Name'] as const;

/** The progress line shared by the import dialog and the review that follows it: Choose, Options, then Add
 *  (upload and copy) or Review & link (a linked folder). The import dialog shows steps 1 and 2; the link review
 *  is step 3. */
export function ImportStepIndicator({ step, linking, isDark }: { step: 1 | 2 | 3; linking: boolean; isDark: boolean }) {
  const { t } = useTranslation('library');
  return (
    <ol className="flex items-center justify-center gap-2" aria-label={t('importModal.stepOf', { current: step, total: 3 })}>
      {STEP_KEYS.map((key, i) => {
        const n = i + 1;
        const done = n < step;
        const active = n === step;
        return (
          <li key={key} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
            <span
              className={`flex items-center justify-center w-5 h-5 rounded-full text-[0.6875rem] font-semibold ${
                active
                  ? 'bg-accent-500 text-white'
                  : done
                    ? isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-700'
                    : isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'
              }`}
            >
              {done ? '✓' : n}
            </span>
            <span className={`text-xs ${active ? (isDark ? 'text-slate-200 font-medium' : 'text-slate-800 font-medium') : isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t(linking && key === 'step3Name' ? 'importModal.step3NameLink' : `importModal.${key}`)}
            </span>
            {n < 3 && <span aria-hidden className={`w-6 h-px ${isDark ? 'bg-slate-700' : 'bg-slate-300'}`} />}
          </li>
        );
      })}
    </ol>
  );
}
