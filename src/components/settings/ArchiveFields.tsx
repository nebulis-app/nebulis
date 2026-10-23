import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

import type { ArchiveConfig, ArchiveDestinationState } from '../../lib/api/storage';
import { getInputClass, getLabelClass, Seg, Toggle } from './SettingsUI';
import {
  parseTimeValue,
  scheduleChoiceOf,
  scheduleChoicePatch,
  timeValue,
  waitDaysOf,
  waitDaysPatch,
  type ScheduleChoice,
} from './archiveForm';
import { archiveStyles, STATE_ICON, stateColor } from './archiveStyles';

/**
 * The four groups of archive settings, as stacked fields with their help text showing.
 *
 * These are shared by the setup wizard, which shows one group per step, and by the
 * overview, which opens one group at a time to edit it. They hold no state of their
 * own: the form is derived in `ArchiveSection` from the server's last answer plus the
 * user's edits, and every change goes back through `edit`.
 *
 * Help text is printed rather than tucked behind an (i). A wizard step has room for it,
 * and it is the text a user needs at the moment they choose.
 */

interface FieldsProps {
  isDark: boolean;
  form: ArchiveConfig;
  edit: (patch: Partial<ArchiveConfig>) => void;
  busy: boolean;
}

/** A switch with its label and help text, laid out the way the master switch used to
 *  be: text on the left, the control on the right. */
function ToggleField({
  label,
  description,
  checked,
  onChange,
  disabled,
  isDark,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
  isDark: boolean;
}) {
  const s = archiveStyles(isDark);
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className={`text-[0.8125rem] font-medium ${s.strongText}`}>{label}</div>
        {description && <p className={`mt-1 text-[0.75rem] leading-relaxed ${s.subText}`}>{description}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

/** A number with its unit beside it. */
function NumberField({
  label,
  description,
  unit,
  value,
  min,
  max,
  onChange,
  disabled,
  isDark,
  id,
}: {
  label: string;
  description?: string;
  unit: string;
  value: number;
  min: number;
  max?: number;
  onChange: (value: number) => void;
  disabled: boolean;
  isDark: boolean;
  id?: string;
}) {
  const s = archiveStyles(isDark);
  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className={`text-[0.8125rem] font-medium ${s.strongText}`}>
          {label}
        </label>
        <div className="flex items-center gap-2">
          <div className="w-20">
            <input
              id={id}
              type="number"
              min={min}
              max={max}
              value={value}
              onChange={e => onChange(Number(e.target.value))}
              disabled={disabled}
              className={`${getInputClass(isDark)} disabled:opacity-50`}
            />
          </div>
          <span className={`text-sm ${s.subText}`}>{unit}</span>
        </div>
      </div>
      {description && <p className={`mt-1 text-[0.75rem] leading-relaxed ${s.subText}`}>{description}</p>}
    </div>
  );
}

function FieldStack({ children }: { children: ReactNode }) {
  return <div className="space-y-5">{children}</div>;
}

/* ─── Disk ──────────────────────────────────────────────────────────────────── */

export function DiskFields({
  isDark,
  form,
  edit,
  busy,
  destinationPath,
  state,
  sameDisk,
  isNetwork,
  onChoose,
  onPathTyped,
}: FieldsProps & {
  /** The path the server resolved, which is what a share shows instead of a field. */
  destinationPath: string;
  state: ArchiveDestinationState | null;
  sameDisk: boolean;
  isNetwork: boolean;
  onChoose: () => void;
  onPathTyped: () => void;
}) {
  const { t } = useTranslation('settings');
  const s = archiveStyles(isDark);
  const stateKey = state
    ? `archive.state.${state === 'invalid-path' ? 'invalidPath' : state}`
    : 'archive.state.unconfigured';
  const StateIcon = STATE_ICON[state ?? 'unconfigured'];

  return (
    <FieldStack>
      <div>
        <label htmlFor="archive-path" className={getLabelClass(isDark)}>
          {t('archive.destinationLabel')}
        </label>
        <div className="flex items-center gap-2">
          {isNetwork ? (
            // A share is described by its fields, not by a path, so there is nothing
            // here to type: the picker is the only way in.
            <div
              className={`min-w-0 flex-1 truncate rounded-xl border px-4 py-2.5 font-mono text-sm ${
                isDark
                  ? 'border-slate-700/80 bg-slate-800/40 text-slate-300'
                  : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}
            >
              {destinationPath}
            </div>
          ) : (
            <input
              id="archive-path"
              type="text"
              value={form.path}
              onChange={e => {
                // A typed path is not a chosen folder, so adopting it will not create
                // anything that is not already there.
                onPathTyped();
                edit({ path: e.target.value });
              }}
              placeholder={t('archive.destinationPlaceholder')}
              className={`font-mono ${getInputClass(isDark)}`}
              spellCheck={false}
              disabled={busy}
            />
          )}
          <button type="button" onClick={onChoose} disabled={busy} className={`${s.btnBase} ${s.btnSubtle} shrink-0`}>
            {isNetwork ? t('archive.changeDestination') : t('archive.chooseDestination')}
          </button>
        </div>
      </div>

      <div className={`flex items-start gap-1.5 text-xs leading-relaxed ${stateColor(state, isDark)}`}>
        <StateIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t(stateKey)}</span>
      </div>

      {sameDisk && (
        <div className={`flex items-start gap-1.5 text-xs leading-relaxed ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{t('archive.sameDiskWarning')}</span>
        </div>
      )}

      <p className={`text-[0.75rem] leading-relaxed ${s.subText}`}>{t('archive.destinationDescription')}</p>
    </FieldStack>
  );
}

/* ─── What to copy ──────────────────────────────────────────────────────────── */

export function CopyFields({ isDark, form, edit, busy }: FieldsProps) {
  const { t } = useTranslation('settings');
  return (
    <FieldStack>
      <ToggleField
        label={t('archive.includeSubframes.label')}
        description={t('archive.includeSubframes.description')}
        checked={form.includeSubframes}
        onChange={v => edit({ includeSubframes: v })}
        disabled={busy}
        isDark={isDark}
      />
      {/* One number, not a switch and a number: zero is "do not wait". The two stored
          fields are derived from it, so they cannot disagree. */}
      <NumberField
        id="archive-wait-days"
        label={t('archive.minAge.label')}
        description={t('archive.minAge.description')}
        unit={t('archive.minAge.unit')}
        value={waitDaysOf(form)}
        min={0}
        onChange={days => edit(waitDaysPatch(days))}
        disabled={busy}
        isDark={isDark}
      />
    </FieldStack>
  );
}

/* ─── Schedule ──────────────────────────────────────────────────────────────── */

export function ScheduleFields({ isDark, form, edit, busy }: FieldsProps) {
  const { t } = useTranslation('settings');
  const s = archiveStyles(isDark);
  const choice = scheduleChoiceOf(form);

  return (
    <FieldStack>
      <div>
        <div className={getLabelClass(isDark)}>{t('archive.schedule.choiceLabel')}</div>
        <Seg<ScheduleChoice>
          value={choice}
          onChange={next => edit(scheduleChoicePatch(next))}
          disabled={busy}
          isDark={isDark}
          options={[
            { id: 'manual', label: t('archive.schedule.choice.manual') },
            { id: 'daily', label: t('archive.schedule.choice.daily') },
            { id: 'interval', label: t('archive.schedule.choice.interval') },
            { id: 'custom', label: t('archive.schedule.choice.custom') },
          ]}
        />
      </div>

      {choice === 'manual' && (
        <p className={`text-[0.75rem] leading-relaxed ${s.subText}`}>{t('archive.schedule.manualNote')}</p>
      )}

      {choice === 'daily' && (
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="archive-time" className={`text-[0.8125rem] font-medium ${s.strongText}`}>
            {t('archive.schedule.timeLabel')}
          </label>
          <div className="w-36">
            <input
              id="archive-time"
              type="time"
              value={timeValue(form.scheduleHour, form.scheduleMinute)}
              onChange={e => {
                const parsed = parseTimeValue(e.target.value);
                // An incomplete value (the browser sends '' while typing) leaves the
                // stored time alone rather than snapping to midnight under the user.
                if (parsed) edit({ scheduleHour: parsed.hour, scheduleMinute: parsed.minute });
              }}
              disabled={busy}
              className={getInputClass(isDark)}
            />
          </div>
        </div>
      )}

      {choice === 'interval' && (
        <NumberField
          id="archive-interval"
          label={t('archive.schedule.intervalLabel')}
          unit={t('archive.schedule.intervalUnit')}
          value={form.scheduleIntervalHours}
          min={1}
          max={168}
          onChange={next => edit({ scheduleIntervalHours: Number.isFinite(next) ? Math.max(1, Math.min(168, next)) : 24 })}
          disabled={busy}
          isDark={isDark}
        />
      )}

      {choice === 'custom' && (
        <div>
          <label htmlFor="archive-cron" className={getLabelClass(isDark)}>
            {t('archive.schedule.cronLabel')}
          </label>
          <input
            id="archive-cron"
            type="text"
            value={form.scheduleCron}
            onChange={e => edit({ scheduleCron: e.target.value })}
            placeholder="0 2 * * *"
            spellCheck={false}
            disabled={busy}
            className={`font-mono ${getInputClass(isDark)}`}
          />
          <p className={`mt-1.5 text-[0.75rem] leading-relaxed ${s.subText}`}>{t('archive.schedule.cronDescription')}</p>
        </div>
      )}

      {choice !== 'manual' && (
        <p className={`text-[0.75rem] leading-relaxed ${s.subText}`}>{t('archive.schedule.description')}</p>
      )}
    </FieldStack>
  );
}

/* ─── Cleanup ───────────────────────────────────────────────────────────────── */

/**
 * The two options that delete files. They share one red-washed box, distinct from the
 * neutral grouping everywhere else: unlike every other setting, turning either on arms
 * something that deletes on its own, on a timer. The tint and the icon are the "this
 * one is different" signal; the confirmation each toggle raises is the actual guard,
 * so the toggles come in as callbacks that own it.
 */
export function CleanupFields({
  isDark,
  form,
  edit,
  busy,
  onToggleRetention,
  onToggleRemoveLocal,
}: FieldsProps & {
  onToggleRetention: (next: boolean) => void;
  onToggleRemoveLocal: (next: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const s = archiveStyles(isDark);
  const iconColor = isDark ? 'text-red-400' : 'text-red-600';

  return (
    <FieldStack>
      <div className={`${s.dangerBox} space-y-4`}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <div className={`text-[0.8125rem] font-medium ${s.strongText}`}>{t('archive.retention.enabledLabel')}</div>
              <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${iconColor}`} aria-hidden="true" />
            </div>
            <p className={`mt-1 text-[0.75rem] leading-relaxed ${s.subText}`}>{t('archive.retention.enabledDescription')}</p>
          </div>
          <Toggle
            checked={form.retentionEnabled}
            onChange={onToggleRetention}
            disabled={busy}
            label={t('archive.retention.enabledLabel')}
          />
        </div>

        {form.retentionEnabled && (
          <div className={`ml-1 space-y-4 border-l pl-4 ${isDark ? 'border-red-500/30' : 'border-red-300'}`}>
            <NumberField
              id="archive-retention-days"
              label={t('archive.retention.label')}
              description={t('archive.retention.description')}
              unit={t('archive.retention.unit')}
              value={form.retentionDays}
              min={0}
              onChange={days => edit({ retentionDays: Math.max(0, Math.floor(days) || 0) })}
              disabled={busy}
              isDark={isDark}
            />
            {/* Mutually exclusive, which a pair of switches cannot express, so a
                segmented control says which one. */}
            <div className="flex items-center justify-between gap-4">
              <div className={`text-[0.8125rem] font-medium ${s.strongText}`}>{t('archive.retention.modeLabel')}</div>
              <Seg<'everything' | 'subframes'>
                value={form.retentionSubframesOnly ? 'subframes' : 'everything'}
                onChange={mode => edit({ retentionSubframesOnly: mode === 'subframes' })}
                disabled={busy}
                isDark={isDark}
                options={[
                  { id: 'everything', label: t('archive.retention.mode.everything') },
                  { id: 'subframes', label: t('archive.retention.mode.subframes') },
                ]}
              />
            </div>
          </div>
        )}

        <div className={`border-t pt-4 ${isDark ? 'border-red-500/20' : 'border-red-200'}`}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <div className={`text-[0.8125rem] font-medium ${s.strongText}`}>{t('archive.removeLocal.label')}</div>
                <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${iconColor}`} aria-hidden="true" />
              </div>
              <p className={`mt-1 text-[0.75rem] leading-relaxed ${s.subText}`}>{t('archive.removeLocal.description')}</p>
            </div>
            <Toggle
              checked={form.removeLocalAfter}
              onChange={onToggleRemoveLocal}
              disabled={busy}
              label={t('archive.removeLocal.label')}
            />
          </div>
          {form.removeLocalAfter && (
            <div className={`mt-3 ${s.warningClass}`} role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t('archive.removeLocal.warning')}</span>
            </div>
          )}
        </div>
      </div>
    </FieldStack>
  );
}
