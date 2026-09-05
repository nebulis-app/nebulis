/**
 * The filenames behind one "left out" line on the Backup Status page.
 *
 * The skip summary only carries a sample (the first 200 per run), so this never
 * has to render thousands of rows: it pages through that sample ten at a time
 * and, when the sample is shorter than the real count, says so in the footer
 * rather than pretending the list is complete.
 */
import { useState } from 'react';
import { ChevronLeft, ChevronRight, FileX, X } from 'lucide-react';
import { Modal } from '../ui/Modal';
import type { ImportSkip } from '../../lib/api/library';

const PAGE_SIZE = 10;

export function SkippedFilesModal({
  skip, isDark, onClose,
}: {
  skip: ImportSkip | null;
  isDark: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      isOpen={!!skip}
      onClose={onClose}
      title={skip ? `Files: ${skip.label}` : 'Skipped files'}
      className={`flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-2xl ${
        isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white shadow-xl'
      }`}
    >
      {skip && <SkippedFilesBody key={skip.reason} skip={skip} isDark={isDark} onClose={onClose} />}
    </Modal>
  );
}

function SkippedFilesBody({
  skip, isDark, onClose,
}: {
  skip: ImportSkip;
  isDark: boolean;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const samples = skip.samples ?? [];
  const totalPages = Math.max(1, Math.ceil(samples.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const shown = samples.slice(start, start + PAGE_SIZE);
  const truncated = skip.count > samples.length;

  return (
    <>
      <div className={`flex items-start justify-between gap-3 border-b px-5 py-4 ${
        isDark ? 'border-slate-800' : 'border-slate-200'
      }`}>
        <div className="min-w-0">
          <h3 className={`font-display flex items-center gap-2 font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
            <FileX className="h-4 w-4 shrink-0 text-accent-500" />
            <span className="truncate">{cap(skip.label)}</span>
          </h3>
          <p className={`mt-0.5 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {skip.count.toLocaleString()} file{skip.count !== 1 ? 's' : ''} left out
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

      <div className="flex-1 space-y-1 overflow-y-auto px-5 py-3">
        {shown.map((name, i) => (
          <div
            key={start + i}
            className={`select-text break-all rounded-lg px-3 py-1.5 font-mono text-xs ${
              isDark ? 'bg-slate-800/50 text-slate-400' : 'bg-slate-50 text-slate-500'
            }`}
          >
            {name}
          </div>
        ))}
      </div>

      <div className={`flex items-center justify-between gap-3 border-t px-5 py-3 text-xs ${
        isDark ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'
      }`}>
        <span className="tabular-nums">
          {start + 1}-{Math.min(start + PAGE_SIZE, samples.length)} of {samples.length.toLocaleString()}
          {truncated && ` (first ${samples.length.toLocaleString()} of ${skip.count.toLocaleString()})`}
        </span>
        {totalPages > 1 && (
          <span className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label="Previous page"
              className={`rounded-lg p-1.5 transition disabled:opacity-30 ${
                isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
              }`}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="tabular-nums">{page + 1} / {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              aria-label="Next page"
              className={`rounded-lg p-1.5 transition disabled:opacity-30 ${
                isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
              }`}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </span>
        )}
      </div>
    </>
  );
}

/** The server labels read as "<count> <label>" (lowercase). On its own as a
 *  heading it wants a capital. */
function cap(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}
