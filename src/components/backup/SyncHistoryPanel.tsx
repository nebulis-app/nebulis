/**
 * The record of past syncs.
 *
 * Rows are scanned, not read: the eye goes down the left edge looking for the
 * one that is not green, so the outcome dot leads and everything else is a
 * single line of facts after it. The whole row opens the detail modal (an icon
 * button on the right was a 28px target for the page's most-wanted action, and
 * on a failed run the row's own error text is truncated to nothing useful).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Ban, CalendarDays, ChevronDown, CheckCircle2, ChevronLeft, ChevronRight, ChevronRight as Chevron,
  FileStack, FileX, HardDrive, History, Network, Telescope, Usb, X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  getImportHistory, formatTransport,
  type ImportHistoryEntry, type ImportSkip, type TouchedSession,
} from '../../lib/api/library';
import { SkippedNotice } from '../SkippedNotice';
import { SkippedFilesModal } from './SkippedFilesModal';
import { DeletedSessionsModal } from './DeletedSessionsModal';
import { Modal } from '../ui/Modal';
import { formatBytes } from '../../lib/utils';
import { formatRelativeTime } from '../../lib/timeFormat';

const PAGE_SIZE = 8;

export function SyncHistoryPanel({ isDark }: { isDark: boolean }) {
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<ImportHistoryEntry | null>(null);

  const { data } = useQuery({
    queryKey: ['import-history', page],
    queryFn: () => getImportHistory(PAGE_SIZE, page * PAGE_SIZE),
    staleTime: 30_000,
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <>
      <section className={`rounded-2xl border ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      }`}>
        <header className={`flex items-center justify-between gap-3 border-b px-5 py-3.5 ${
          isDark ? 'border-slate-800' : 'border-slate-100'
        }`}>
          <h2 className={`font-display flex items-center gap-2 font-semibold ${
            isDark ? 'text-white' : 'text-slate-900'
          }`}>
            <History className="h-4 w-4 text-accent-500" />
            Sync History
            {data && data.total > 0 && (
              <span className={`text-xs font-normal tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {data.total.toLocaleString()}
              </span>
            )}
          </h2>

          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                aria-label="Previous page"
                className={`rounded-lg p-1.5 transition disabled:opacity-30 ${
                  isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
                }`}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className={`text-xs tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                aria-label="Next page"
                className={`rounded-lg p-1.5 transition disabled:opacity-30 ${
                  isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
                }`}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </header>

        {!data || data.total === 0 ? (
          <p className={`px-5 py-6 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            No syncs recorded yet. Every run shows up here with what it brought in.
          </p>
        ) : (
          <ul className={`divide-y ${isDark ? 'divide-slate-800/70' : 'divide-slate-100'}`}>
            {data.entries.map(entry => (
              <HistoryRow key={entry.id} entry={entry} isDark={isDark} onOpen={() => setDetail(entry)} />
            ))}
          </ul>
        )}
      </section>

      <SyncDetailModal entry={detail} isDark={isDark} onClose={() => setDetail(null)} />
    </>
  );
}

function HistoryRow({
  entry, isDark, onOpen,
}: {
  entry: ImportHistoryEntry;
  isDark: boolean;
  onOpen: () => void;
}) {
  // A failed run carries no files and nothing skipped, so gating on content
  // alone used to hide details from exactly the rows worth inspecting.
  const hasDetail = !!entry.error
    || (entry.files?.length ?? 0) > 0
    || (entry.skipped?.length ?? 0) > 0;

  const finished = new Date(entry.finishedAt);
  const skippedTotal = entry.skipped?.reduce((n, s) => n + s.count, 0) ?? 0;

  const body = (
    <>
      <span className={`shrink-0 rounded-lg p-1.5 ${
        entry.cancelled
          ? isDark ? 'bg-amber-500/10' : 'bg-amber-50'
          : entry.error
            ? isDark ? 'bg-red-500/10' : 'bg-red-50'
            : isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'
      }`}>
        {entry.cancelled ? <Ban className="h-3.5 w-3.5 text-amber-500" />
          : entry.error ? <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
          : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
      </span>

      <span className="min-w-0 flex-1">
        <span className={`flex flex-wrap items-baseline gap-x-2 text-sm font-medium ${
          isDark ? 'text-slate-200' : 'text-slate-700'
        }`}>
          {formatRelativeTime(entry.finishedAt)}
          <span className={`text-xs font-normal ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {finished.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            {' · '}
            {finished.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </span>
        </span>

        <span className={`mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs ${
          isDark ? 'text-slate-500' : 'text-slate-400'
        }`}>
          {entry.telescopeName && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <Telescope className="h-3 w-3 shrink-0" />
              <span className="truncate">{entry.telescopeName}</span>
              {entry.transportKind && (
                // Amber marks the cable, sky marks the network. FTP is a network
                // transport, so it groups with SMB rather than falling into the
                // USB colour by being "not smb".
                <span className={`ml-1 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                  entry.transportKind === 'local'
                    ? (isDark ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200')
                    : (isDark ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-sky-50 text-sky-700 border-sky-200')
                }`}>
                  {entry.transportKind === 'local' ? <Usb className="h-2.5 w-2.5" /> : <Network className="h-2.5 w-2.5" />}
                  {formatTransport(entry.transportKind)}
                </span>
              )}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <FileStack className="h-3 w-3" />
            {entry.newFiles} new file{entry.newFiles !== 1 ? 's' : ''}
          </span>
          {entry.bytesNew > 0 && (
            <span className="inline-flex items-center gap-1">
              <HardDrive className="h-3 w-3" />
              {formatBytes(entry.bytesNew)}
            </span>
          )}
          {skippedTotal > 0 && (
            <span className="inline-flex items-center gap-1">
              <FileX className="h-3 w-3" />
              {skippedTotal.toLocaleString()} left out
            </span>
          )}
          {entry.error && (
            <span className={`max-w-[240px] truncate ${entry.cancelled ? 'text-amber-500' : 'text-red-500'}`}>
              {entry.error}
            </span>
          )}
        </span>
      </span>

      {hasDetail && (
        <Chevron className={`h-4 w-4 shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
      )}
    </>
  );

  if (!hasDetail) {
    return <li className="flex items-start gap-3 px-5 py-3">{body}</li>;
  }

  return (
    <li>
      <button
        onClick={onOpen}
        title={entry.cancelled ? 'View cancellation details' : entry.error ? 'View error details' : 'View sync details'}
        className={`flex w-full items-start gap-3 px-5 py-3 text-left transition-colors ${
          isDark ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'
        }`}
      >
        {body}
      </button>
    </li>
  );
}

function SyncDetailModal({
  entry, isDark, onClose,
}: {
  entry: ImportHistoryEntry | null;
  isDark: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      isOpen={!!entry}
      onClose={onClose}
      title="Sync Details"
      className={`flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl ${
        isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white shadow-xl'
      }`}
    >
      {entry && (
        <>
          <div className={`flex items-center justify-between border-b px-5 py-4 ${
            isDark ? 'border-slate-800' : 'border-slate-200'
          }`}>
            <div>
              <h3 className={`font-display font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                Sync Details
              </h3>
              <p className={`mt-0.5 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {new Date(entry.finishedAt).toLocaleDateString('en-US', {
                  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                })}
                {' · '}{entry.newFiles} file{entry.newFiles !== 1 ? 's' : ''}
                {entry.bytesNew > 0 && ` · ${formatBytes(entry.bytesNew)}`}
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className={`rounded-lg p-1.5 transition ${
                isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
              }`}
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Keyed on entry.id: forces SyncDetailBody to remount (and its
              collapsed-file-list toggle to reset) when a different history
              row is opened, instead of carrying stale expand state over. */}
          <SyncDetailBody key={entry.id} entry={entry} isDark={isDark} onNavigate={onClose} />
        </>
      )}
    </Modal>
  );
}

function SyncDetailBody({
  entry, isDark, onNavigate,
}: {
  entry: ImportHistoryEntry;
  isDark: boolean;
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [inspectSkip, setInspectSkip] = useState<ImportSkip | null>(null);
  const [showDeletedSessions, setShowDeletedSessions] = useState(false);
  const files = entry.files ?? [];

  const goTo = (path: string): void => {
    onNavigate();
    navigate(path);
  };

  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-5 py-3">
      {/* First in the modal: on a failed run this is the whole story, and
          the row above truncates it. Wraps and stays selectable so the
          full host/share can be copied into a bug report. */}
      {entry.error && (
        <div className={`rounded-xl border p-3 ${
          entry.cancelled
            ? (isDark ? 'bg-amber-500/10 border-amber-500/20' : 'bg-amber-50 border-amber-200')
            : (isDark ? 'bg-red-500/10 border-red-500/20' : 'bg-red-50 border-red-200')
        }`}>
          <div className="flex items-start gap-2">
            {entry.cancelled
              ? <Ban className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />}
            <div className="min-w-0 space-y-1.5">
              <p className={`text-xs font-semibold ${
                entry.cancelled
                  ? (isDark ? 'text-amber-300' : 'text-amber-700')
                  : (isDark ? 'text-red-300' : 'text-red-700')
              }`}>
                {entry.cancelled ? 'This sync was cancelled' : 'This sync failed'}
              </p>
              <p className={`select-text break-words text-xs leading-relaxed ${
                entry.cancelled
                  ? (isDark ? 'text-amber-200/90' : 'text-amber-800')
                  : (isDark ? 'text-red-200/90' : 'text-red-800')
              }`}>
                {entry.error}
              </p>
              {entry.telescopeName && (
                <p className={`text-[11px] ${
                  entry.cancelled
                    ? (isDark ? 'text-amber-300/60' : 'text-amber-600/80')
                    : (isDark ? 'text-red-300/60' : 'text-red-600/80')
                }`}>
                  {entry.telescopeName}
                  {entry.transportKind && ` · ${formatTransport(entry.transportKind)}`}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Above the file list on purpose: a user who opens this is usually
          looking for what is missing, not what arrived. */}
      <SkippedNotice
        skipped={entry.skipped}
        isDark={isDark}
        heading={total => `${total.toLocaleString()} file${total !== 1 ? 's' : ''} were left on the telescope:`}
        onInspect={setInspectSkip}
        onReviewDeletedSessions={() => setShowDeletedSessions(true)}
      />

      <SkippedFilesModal skip={inspectSkip} isDark={isDark} onClose={() => setInspectSkip(null)} />
      <DeletedSessionsModal
        isOpen={showDeletedSessions}
        isDark={isDark}
        onClose={() => setShowDeletedSessions(false)}
      />

      {entry.sessionsTouched && entry.sessionsTouched.length > 0 && (
        <TouchedSection
          label="Observations"
          icon={<CalendarDays className="h-3.5 w-3.5" />}
          isDark={isDark}
        >
          {entry.sessionsTouched.map(session => (
            <TouchedSessionRow key={`${session.objectId}|${session.date}`} session={session} isDark={isDark} onOpen={goTo} />
          ))}
        </TouchedSection>
      )}

      {files.length > 0 && (
        <div>
          <button
            onClick={() => setFilesExpanded(v => !v)}
            className={`flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
              isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'
            }`}
            aria-expanded={filesExpanded}
          >
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${filesExpanded ? 'rotate-0' : '-rotate-90'}`} />
            All {files.length.toLocaleString()} file{files.length !== 1 ? 's' : ''}
          </button>

          {filesExpanded && (
            <div className="mt-1 space-y-1">
              {files.map((file, i) => (
                <div
                  key={i}
                  className={`rounded-lg px-3 py-1.5 font-mono text-xs ${
                    isDark ? 'bg-slate-800/50 text-slate-400' : 'bg-slate-50 text-slate-500'
                  }`}
                >
                  {file}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TouchedSection({
  label, icon, isDark, children,
}: {
  label: string;
  icon: React.ReactNode;
  isDark: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className={`flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wide ${
        isDark ? 'text-slate-500' : 'text-slate-400'
      }`}>
        {icon}
        {label}
      </h4>
      <div className="mt-1 space-y-0.5">{children}</div>
    </div>
  );
}

function NewBadge({ isNew, isDark }: { isNew: boolean; isDark: boolean }) {
  return (
    <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
      isNew
        ? (isDark ? 'bg-accent-500/15 text-accent-300 border-accent-500/30' : 'bg-accent-50 text-accent-700 border-accent-200')
        : (isDark ? 'bg-slate-800 text-slate-400 border-slate-700' : 'bg-slate-100 text-slate-500 border-slate-200')
    }`}>
      {isNew ? 'New' : 'Updated'}
    </span>
  );
}

function TouchedSessionRow({
  session, isDark, onOpen,
}: {
  session: TouchedSession;
  isDark: boolean;
  onOpen: (path: string) => void;
}) {
  const dateLabel = new Date(`${session.date}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  return (
    <button
      onClick={() => onOpen(`/observations/${encodeURIComponent(session.objectId)}/${session.date}`)}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
        isDark ? 'hover:bg-slate-800/70' : 'hover:bg-slate-50'
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-sm">
        <span className={isDark ? 'text-slate-200' : 'text-slate-700'}>{session.objectName}</span>
        <span className={`ml-1.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{dateLabel}</span>
      </span>
      <NewBadge isNew={session.isNew} isDark={isDark} />
      <Chevron className={`h-3.5 w-3.5 shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
    </button>
  );
}
