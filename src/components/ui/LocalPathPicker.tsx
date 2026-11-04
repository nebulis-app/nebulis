import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Usb, FolderOpen, RotateCw, Check, Tag, Lock } from 'lucide-react';
import { listDetectedDrives, type DetectedDrive } from '../../lib/api/telescopes';
import { formatBytesCompact } from '../../lib/utils';
import { formatDate } from '../../lib/formatLocale';

/**
 * Drive picker for a USB-attached telescope. Calls /telescopes/drives, then
 * filters by the device shape we're looking for: `kind: 'seestar'` keeps
 * `looksLikeSeestar` volumes; `kind: 'dwarf'` keeps `looksLikeDwarf` volumes;
 * `kind: 'asiair'` keeps `looksLikeAsiair` volumes.
 *
 * If a detected drive has `alreadyKnownProfileId`, the row badges it as
 * already paired so users notice before they accidentally create a duplicate
 * profile. The merge-prompt flow in AddTelescopeModal handles the actual
 * link-to-existing behaviour.
 *
 * Each row also says what is on the drive (size, free space, how many object
 * folders, when the newest changed) because two telescopes of one model look
 * the same from outside: with both plugged in, that is how the right one gets
 * picked the first time, before it carries a device ID.
 */

/** The facts about a drive that help tell it from another, as one line. */
function driveFacts(d: DetectedDrive, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const parts: string[] = [];
  if (d.totalBytes > 0) parts.push(t('localPathPicker.driveSize', { size: formatBytesCompact(d.totalBytes), free: formatBytesCompact(d.freeBytes) }));
  if (d.objectFolders !== undefined) parts.push(t('localPathPicker.driveObjects', { count: d.objectFolders }));
  if (d.newestActivity) parts.push(t('localPathPicker.driveLatest', { date: formatDate(new Date(d.newestActivity), { dateStyle: 'medium' }) }));
  return parts.join(' · ');
}
export function LocalPathPicker({
  kind,
  localPath,
  setLocalPath,
  onDriveSelected,
  inputClass,
  labelClass,
  helperClass,
  isDark,
  autoFocus = false,
  autoSelect = true,
}: {
  kind: 'seestar' | 'dwarf' | 'asiair';
  localPath: string;
  setLocalPath: (s: string) => void;
  /** Called when the user clicks a detected drive, with the full drive
   *  metadata so callers can use the already-paired hint to drive the
   *  merge prompt. */
  onDriveSelected?: (drive: DetectedDrive) => void;
  inputClass: string;
  labelClass: string;
  helperClass: string;
  isDark: boolean;
  autoFocus?: boolean;
  /** Pick the drive when exactly one unowned drive is detected and none is chosen yet. Off where a wrong guess would pair the wrong telescope. */
  autoSelect?: boolean;
}) {
  const { t } = useTranslation('common');
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['drives'],
    queryFn: () => listDetectedDrives(),
    staleTime: 5_000,
  });
  const allDrives = data?.drives ?? [];
  const drives = allDrives.filter(d => {
    if (kind === 'seestar') return d.looksLikeSeestar;
    if (kind === 'asiair') return d.looksLikeAsiair;
    return d.looksLikeDwarf;
  });

  // Keep a stable ref to the callback so the effect doesn't re-run when the
  // parent re-renders with a new inline function reference.
  const onDriveSelectedRef = useRef(onDriveSelected);
  onDriveSelectedRef.current = onDriveSelected;

  useEffect(() => {
    // Only when there is nothing to choose between. With two drives plugged in, or one that already belongs to a
    // telescope, a guess is how a telescope ends up on the wrong drive.
    if (autoSelect && !localPath && drives.length === 1 && !drives[0].alreadyKnownProfileId) {
      setLocalPath(drives[0].mountPath);
      onDriveSelectedRef.current?.(drives[0]);
    }
  }, [autoSelect, drives, localPath, setLocalPath]);

  const noun = kind === 'seestar' ? 'Seestar' : kind === 'asiair' ? 'ASIAIR' : 'Dwarf';
  const placeholderHint = kind === 'seestar'
    ? '/Volumes/EMMC Images or D:\\'
    : kind === 'asiair'
      ? '/Volumes/ASIAIR or D:\\'
      : '/Volumes/DWARF_3 or D:\\';

  return (
    <div>
      <label className={labelClass}>{t('localPathPicker.usbStoragePath', { noun })}</label>

      {drives.length > 0 && (
        <div className="mb-2 space-y-1">
          {drives.map(d => {
            const selected = d.mountPath === localPath;
            return (
              <button
                key={d.mountPath}
                type="button"
                onClick={() => {
                  setLocalPath(d.mountPath);
                  onDriveSelected?.(d);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition ${
                  selected
                    ? (isDark ? 'bg-teal-500/10 border border-teal-500/40 text-teal-200' : 'bg-teal-50 border border-teal-300 text-teal-900')
                    : (isDark ? 'border border-slate-800 hover:border-slate-700 text-slate-300' : 'border border-slate-200 hover:border-slate-300 text-slate-700')
                }`}
              >
                <Usb className={`w-4 h-4 flex-shrink-0 ${selected ? 'text-teal-500' : 'opacity-60'}`} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{d.volumeName}</div>
                  <div className="text-xs opacity-60 truncate">{d.mountPath}</div>
                  {driveFacts(d, t) && <div className="text-xs opacity-60 truncate">{driveFacts(d, t)}</div>}
                </div>
                {!d.writable && (
                  <span
                    title={t('localPathPicker.readOnlyHint')}
                    className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 flex-shrink-0 ${
                      isDark ? 'bg-slate-800 text-slate-300 border border-slate-700' : 'bg-slate-100 text-slate-600 border border-slate-200'
                    }`}
                  >
                    <Lock className="w-3 h-3" />
                    {t('localPathPicker.readOnly')}
                  </span>
                )}
                {!d.alreadyKnownProfileName && !d.alreadyKnownDeviceId && (
                  <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${
                    isDark ? 'bg-slate-800 text-slate-400 border border-slate-700' : 'bg-slate-100 text-slate-500 border border-slate-200'
                  }`}>
                    {t('localPathPicker.notPaired')}
                  </span>
                )}
                {d.alreadyKnownProfileName && (
                  <span className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 flex-shrink-0 ${
                    isDark ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30' : 'bg-amber-50 text-amber-700 border border-amber-200'
                  }`}>
                    <Tag className="w-3 h-3" />
                    {t('localPathPicker.alreadyAddedAs', { name: d.alreadyKnownProfileName })}
                  </span>
                )}
                {selected && <Check className="w-4 h-4 text-teal-500 flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <FolderOpen className={`w-4 h-4 flex-shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
        <input
          type="text"
          placeholder={drives.length > 0 ? t('localPathPicker.customPathPlaceholder') : placeholderHint}
          value={localPath}
          onChange={e => setLocalPath(e.target.value)}
          className={inputClass}
          autoFocus={autoFocus}
        />
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className={`p-2 rounded-lg transition flex-shrink-0 ${
            isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
          } disabled:opacity-50`}
          aria-label={t('localPathPicker.refreshDrives')}
          title={t('localPathPicker.refreshDrives')}
        >
          <RotateCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <p className={helperClass}>
        {drives.length > 0
          ? t('localPathPicker.detected', { count: drives.length, noun })
          : t('localPathPicker.plugIn', { noun })}
      </p>
    </div>
  );
}
