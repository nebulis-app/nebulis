import type { ArchiveConfig, ArchiveConfigPatch, ArchiveScheduleMode } from '../../lib/api/storage';
import { formatTimeAuto } from '../../lib/formatLocale';

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/** What the form shows before the server has answered. */
export const EMPTY_FORM: ArchiveConfig = {
  enabled: false,
  path: '',
  locationType: 'local',
  network: { host: '', share: '', domain: '', username: '', hasPassword: false, subpath: '' },
  archiveId: '',
  scope: 'all',
  selectedObjects: [],
  includeSubframes: false,
  copyMinAgeDays: 0,
  copyMinAgeEnabled: false,
  scheduleEnabled: false,
  scheduleMode: 'daily',
  scheduleHour: 2,
  scheduleMinute: 0,
  scheduleIntervalHours: 24,
  scheduleCron: '',
  retentionDays: 0,
  retentionEnabled: false,
  retentionSubframesOnly: false,
  removeLocalAfter: false,
  lastRunAt: '',
  lastResult: '',
};

/** The four groups the settings fall into. The setup wizard walks them in this order
 *  and the overview edits them one at a time. */
export const ARCHIVE_GROUPS = ['disk', 'copy', 'schedule', 'cleanup'] as const;
export type ArchiveGroup = (typeof ARCHIVE_GROUPS)[number];

/** The steps of setup in the order they are walked. The last is not a group of settings
 *  but the review before anything is switched on. */
export const WIZARD_STEPS = [...ARCHIVE_GROUPS, 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** `HH:MM` for a `type="time"` input. That input always speaks 24-hour time on the
 *  wire whatever the browser displays, which is why this is not locale-formatted. */
export function timeValue(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** The hour and minute of an `HH:MM` value, or null when it is not one. */
export function parseTimeValue(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** A Date carrying a wall-clock time, for rendering it in the user's locale. */
function atTimeOfDay(hour: number, minute: number): Date {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
}

/**
 * The schedule as one choice rather than a switch plus a mode. "Manual only" is the
 * schedule switch being off; the other three are the switch on with that mode. Folding
 * the two stored fields into one control is what removes the toggle, the Simple/Custom
 * pair and the Run pair the old form stacked on top of each other.
 */
export type ScheduleChoice = 'manual' | ArchiveScheduleMode;

export function scheduleChoiceOf(form: ArchiveConfig): ScheduleChoice {
  return form.scheduleEnabled ? form.scheduleMode : 'manual';
}

export function scheduleChoicePatch(choice: ScheduleChoice): Partial<ArchiveConfig> {
  return choice === 'manual' ? { scheduleEnabled: false } : { scheduleEnabled: true, scheduleMode: choice };
}

/** How many days a new capture waits before it is copied. Zero means it does not. */
export function waitDaysOf(form: ArchiveConfig): number {
  return form.copyMinAgeEnabled ? form.copyMinAgeDays : 0;
}

/** The stored pair behind the single "wait" number. The server refuses an enabled
 *  wait of zero days, so the switch is derived from the number and cannot disagree. */
export function waitDaysPatch(days: number): Partial<ArchiveConfig> {
  const whole = Math.max(0, Math.floor(days) || 0);
  return { copyMinAgeDays: whole, copyMinAgeEnabled: whole > 0 };
}

/** Whether a destination has been chosen at all, for either kind of disk. */
export function hasDestination(form: ArchiveConfig): boolean {
  return form.locationType === 'network' ? form.network.host !== '' : form.path.trim() !== '';
}

/**
 * The fields a group owns, as a save payload.
 *
 * The cron expression only travels while the custom schedule is chosen: a half-typed
 * one left behind in a box that is not on screen would otherwise fail validation on a
 * save from another choice. The path only travels for a local disk, because a share is
 * described by its network fields and saved by the picker.
 */
export function groupPayload(group: ArchiveGroup, form: ArchiveConfig): ArchiveConfigPatch {
  switch (group) {
    case 'disk':
      return form.locationType === 'network' ? {} : { path: form.path.trim() };
    case 'copy':
      return {
        includeSubframes: form.includeSubframes,
        copyMinAgeDays: form.copyMinAgeDays,
        copyMinAgeEnabled: form.copyMinAgeEnabled,
      };
    case 'schedule':
      return {
        scheduleEnabled: form.scheduleEnabled,
        scheduleMode: form.scheduleMode,
        scheduleHour: form.scheduleHour,
        scheduleMinute: form.scheduleMinute,
        scheduleIntervalHours: form.scheduleIntervalHours,
        ...(form.scheduleMode === 'custom' ? { scheduleCron: form.scheduleCron.trim() } : {}),
      };
    case 'cleanup':
      return {
        retentionDays: form.retentionDays,
        retentionEnabled: form.retentionEnabled,
        retentionSubframesOnly: form.retentionSubframesOnly,
        removeLocalAfter: form.removeLocalAfter,
      };
  }
}

/** The plain-English account of what the settings will do, by group. Built from the
 *  same fields the server reads, in the user's own terms, because "every 6 hours" and a
 *  retention period in days are easy to set and hard to picture. */
export interface ArchiveSummary {
  disk: string;
  copy: string[];
  schedule: string;
  cleanup: string[];
}

export function buildArchiveSummary(t: TFunc, form: ArchiveConfig, destination: string): ArchiveSummary {
  const selectedCount = form.selectedObjects.length;
  const disk =
    destination === ''
      ? t('archive.summary.noDestination')
      : form.scope === 'selected'
        ? selectedCount === 0
          ? t('archive.summary.nothingSelected', { path: destination })
          : t('archive.summary.destinationSelected', { count: selectedCount, path: destination })
        : t('archive.summary.destination', { path: destination });

  const copy = [
    form.includeSubframes ? t('archive.summary.withSubframes') : t('archive.summary.withoutSubframes'),
    form.copyMinAgeEnabled && form.copyMinAgeDays > 0
      ? t('archive.summary.minAge', { count: form.copyMinAgeDays })
      : t('archive.summary.minAgeOff'),
  ];

  let schedule: string;
  if (!form.scheduleEnabled) {
    schedule = t('archive.summary.scheduleOff');
  } else if (form.scheduleMode === 'daily') {
    schedule = t('archive.summary.dailyAt', {
      time: formatTimeAuto(atTimeOfDay(form.scheduleHour, form.scheduleMinute), { hour: '2-digit', minute: '2-digit' }),
    });
  } else if (form.scheduleMode === 'interval') {
    schedule = t('archive.summary.everyHours', { count: form.scheduleIntervalHours });
  } else {
    schedule = t('archive.summary.custom', {
      cron: form.scheduleCron.trim() === '' ? t('archive.summary.customUnset') : form.scheduleCron.trim(),
    });
  }

  const cleanup: string[] = [];
  if (!form.retentionEnabled) {
    cleanup.push(t('archive.summary.retentionOff'));
  } else if (form.retentionSubframesOnly) {
    cleanup.push(t('archive.summary.retentionSubframes', { count: form.retentionDays }));
  } else {
    cleanup.push(t('archive.summary.retentionEverything', { count: form.retentionDays }));
  }
  if (form.removeLocalAfter) cleanup.push(t('archive.summary.removeLocal'));

  return { disk, copy, schedule, cleanup };
}
