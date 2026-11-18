import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Cloud, Play, Square } from 'lucide-react';

import {
  cancelGdriveBackupRun,
  disableGdriveBackup,
  enableGdriveBackup,
  getGdriveBackup,
  runGdriveBackupNow,
  saveGdriveBackup,
  type GdriveBackupConfig,
  type GdriveBackupPatch,
  type GdriveFolder,
} from '../../lib/api/gdriveBackup';
import { ApiRequestError } from '../../lib/api/client';
import { formatBytes } from '../../lib/utils';
import { Sec } from './SettingsUI';
import { CopyFields, ScheduleFields } from './ArchiveFields';
import type { CopyScheduleForm } from './archiveForm';
import { archiveStyles } from './archiveStyles';
import { GdriveConnectionPanel } from './GdriveConnectionPanel';

const COPY_SCHEDULE_KEYS = [
  'includeSubframes',
  'copyMinAgeEnabled',
  'copyMinAgeDays',
  'scheduleEnabled',
  'scheduleMode',
  'scheduleHour',
  'scheduleMinute',
  'scheduleIntervalHours',
  'scheduleCron',
] as const satisfies ReadonlyArray<keyof CopyScheduleForm>;

/**
 * Settings → Storage → Archive → Google Drive: the off-site backup.
 *
 * Its own page rather than a third tab of the archive disk picker, because it is its
 * own feature: it runs alongside the disk archive, on its own schedule, and only ever
 * adds to Drive. The page reads top to bottom in the order a first setup happens:
 * connect Google (the folder is prepared on its own), choose what to copy and when,
 * then turn it on. Once it is on, the status block at the top is what matters.
 */
export function GdriveBackupSection({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const s = archiveStyles(isDark);
  const [edits, setEdits] = useState<Partial<CopyScheduleForm>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** Set when turning on found another install's backup in the folder. */
  const [foreignId, setForeignId] = useState<string | null>(null);

  const { data, refetch } = useQuery({
    queryKey: ['gdrive-backup'],
    queryFn: getGdriveBackup,
    refetchInterval: query => (query.state.data?.running ? 1500 : false),
  });
  const config = data?.config;

  const act = useCallback(
    async (action: () => Promise<unknown>, done?: string): Promise<boolean> => {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        await action();
        if (done) setNotice(done);
        await refetch();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : t('archiveGdrive.failed'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refetch, t],
  );

  // The connection panel prepares the folder; saving its id is this page's job, once.
  const onFolderReady = useCallback(
    (folder: GdriveFolder | null) => {
      if (!folder || !config || folder.id === config.folderId) return;
      void saveGdriveBackup({ folderId: folder.id, folderPath: folder.name })
        .then(() => queryClient.invalidateQueries({ queryKey: ['gdrive-backup'] }))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : t('archiveGdrive.failed')));
    },
    [config, queryClient, t],
  );

  if (!config) {
    return (
      <Sec title={t('gdriveBackup.title')} description={t('gdriveBackup.description')} isDark={isDark}>
        <p className={`px-5 py-5 text-[0.8125rem] ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{t('archive.loading')}</p>
      </Sec>
    );
  }

  const form: GdriveBackupConfig = { ...config, ...edits };
  // Only edits that differ from what is stored count, so typing a value back is not "unsaved".
  const dirty = COPY_SCHEDULE_KEYS.some(key => key in edits && edits[key] !== config[key]);
  const destination = data?.destination;
  const progress = data?.progress;
  const running = data?.running === true;
  const ready = config.connected && config.folderId !== '';

  const turnOn = (confirm?: string) =>
    act(async () => {
      try {
        if (dirty) await saveGdriveBackup(edits as GdriveBackupPatch);
        setEdits({});
        await enableGdriveBackup(confirm);
        setForeignId(null);
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === 'GDRIVE_FOREIGN_CONFIRMATION_REQUIRED') {
          const fresh = await getGdriveBackup();
          setForeignId(fresh.destination.foundArchiveId);
          return;
        }
        throw err;
      }
    }, t('gdriveBackup.turnedOn'));

  const stateKey = destination ? `gdriveBackup.state.${destination.state}` : 'gdriveBackup.state.offline';
  const lastRunWhen = config.lastRunAt ? new Date(config.lastRunAt).toLocaleString() : null;

  return (
    <Sec title={t('gdriveBackup.title')} description={t('gdriveBackup.description')} isDark={isDark}>
      {(notice || error) && (
        <div className="space-y-3 px-5 pt-4">
          {notice && <div className={s.noticeClass}>{notice}</div>}
          {error && <div className={s.errorClass}>{error}</div>}
        </div>
      )}

      {/* ─── Status ─────────────────────────────────────────────────────── */}
      <div className={`space-y-3 border-b px-5 py-4 ${s.divider}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <Cloud className={`h-4 w-4 ${config.enabled ? 'text-emerald-500' : s.subText}`} />
              <span className={`text-[0.8125rem] font-semibold ${s.strongText}`}>
                {config.enabled ? t('gdriveBackup.statusOn') : t('gdriveBackup.statusOff')}
              </span>
            </div>
            {ready && destination && (
              <p className={`flex items-center gap-1.5 text-[0.75rem] ${destination.state === 'match' ? 'text-emerald-500' : 'text-amber-500'}`}>
                {destination.state === 'match' ? <Check className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                {t(stateKey, { path: destination.path })}
              </p>
            )}
            <p className={`text-[0.75rem] ${s.subText}`}>
              {config.lastResult
                ? t('gdriveBackup.lastResult', { result: config.lastResult, when: lastRunWhen ?? t('gdriveBackup.notCompleted') })
                : t('gdriveBackup.neverRun')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {config.enabled && !running && (
              <button
                type="button"
                disabled={busy}
                onClick={() => act(runGdriveBackupNow, t('gdriveBackup.started'))}
                className={`${s.btnBase} ${s.btnPrimary} inline-flex items-center gap-1.5`}
              >
                <Play className="h-3.5 w-3.5" /> {t('gdriveBackup.runNow')}
              </button>
            )}
            {running && (
              <button type="button" disabled={busy} onClick={() => act(cancelGdriveBackupRun)} className={`${s.btnBase} ${s.btnSubtle} inline-flex items-center gap-1.5`}>
                <Square className="h-3.5 w-3.5" /> {t('gdriveBackup.cancelRun')}
              </button>
            )}
            {config.enabled ? (
              <button type="button" disabled={busy} onClick={() => act(disableGdriveBackup, t('gdriveBackup.turnedOff'))} className={`${s.btnBase} ${s.btnSubtle}`}>
                {t('gdriveBackup.turnOff')}
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || !ready}
                title={ready ? undefined : t('gdriveBackup.connectFirst')}
                onClick={() => void turnOn()}
                className={`${s.btnBase} ${s.btnPrimary}`}
              >
                {t('gdriveBackup.turnOn')}
              </button>
            )}
          </div>
        </div>

        {running && progress && (
          <div className="space-y-1.5">
            <div className={`h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
              <div
                className="h-full rounded-full bg-accent-500 transition-[width]"
                style={{ width: `${progress.filesTotal > 0 ? Math.round((progress.filesDone / progress.filesTotal) * 100) : 0}%` }}
              />
            </div>
            <p className={`text-[0.75rem] ${s.subText}`}>
              {t('gdriveBackup.progress', {
                done: progress.filesDone,
                total: progress.filesTotal,
                bytes: formatBytes(progress.bytesDone),
                totalBytes: formatBytes(progress.bytesTotal),
              })}
            </p>
          </div>
        )}

        {foreignId !== null && (
          <div className={s.dangerBox}>
            <p className={`text-[0.8125rem] ${s.strongText}`}>{t('gdriveBackup.foreign', { id: foreignId })}</p>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={busy} onClick={() => void turnOn(foreignId)} className={`${s.btnBase} ${s.btnPrimary}`}>
                {t('gdriveBackup.takeOver')}
              </button>
              <button type="button" onClick={() => setForeignId(null)} className={`${s.btnBase} ${s.btnSubtle}`}>
                {t('archiveGdrive.cancel')}
              </button>
            </div>
          </div>
        )}

        <p className={`text-[0.75rem] leading-relaxed ${s.subText}`}>{t('gdriveBackup.alongside')}</p>
      </div>

      {/* ─── 1. Google account and folder ───────────────────────────────── */}
      <div className={`space-y-3 border-b px-5 py-4 ${s.divider}`}>
        <h4 className={`text-[0.8125rem] font-semibold ${s.strongText}`}>{t('gdriveBackup.connection')}</h4>
        <GdriveConnectionPanel isDark={isDark} config={config} onFolderReady={onFolderReady} onError={setError} />
      </div>

      {/* ─── 2. What to copy and when ───────────────────────────────────── */}
      <div className={`space-y-4 border-b px-5 py-4 ${s.divider}`}>
        <h4 className={`text-[0.8125rem] font-semibold ${s.strongText}`}>{t('gdriveBackup.whatToCopy')}</h4>
        <CopyFields isDark={isDark} form={form} edit={patch => setEdits(e => ({ ...e, ...patch }))} busy={busy} idPrefix="gdrive" />
      </div>
      <div className="space-y-4 px-5 py-4">
        <h4 className={`text-[0.8125rem] font-semibold ${s.strongText}`}>{t('gdriveBackup.schedule')}</h4>
        <ScheduleFields isDark={isDark} form={form} edit={patch => setEdits(e => ({ ...e, ...patch }))} busy={busy} idPrefix="gdrive" />
        <p className={`text-[0.75rem] leading-relaxed ${s.subText}`}>{t('archiveGdrive.limits')}</p>
        {dirty && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await saveGdriveBackup(edits as GdriveBackupPatch);
                  setEdits({});
                }, t('gdriveBackup.saved'))
              }
              className={`${s.btnBase} ${s.btnPrimary}`}
            >
              {t('gdriveBackup.save')}
            </button>
            <button type="button" disabled={busy} onClick={() => setEdits({})} className={`${s.btnBase} ${s.btnSubtle}`}>
              {t('archiveGdrive.cancel')}
            </button>
          </div>
        )}
      </div>
    </Sec>
  );
}
