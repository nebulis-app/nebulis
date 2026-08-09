import { AlertCircle } from 'lucide-react';
import type { ImportSkip } from '../lib/api/library';

/**
 * Skip reasons that turning on "Archive everything" actually rescues.
 *
 * The rest cannot be fixed by that switch and must not be advertised as if they
 * could: `deleted-session` is a session the user deleted, `date-dropped` is a
 * choice they made in the review step, and `undecodable-session-folder` is a
 * folder whose name yielded no target or date. Keep in sync with the archive
 * branch of classifyImportFile in server/lib/library/importFilter.ts.
 *
 * `non-observation-folder` is a special case and is deliberately absent. Archive
 * mode does now keep those folders, but it copies them into the library's
 * archive rather than importing them, and the count is folders rather than
 * files, so it cannot be added to a files-and-bytes total. The scan simply
 * stops reporting them once archive mode is on, and the wizard says what will
 * happen to them instead.
 */
const ARCHIVE_RESCUABLE = new Set([
  'processing-artifact',
  'failed-frame',
  'unsupported-type',
  'sub-frames-disabled',
  'sub-folder-preview',
  'thumbnails-disabled',
  'jpg-disabled',
  'fits-disabled',
  'videos-disabled',
]);

/** Compact size for a skip group. Binary units, matching the rest of the app. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * Accounts for files an import found but will not bring in.
 *
 * Without it the only signal is a file count lower than what is on the source,
 * which reads as the import losing files rather than as a setting doing its job.
 * Shared by the folder-import wizard (scan preview) and the backup status page
 * (telescope imports, live and historical) so all of them explain a gap in the
 * same words. The `label` text is server-authored: see SKIP_LABELS in
 * server/lib/library/importFilter.ts.
 */
export function SkippedNotice({
  skipped,
  isDark,
  heading,
  excludedFolders,
}: {
  skipped: ImportSkip[] | null | undefined;
  isDark: boolean;
  /** Override the default lead-in. Use the past tense for a finished run. */
  heading?: (total: number) => string;
  /** Names behind the `non-observation-folder` count, when the caller has them
   *  (the folder-import scan does; a finished telescope import does not). */
  excludedFolders?: string[];
}) {
  if (!skipped || skipped.length === 0) return null;
  const total = skipped.reduce((n, s) => n + s.count, 0);
  const rescuable = skipped.filter(s => ARCHIVE_RESCUABLE.has(s.reason));
  const rescuableBytes = rescuable.reduce((n, s) => n + (s.bytes ?? 0), 0);
  const rescuableCount = rescuable.reduce((n, s) => n + s.count, 0);
  const lead = heading
    ? heading(total)
    : `${total.toLocaleString()} file${total !== 1 ? 's' : ''} will not be imported:`;

  return (
    <div className={`p-3 rounded-xl text-sm text-left ${isDark ? 'bg-slate-800/60 text-slate-300' : 'bg-slate-50 text-slate-600'}`}>
      <div className="flex items-start gap-2">
        <AlertCircle className={`w-4 h-4 shrink-0 mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-400'}`} />
        <div className="space-y-1">
          <span>{lead}</span>
          <ul className="space-y-0.5">
            {skipped.map(s => (
              <li key={s.reason} className={isDark ? 'text-slate-400' : 'text-slate-500'}>
                {s.count.toLocaleString()} {s.label}
                {/* Size is omitted when it is 0, which means "not measured"
                    (a remote listing without sizes, or a history row written
                    before sizes were tallied) rather than "empty". */}
                {s.bytes ? ` (${formatBytes(s.bytes)})` : ''}
                {s.reason === 'non-observation-folder' && excludedFolders && excludedFolders.length > 0 && (
                  <span className="font-mono">: {excludedFolders.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
          {rescuableBytes > 0 && (
            <p className={`pt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Turning on <span className="font-medium">Archive everything</span> would
              bring {rescuableCount === total ? 'these' : `${rescuableCount.toLocaleString()} of them`}
              {' '}across, adding about {formatBytes(rescuableBytes)}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
