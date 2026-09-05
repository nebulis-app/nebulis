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
import { FolderSync, Download, RefreshCw, X, Clock, AlertTriangle, Ban } from 'lucide-react';
import { HeroBackdrop } from '../ui/HeroBackdrop';
import { PAGE_HERO } from '../../lib/heroImagery';
import { formatBytes } from '../../lib/utils';
import { formatDuration, formatEta, formatRelativeShort } from '../../lib/timeFormat';
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
  const running = status?.running ?? false;
  const warming = status?.warmingThumbnails ?? null;
  const { percent, elapsed, rate, eta } = deriveRun(status);

  const failed = !running && !!status?.error;
  // After a failure the useful number is when the library was last actually
  // brought up to date, not when the failed attempt ran: the attempt has its own
  // panel under the hero, with the error text and its timestamp.
  const lastRunIso = failed ? rollup.lastSuccessAt : (rollup.lastSuccessAt ?? status?.lastRun ?? null);

  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel"
    >
      <HeroBackdrop image={PAGE_HERO.backup} />

      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: `radial-gradient(90% 140% at 8% 0%, ${accent}1f 0%, transparent 60%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{ background: `radial-gradient(70% 130% at 95% 100%, ${accent}14 0%, transparent 62%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-3xl"
        style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }}
      />

      <div className="relative flex min-h-[9.5rem] flex-col justify-center gap-6 p-5 sm:min-h-[11.5rem] sm:p-7">
        {/* Stacks on a phone: side by side, the title wraps to two lines and the
            button crowds it. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 lg:max-w-[58%]">
            <h1 className="font-display flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              <FolderSync className="h-6 w-6 sm:h-7 sm:w-7" style={{ color: accent }} />
              Backup Status
            </h1>

            <p className="mt-2 text-[13px] text-white/55">
              {running ? (
                warming ? (
                  <>Building thumbnails for <span className="text-white/80">{warming.total}</span> object{warming.total !== 1 ? 's' : ''}. The files are already safe.</>
                ) : status?.currentObject ? (
                  <>
                    Copying <span className="text-white/80">{status.currentObject}</span>
                    {status.telescopeName && <> from <span className="text-white/80">{status.telescopeName}</span></>}
                  </>
                ) : 'Looking for new captures.'
              ) : failed ? (
                // The panel below names the failure. This says what it means for
                // the library, which is the part a person actually wants.
                <span className="inline-flex items-center gap-1.5">
                  {status?.cancelled
                    ? <Ban className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                    : <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-300" />}
                  {status?.cancelled
                    ? 'Stopped partway. Anything already copied is still here.'
                    : 'Some captures may still be waiting on the telescope.'}
                </span>
              ) : lastRunIso ? (
                <>Everything captured up to your last sync is on this machine.</>
              ) : (
                'No sync has run yet. Connect a telescope, then pull your captures across.'
              )}
            </p>
          </div>

          {running ? (
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
                {cancelPending ? 'Cancelling' : 'Cancel'}
              </button>
            ) : null
          ) : (
            <button
              onClick={onSync}
              disabled={syncDisabled}
              title={syncDisabled ? 'No telescope is reachable right now' : undefined}
              className="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
              style={{ background: accent, boxShadow: `0 8px 24px -12px ${accent}` }}
            >
              {syncPending
                ? <RefreshCw className="h-4 w-4 animate-spin" />
                : <Download className="h-4 w-4" />}
              {syncLabel}
            </button>
          )}
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
      </div>
    </section>
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
  const warming = status.warmingThumbnails;

  const chips: { label: string; value: string }[] = warming
    ? [{ label: 'Objects', value: `${warming.done} / ${warming.total}` }]
    : [
        { label: 'Objects', value: `${status.objectsDone} / ${status.objectsTotal}` },
        { label: 'Files', value: `${status.filesDone} / ${status.filesTotal}` },
        {
          label: 'Data',
          value: status.bytesTotal > 0
            ? `${formatBytes(status.bytesDone)} / ${formatBytes(status.bytesTotal)}`
            : 'Measuring',
        },
      ];

  if (rate > 0) chips.push({ label: 'Speed', value: `${formatBytes(rate)}/s` });
  // The one number people actually wait on, so it goes last where the eye lands
  // after the rate that produced it.
  if (eta > 0) chips.push({ label: 'Time left', value: formatEta(eta) });

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/45">
          {warming ? 'Generating thumbnails' : 'Syncing in progress'}
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
        aria-label={warming ? 'Thumbnail progress' : 'Sync progress'}
        className="h-2 overflow-hidden rounded-full bg-white/10"
      >
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${percent}%`, background: accent, boxShadow: `0 0 16px -2px ${accent}` }}
        />
      </div>

      <div className="flex flex-wrap gap-x-8 gap-y-3 pt-1">
        {chips.map(({ label, value }) => (
          <div key={label} className="min-w-0">
            <div className="font-display text-base font-bold leading-none tracking-tight text-white tabular-nums">
              {value}
            </div>
            <div className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-white/45">
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
  const stats: { value: string; label: string; tone?: 'warn' }[] = [];

  if (lastRunIso) {
    // "Last good sync" once a failure is on screen: the two dates differ then,
    // and this is the one that says how current the library is.
    stats.push({
      value: formatRelativeShort(lastRunIso),
      label: lastRunFailed ? 'Last good sync' : 'Last sync',
    });
  }
  if (telescopesTotal > 0) {
    // Always a ratio, never the words "Online"/"Offline": those belong to the
    // telescope cards below, and repeating one of them up here would leave two
    // places claiming to be the connection state.
    stats.push({ value: `${telescopesOnline} / ${telescopesTotal}`, label: 'Telescopes online' });
  }
  if (rollup.windowFiles > 0) {
    stats.push({ value: rollup.windowFiles.toLocaleString(), label: `Files · ${rollup.windowDays}d` });
    stats.push({ value: formatBytes(rollup.windowBytes), label: `Copied · ${rollup.windowDays}d` });
  }
  if (rollup.windowFailures > 0) {
    stats.push({
      value: String(rollup.windowFailures),
      label: `Failed · ${rollup.windowDays}d`,
      tone: 'warn',
    });
  }

  if (stats.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-x-12 gap-y-4 sm:gap-x-16">
      {stats.map(({ value, label, tone }) => (
        <div key={label} className="min-w-0">
          <div className={`font-display text-2xl font-bold leading-none tracking-tight tabular-nums ${
            tone === 'warn' ? 'text-red-300' : 'text-white'
          }`}>
            {value}
          </div>
          <div className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-white/45">
            {label}
          </div>
        </div>
      ))}
    </div>
  );
}
