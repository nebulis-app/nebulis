import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';

import type { ArchiveConfig, ArchiveDestinationState } from '../../lib/api/storage';
import { CleanupFields, CopyFields, DiskFields, ScheduleFields } from './ArchiveFields';
import { hasDestination, WIZARD_STEPS, type ArchiveGroup, type ArchiveSummary, type WizardStep } from './archiveForm';
import { archiveStyles } from './archiveStyles';

interface WizardProps {
  isDark: boolean;
  form: ArchiveConfig;
  edit: (patch: Partial<ArchiveConfig>) => void;
  busy: boolean;
  step: WizardStep;
  onStep: (step: WizardStep) => void;
  onCancel: () => void;
  destinationPath: string;
  state: ArchiveDestinationState | null;
  sameDisk: boolean;
  isNetwork: boolean;
  adoptable: boolean;
  onChoose: () => void;
  onPathTyped: () => void;
  onToggleRetention: (next: boolean) => void;
  onToggleRemoveLocal: (next: boolean) => void;
  summary: ArchiveSummary;
  /** Saves the chosen disk and reports whether it can be used. Saving writes nothing to
   *  the disk, so this is safe to run on every Next. */
  onSaveDisk: () => Promise<boolean>;
  onFinish: () => void;
}

/**
 * Setting the archive up, one decision at a time.
 *
 * **Nothing is switched on until the last step.** The old page armed the master switch
 * first and then asked for everything else, so a half-configured archive was a live one.
 * Here the settings are gathered as edits and sent together with the switch, in one
 * save, when the user presses the final button on the review.
 *
 * **It is inline, not a modal.** Choosing a disk opens a picker of its own, pruning
 * needs room for its explanation, and the same fields have to be editable later, so a
 * dismissible overlay would only ever cover the first run.
 *
 * **The disk is claimed last, not first.** Adopting writes a marker to the disk, which
 * the server refuses while the archive is off. So the disk step only records and checks
 * the folder, says plainly if it will be claimed, and the claim happens when the
 * archive is turned on.
 */
export function ArchiveSetupWizard(props: WizardProps) {
  const { t } = useTranslation('settings');
  const { isDark, form, busy, step, onStep, onCancel, summary, state } = props;
  const s = archiveStyles(isDark);
  const index = WIZARD_STEPS.indexOf(step);
  const isLast = step === 'review';

  /** What stops the user leaving a step. Only the two that would otherwise send the
   *  server a value it refuses; everything else has a valid default. */
  const blocked =
    (step === 'disk' && !hasDestination(form)) ||
    (step === 'schedule' && form.scheduleEnabled && form.scheduleMode === 'custom' && form.scheduleCron.trim() === '');

  const next = async () => {
    if (step === 'disk' && !(await props.onSaveDisk())) return;
    onStep(WIZARD_STEPS[Math.min(index + 1, WIZARD_STEPS.length - 1)]);
  };

  const stepTitle = t(`archive.steps.${step}.title`);
  const fieldProps = { isDark, form, edit: props.edit, busy };

  return (
    <div>
      <ol className={`flex items-center gap-1 border-b px-5 py-4 ${s.divider}`} aria-label={t('archive.steps.label')}>
        {WIZARD_STEPS.map((id, i) => {
          const done = i < index;
          const current = i === index;
          return (
            <li key={id} className="flex min-w-0 flex-1 items-center gap-2" aria-current={current ? 'step' : undefined}>
              <button
                type="button"
                // Only steps already passed can be returned to. Skipping ahead would
                // skip the disk check the later steps rely on.
                disabled={!done || busy}
                onClick={() => onStep(id)}
                className="flex min-w-0 items-center gap-2 disabled:cursor-default"
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-semibold ${
                    current
                      ? 'bg-accent-500 text-white'
                      : done
                        ? isDark
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-emerald-100 text-emerald-700'
                        : isDark
                          ? 'bg-slate-800 text-slate-500'
                          : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
                </span>
                <span
                  className={`hidden truncate text-[0.75rem] font-medium sm:inline ${
                    current ? s.strongText : s.subText
                  }`}
                >
                  {t(`archive.steps.${id}.name`)}
                </span>
              </button>
              {i < WIZARD_STEPS.length - 1 && (
                <span className={`h-px min-w-3 flex-1 ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>

      <div className="px-5 py-5">
        <h4 className={`text-[0.875rem] font-semibold ${s.strongText}`}>{stepTitle}</h4>
        <p className={`mb-5 mt-1 text-[0.75rem] leading-relaxed ${s.subText}`}>{t(`archive.steps.${step}.body`)}</p>

        {step === 'disk' && (
          <>
            <DiskFields
              {...fieldProps}
              destinationPath={props.destinationPath}
              state={state}
              sameDisk={props.sameDisk}
              isNetwork={props.isNetwork}
              onChoose={props.onChoose}
              onPathTyped={props.onPathTyped}
            />
            {props.adoptable && (
              <p className={`mt-4 text-[0.75rem] leading-relaxed ${s.subText}`}>{t('archive.steps.disk.claimNote')}</p>
            )}
          </>
        )}
        {step === 'copy' && <CopyFields {...fieldProps} />}
        {step === 'schedule' && <ScheduleFields {...fieldProps} />}
        {step === 'cleanup' && (
          <CleanupFields
            {...fieldProps}
            onToggleRetention={props.onToggleRetention}
            onToggleRemoveLocal={props.onToggleRemoveLocal}
          />
        )}
        {step === 'review' && (
          <ReviewStep isDark={isDark} summary={summary} claims={props.adoptable} onEdit={group => onStep(group)} />
        )}
      </div>

      <div className={`flex items-center justify-between gap-3 border-t px-5 py-4 ${s.divider}`}>
        <button type="button" onClick={onCancel} disabled={busy} className={`${s.btnBase} ${s.btnSubtle}`}>
          {t('archive.wizard.cancel')}
        </button>
        <div className="flex items-center gap-2">
          {index > 0 && (
            <button
              type="button"
              onClick={() => onStep(WIZARD_STEPS[index - 1])}
              disabled={busy}
              className={`${s.btnBase} ${s.btnSubtle}`}
            >
              {t('archive.wizard.back')}
            </button>
          )}
          {isLast ? (
            <button
              type="button"
              onClick={props.onFinish}
              disabled={busy || !hasDestination(form)}
              className={`${s.btnBase} ${s.btnPrimary}`}
            >
              {busy ? t('archive.wizard.finishing') : t('archive.wizard.finish')}
            </button>
          ) : (
            <button type="button" onClick={next} disabled={busy || blocked} className={`${s.btnBase} ${s.btnPrimary}`}>
              {t('archive.wizard.next')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** What all the steps add up to, grouped the way they were asked, each group with a way
 *  back to change it. It sits directly above the button that arms the archive, because
 *  it is the sentence a user should read before pressing it. */
function ReviewStep({
  isDark,
  summary,
  claims,
  onEdit,
}: {
  isDark: boolean;
  summary: ArchiveSummary;
  /** The disk holds no archive of this install's yet, so turning the archive on claims it. */
  claims: boolean;
  onEdit: (group: ArchiveGroup) => void;
}) {
  const { t } = useTranslation('settings');
  const s = archiveStyles(isDark);
  const groups: Array<{ id: ArchiveGroup; lines: string[] }> = [
    { id: 'disk', lines: [summary.disk] },
    { id: 'copy', lines: summary.copy },
    { id: 'schedule', lines: [summary.schedule] },
    { id: 'cleanup', lines: summary.cleanup },
  ];

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {groups.map(group => (
          <li key={group.id} className={`rounded-xl border px-4 py-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <div className="flex items-center justify-between gap-3">
              <div className={`text-[0.625rem] font-semibold uppercase tracking-[0.1em] ${s.subText}`}>
                {t(`archive.steps.${group.id}.name`)}
              </div>
              <button
                type="button"
                onClick={() => onEdit(group.id)}
                className={`text-[0.75rem] font-medium ${isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-600 hover:text-accent-700'}`}
              >
                {t('archive.overview.edit')}
              </button>
            </div>
            <ul className="mt-1.5 space-y-1">
              {group.lines.map(line => (
                <li key={line} className={`text-[0.8125rem] leading-relaxed ${s.strongText}`}>
                  {line}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {claims && <p className={`text-[0.75rem] leading-relaxed ${s.subText}`}>{t('archive.steps.disk.claimNote')}</p>}
      <p className={`text-[0.75rem] leading-relaxed ${s.subText}`}>{t('archive.steps.review.warning')}</p>
    </div>
  );
}
