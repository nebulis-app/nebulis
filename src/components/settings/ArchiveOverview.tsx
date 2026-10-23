import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Play } from 'lucide-react';

import type { ArchiveConfig, ArchiveDestinationState } from '../../lib/api/storage';
import { CleanupFields, CopyFields, DiskFields, ScheduleFields } from './ArchiveFields';
import { ARCHIVE_GROUPS, type ArchiveGroup, type ArchiveSummary } from './archiveForm';
import { archiveStyles, STATE_ICON, stateColor } from './archiveStyles';
import { RowGroup } from './SettingsUI';

interface OverviewProps {
  isDark: boolean;
  form: ArchiveConfig;
  edit: (patch: Partial<ArchiveConfig>) => void;
  busy: boolean;
  destinationPath: string;
  state: ArchiveDestinationState | null;
  sameDisk: boolean;
  isNetwork: boolean;
  adoptable: boolean;
  summary: ArchiveSummary;
  running: boolean;
  progress: { done: number; total: number } | null;
  lastResult: string;
  /** The stored retention switch, which is what the apply route checks. */
  storedRetentionEnabled: boolean;
  onChoose: () => void;
  onPathTyped: () => void;
  onAdopt: () => void;
  onRunNow: () => void;
  onCancelRun: () => void;
  onBrowse: () => void;
  onPrune: () => void;
  onTurnOff: () => void;
  onToggleRetention: (next: boolean) => void;
  onToggleRemoveLocal: (next: boolean) => void;
  onSaveGroup: (group: ArchiveGroup) => Promise<boolean>;
  /** Drops unsaved edits, when a group is closed or another is opened. */
  onDiscard: () => void;
}

/**
 * The archive once it is on: what it is doing, then the settings one group at a time.
 *
 * The status block answers "is it working?" without opening anything: the disk, whether
 * it is the right one, and how the last run went, with the buttons that act on the disk
 * beside it. The settings below are read as a sentence each and opened individually,
 * one at a time, so a change is a small, saved-on-its-own edit rather than a long form
 * with one Save at the foot that a user has to remember to press.
 */
export function ArchiveOverview(props: OverviewProps) {
  const { t } = useTranslation('settings');
  const { isDark, form, busy, state, summary } = props;
  const s = archiveStyles(isDark);
  const [open, setOpen] = useState<ArchiveGroup | null>(null);
  const StateIcon = STATE_ICON[state ?? 'unconfigured'];
  const stateKey = state
    ? `archive.state.${state === 'invalid-path' ? 'invalidPath' : state}`
    : 'archive.state.unconfigured';

  const openGroup = (group: ArchiveGroup | null) => {
    props.onDiscard();
    setOpen(group);
  };

  const rowValue: Record<ArchiveGroup, string[]> = {
    disk: [summary.disk],
    copy: summary.copy,
    schedule: [summary.schedule],
    cleanup: summary.cleanup,
  };

  const fieldProps = { isDark, form, edit: props.edit, busy };

  return (
    <div>
      <div className={`space-y-4 border-b px-5 py-4 ${s.divider}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
              <div className={`text-[0.8125rem] font-semibold ${s.strongText}`}>{t('archive.overview.on')}</div>
            </div>
            <div className={`mt-1.5 truncate font-mono text-[0.8125rem] ${s.strongText}`}>{props.destinationPath}</div>
            <div className={`mt-1 flex items-start gap-1.5 text-xs leading-relaxed ${stateColor(state, isDark)}`}>
              <StateIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{t(stateKey)}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {props.adoptable && (
              <button type="button" onClick={props.onAdopt} disabled={busy} className={`${s.btnBase} ${s.btnPrimary}`}>
                {t('archive.adopt')}
              </button>
            )}
            <button
              type="button"
              onClick={props.onRunNow}
              disabled={busy || state !== 'match' || props.running}
              className={`${s.btnBase} ${props.adoptable ? s.btnSubtle : s.btnPrimary} inline-flex items-center gap-1.5`}
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              {props.running ? t('archive.running') : t('archive.runNow')}
            </button>
            {props.running && (
              <button type="button" onClick={props.onCancelRun} disabled={busy} className={`${s.btnBase} ${s.btnSubtle}`}>
                {t('archive.cancelRun')}
              </button>
            )}
            <button
              type="button"
              onClick={props.onBrowse}
              disabled={state !== 'match'}
              className={`${s.btnBase} ${s.btnSubtle}`}
            >
              {t('archive.browse')}
            </button>
            <button type="button" onClick={props.onTurnOff} disabled={busy} className={`${s.btnBase} ${s.btnSubtle}`}>
              {t('archive.overview.turnOff')}
            </button>
          </div>
        </div>

        {props.sameDisk && (
          <div className={`flex items-start gap-1.5 text-xs leading-relaxed ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{t('archive.sameDiskWarning')}</span>
          </div>
        )}

        {(props.running || props.lastResult) && (
          <div className={`space-y-1 text-[0.75rem] ${s.subText}`}>
            {props.running && props.progress && (
              <p>{t('archive.progress', { done: props.progress.done, total: props.progress.total })}</p>
            )}
            {props.lastResult && <p>{t('archive.lastRun', { result: props.lastResult })}</p>}
          </div>
        )}
      </div>

      <RowGroup label={t('archive.overview.settings')} isDark={isDark} />

      <ul>
        {ARCHIVE_GROUPS.map(group => {
          const isOpen = open === group;
          return (
            // The open group is tinted as one piece, header and fields together, with an
            // accent rule down its edge, so the fields read as belonging to the row that
            // was opened and not as a new block below it.
            <li
              key={group}
              className={`border-b border-l-2 last:border-b-0 last:rounded-b-2xl ${s.divider} ${
                isOpen
                  ? isDark
                    ? 'border-l-accent-500 bg-slate-800/75'
                    : 'border-l-accent-500 bg-slate-100/80'
                  : 'border-l-transparent'
              }`}
            >
              <div className="flex items-start justify-between gap-4 px-5 py-3.5">
                <div className="min-w-0">
                  <div className={`text-[0.8125rem] font-medium ${s.strongText}`}>{t(`archive.steps.${group}.name`)}</div>
                  {!isOpen && (
                    <div className="mt-1 space-y-0.5">
                      {rowValue[group].map(line => (
                        <p key={line} className={`text-[0.75rem] leading-relaxed ${s.subText}`}>
                          {line}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => openGroup(isOpen ? null : group)}
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? t('archive.overview.close') : t('archive.overview.edit')}: ${t(`archive.steps.${group}.name`)}`}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-[0.75rem] font-medium ${s.btnSubtle}`}
                >
                  {isOpen ? t('archive.overview.close') : t('archive.overview.edit')}
                </button>
              </div>

              {isOpen && (
                // Fields are recessed below the open row's tint. They share its slate-800
                // fill otherwise, and a time or a number then reads as bare text.
                <div
                  className={`px-5 pb-5 ${
                    isDark
                      ? '[&_input]:!border-slate-600 [&_input]:!bg-slate-950/60 [&_[data-segmented]]:!border-slate-600 [&_[data-segmented]]:!bg-slate-950/60'
                      : ''
                  }`}
                >
                  {group === 'disk' && (
                    <DiskFields
                      {...fieldProps}
                      destinationPath={props.destinationPath}
                      state={state}
                      sameDisk={props.sameDisk}
                      isNetwork={props.isNetwork}
                      onChoose={props.onChoose}
                      onPathTyped={props.onPathTyped}
                    />
                  )}
                  {group === 'copy' && <CopyFields {...fieldProps} />}
                  {group === 'schedule' && <ScheduleFields {...fieldProps} />}
                  {group === 'cleanup' && (
                    <CleanupFields
                      {...fieldProps}
                      onToggleRetention={props.onToggleRetention}
                      onToggleRemoveLocal={props.onToggleRemoveLocal}
                    />
                  )}

                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        if (await props.onSaveGroup(group)) setOpen(null);
                      }}
                      disabled={busy}
                      className={`${s.btnBase} ${s.btnPrimary}`}
                    >
                      {t('archive.save')}
                    </button>
                    <button type="button" onClick={() => openGroup(null)} disabled={busy} className={`${s.btnBase} ${s.btnSubtle}`}>
                      {t('archive.wizard.cancel')}
                    </button>
                    {group === 'cleanup' && (
                      // Gated on the stored switch rather than the one on screen. The
                      // apply route reads the stored configuration, so an unsaved switch
                      // would arm a button whose request the server refuses, after a
                      // confirmation naming real files.
                      <button
                        type="button"
                        onClick={props.onPrune}
                        disabled={busy || state !== 'match' || !props.storedRetentionEnabled}
                        className={`${s.btnBase} ${s.btnSubtle} sm:ml-auto`}
                      >
                        {t('archive.pruneNow')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
