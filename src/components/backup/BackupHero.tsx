/**
 * Banner for the backup page, and the page's live progress surface.
 *
 * The page used to answer "is my sync healthy?" with three stacked panels and a
 * separate "Ready to Sync" card that repeated what the header already said. The
 * hero takes that job instead: one place that always states where the backup
 * stands, and which becomes the progress readout while a sync is running rather
 * than pushing a second card in below itself.
 *
 * Dark in every theme, matching the Library, Gallery and Observations banners,
 * which is also why it takes the bright `accent` hex directly rather than
 * `accent-*` utilities and styles its own text white.
 */
import { Trans, useTranslation } from 'react-i18next';
import { FolderSync, Download, RefreshCw, X, Clock, AlertTriangle, Ban } from 'lucide-react';
import { CollapsibleHero } from '../ui/CollapsibleHero';
import { PAGE_HERO } from '../../lib/heroImagery';
import { formatBytes } from '../../lib/utils';
import { formatDuration, formatEta, formatRelativeShort } from '../../lib/timeFormat';
import { formatNumber } from '../../lib/formatLocale';
import type { ImportStatus } from '../../lib/api/library';

export interface BackupRollup {
  /** Most recent run that finished without an error, from sync history. */
  lastSuccessAt: string | null;
  /** New files and bytes brought in over the recent window. */
  windowFiles: number;
  windowBytes: number;
  /** Runs in the window that ended in a genuine failure (cancellations do not
   *  count: the user asked for those). */
  windowFailures: number;
  /** How many days the window actually spans, so the label can say so. */
  windowDays: number;
}

interface Props {
  status: ImportStatus | undefined;
  accent: string;
  telescopesOnline: number;
  telescopesTotal: number;
  rollup: BackupRollup;
  /** "Sync All" once more than one telescope is configured. */
  syncLabel: string;
  syncDisabled: boolean;
  syncPending: boolean;
  onSync: () => void;
  onCancel: () => void;
  cancelPending: boolean;
}

/**
 * Progress, elapsed time, throughput and remaining time for the active run.
 *
 * Outside the component on purpose: it reads the clock, which a component body
 * must not do. It recomputes on every render, and the page re-renders once a
 * second from the status poll while a sync is running, so the numbers stay live
 * without a timer of their own.
 */
function deriveRun(status: ImportStatus | undefined): {
  percent: number; elapsed: number; rate: number; eta: number;
} {
  if (!status) return { percent: 0, elapsed: 0, rate: 0, eta: 0 };
  const warming = status.warmingThumbnails;

  // Objects carry wildly different file counts, so object progress alone jumps.
  // Weighting the in-flight object by its own file progress keeps the bar moving
  // during a long object instead of sitting still and then leaping.
  const percent = warming
    ? Math.round((warming.done / Math.max(1, warming.total)) * 100)
    : status.objectsTotal > 0
      ? Math.min(100, Math.round(
          ((status.objectsDone
            + (status.currentObjectFilesTotal > 0
              ? status.currentObjectFilesDone / status.currentObjectFilesTotal
              : 0))
            / status.objectsTotal) * 100,
        ))
      : 0;

  const started = status.startedAt ? new Date(status.startedAt).getTime() : NaN;
  const elapsed = Number.isNaN(started) ? 0 : Date.now() - started;
  // Two seconds of samples before quoting a rate: the first poll of a run has a
  // near-zero denominator and produces numbers like "412 MB/s".
  const rate = status.running && elapsed > 2000 && status.bytesDone > 0
    ? status.bytesDone / (elapsed / 1000)
    : 0;
  const bytesLeft = Math.max(0, status.bytesTotal - status.bytesDone);
  const eta = rate > 0 && bytesLeft > 0 && !warming ? (bytesLeft / rate) * 1000 : 0;

  return { percent, elapsed, rate, eta };
}

export function BackupHero({
  status, accent, telescopesOnline, telescopesTotal, rollup,
  syncLabel, syncDisabled, syncPending, onSync, onCancel, cancelPending,
}: Props) {
  const { t } = useTranslation('library');
  const running = status?.running ?? false;
  const warming = status?.warmingThumbnails ?? null;
  const { percent, elapsed, rate, eta } = deriveRun(status);

  const failed = !running && !!status?.error;
  // After a failure the useful number is when the library was last actually
  // brought up to date, not when the failed attempt ran: the attempt has its own
  // panel under the hero, with the error text and its timestamp.
  const lastRunIso = failed ? rollup.lastSuccessAt : (rollup.lastSuccessAt ?? status?.lastRun ?? null);

  const statusLine = (
          running ? (
            warming ? (
              <Trans
                i18nKey="backupHero.buildingThumbnails"
                ns="library"
                count={warming.total}
                values={{ count: warming.total }}
                components={{ 1: <span className="text-white/80" /> }}
              />
            ) : status?.currentObject ? (
              status.telescopeName ? (
                <Trans
                  i18nKey="backupHero.copyingObjectFrom"
                  ns="library"
                  values={{ object: status.currentObject, telescope: status.telescopeName }}
                  components={{ 1: <span className="text-white/80" />, 3: <span className="text-white/80" /> }}
                />
              ) : (
                <Trans
                  i18nKey="backupHero.copyingObject"
                  ns="library"
                  values={{ object: status.currentObject }}
                  components={{ 1: <span className="text-white/80" /> }}
                />
              )
            ) : t('backupHero.lookingForCaptures')
          ) : failed ? (
            // The panel below names the failure. This says what it means for
            // the library, which is the part a person actually wants.
            <span className="inline-flex items-center gap-1.5">
              {status?.cancelled
                ? <Ban className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                : <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-300" />}
              {status?.cancelled
                ? t('backupHero.stoppedPartway')
                : t('backupHero.waitingOnTelescope')}
            </span>
          ) : lastRunIso ? (
            <>{t('backupHero.upToDate')}</>
          ) : (
            t('backupHero.noSyncYet')
          )
  );

  const actionButton = (
      running ? (
        // Thumbnail warming is a quick local pass with no cancellation hook
        // of its own, so cancelling then would sit and do nothing until it
        // finished anyway. The button is only offered during the transfer.
        !warming && status?.runId ? (
          <button
            onClick={onCancel}
            disabled={cancelPending}
            className="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-full border border-white/20 px-4 py-2.5 text-sm font-semibold text-white/80 transition hover:bg-white/10 disabled:opacity-50 sm:w-auto"
          >
            <X className="h-4 w-4" />
            {cancelPending ? t('backupHero.cancelling') : t('backupHero.cancel')}
          </button>
        ) : null
      ) : (
        <button
          onClick={onSync}
          disabled={syncDisabled}
          title={syncDisabled ? t('backupHero.noTelescopeReachable') : undefined}
          className="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
          style={{ background: accent, boxShadow: `0 8px 24px -12px ${accent}` }}
        >
          {syncPending
            ? <RefreshCw className="h-4 w-4 animate-spin" />
            : <Download className="h-4 w-4" />}
          {syncLabel}
        </button>
      )
  );

  return (
    <CollapsibleHero
      page="backup"
      image={PAGE_HERO.backup}
      accent={accent}
      icon={<FolderSync className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />}
      title={t('backupHero.title')}
      summary={running ? <>{statusLine} <span className="font-semibold text-white/80">{percent}%</span></> : statusLine}
      actions={actionButton}
      contentClassName="flex hero-min-h flex-col justify-center gap-6 p-4 sm:p-6"
    >
        {/* Stacks on a phone: side by side, the title wraps to two lines and the
            button crowds it. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 lg:max-w-[58%]">
            <h1 className="font-display flex items-center gap-2.5 text-xl font-bold tracking-tight text-white sm:text-4xl">
              <FolderSync className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />
              {t('backupHero.title')}
            </h1>

            <p className="mt-2 text-[0.8125rem] text-white/55">{statusLine}</p>
          </div>

          {actionButton}
        </div>

        {running && status
          ? <LiveProgress
              status={status}
              percent={percent}
              accent={accent}
              elapsed={elapsed}
              rate={rate}
              eta={eta}
            />
          : <IdleStats
              telescopesOnline={telescopesOnline}
              telescopesTotal={telescopesTotal}
              rollup={rollup}
              lastRunIso={lastRunIso}
              lastRunFailed={failed}
            />}
    </CollapsibleHero>
  );
}

/** The bar plus the four numbers worth watching while files are moving. */
function LiveProgress({
  status, percent, accent, elapsed, rate, eta,
}: {
  status: ImportStatus;
  percent: number;
  accent: string;
  elapsed: number;
  rate: number;
  eta: number;
}) {
  const { t } = useTranslation('library');
  const warming = status.warmingThumbnails;

  const chips: { label: string; value: string }[] = warming
    ? [{ label: t('backupHero.chipObjects'), value: `${formatNumber(warming.done)} / ${formatNumber(warming.total)}` }]
    : [
        { label: t('backupHero.chipObjects'), value: `${formatNumber(status.objectsDone)} / ${formatNumber(status.objectsTotal)}` },
        { label: t('backupHero.chipFiles'), value: `${formatNumber(status.filesDone)} / ${formatNumber(status.filesTotal)}` },
        {
          label: t('backupHero.chipData'),
          value: status.bytesTotal > 0
            ? `${formatBytes(status.bytesDone)} / ${formatBytes(status.bytesTotal)}`
            : t('backupHero.measuring'),
        },
      ];

  if (rate > 0) chips.push({ label: t('backupHero.chipSpeed'), value: `${formatBytes(rate)}/s` });
  // The one number people actually wait on, so it goes last where the eye lands
  // after the rate that produced it.
  if (eta > 0) chips.push({ label: t('backupHero.chipTimeLeft'), value: formatEta(eta) });

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-white/45">
          {warming ? t('backupHero.generatingThumbnails') : t('backupHero.syncingInProgress')}
        </span>
        <span className="flex items-center gap-3 text-xs text-white/45">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            {formatDuration(elapsed)}
          </span>
          <span className="font-display text-lg font-bold leading-none tracking-tight text-white tabular-nums">
            {percent}%
          </span>
        </span>
      </div>

      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={warming ? t('backupHero.thumbnailProgress') : t('backupHero.syncProgress')}
        className="h-2 overflow-hidden rounded-full bg-white/10"
      >
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${percent}%`, background: accent, boxShadow: `0 0 16px -2px ${accent}` }}
        />
      </div>

      <div className="hidden flex-wrap gap-x-8 gap-y-3 pt-1 sm:flex">
        {chips.map(({ label, value }) => (
          <div key={label} className="min-w-0">
            <div className="font-display text-base font-bold leading-none tracking-tight text-white tabular-nums">
              {value}
            </div>
            <div className="mt-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-white/45">
              {label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** What the page is for when nothing is running: is it current, and is it working. */
function IdleStats({
  telescopesOnline, telescopesTotal, rollup, lastRunIso, lastRunFailed,
}: {
  telescopesOnline: number;
  telescopesTotal: number;
  rollup: BackupRollup;
  lastRunIso: string | null;
  lastRunFailed: boolean;
}) {
  const { t } = useTranslation('library');
  const stats: { value: string; label: string; tone?: 'warn' }[] = [];

  if (lastRunIso) {
    // "Last good sync" once a failure is on screen: the two dates differ then,
    // and this is the one that says how current the library is.
    stats.push({
      value: formatRelativeShort(lastRunIso),
      label: lastRunFailed ? t('backupHero.lastGoodSync') : t('backupHero.lastSync'),
    });
  }
  if (telescopesTotal > 0) {
    // Always a ratio, never the words "Online"/"Offline": those belong to the
    // telescope cards below, and repeating one of them up here would leave two
    // places claiming to be the connection state.
    stats.push({ value: `${formatNumber(telescopesOnline)} / ${formatNumber(telescopesTotal)}`, label: t('backupHero.telescopesOnline') });
  }
  if (rollup.windowFiles > 0) {
    stats.push({ value: formatNumber(rollup.windowFiles), label: t('backupHero.filesOverDays', { days: rollup.windowDays }) });
    stats.push({ value: formatBytes(rollup.windowBytes), label: t('backupHero.copiedOverDays', { days: rollup.windowDays }) });
  }
  if (rollup.windowFailures > 0) {
    stats.push({
      value: formatNumber(rollup.windowFailures),
      label: t('backupHero.failedOverDays', { days: rollup.windowDays }),
      tone: 'warn',
    });
  }

  if (stats.length === 0) return null;

  return (
    <div className="hidden flex-wrap gap-x-12 gap-y-4 sm:flex sm:gap-x-16">
      {stats.map(({ value, label, tone }) => (
        <div key={label} className="min-w-0">
          <div className={`font-display text-2xl font-bold leading-none tracking-tight tabular-nums ${
            tone === 'warn' ? 'text-red-300' : 'text-white'
          }`}>
            {value}
          </div>
          <div className="mt-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-white/45">
            {label}
          </div>
        </div>
      ))}
    </div>
  );
}
