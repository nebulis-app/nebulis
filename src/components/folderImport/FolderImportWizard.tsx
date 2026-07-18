import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X, RotateCw, AlertCircle, CheckCircle2, FolderSearch, ArrowRight, FolderInput,
} from 'lucide-react';
import {
  scanImportFolder,
  commitFolderImport,
  getImportStatus,
  type ImportScanResult,
  type ImportScanSkip,
  type ImportCommitPlan,
} from '../../lib/api/library';
import { useTheme } from '../../hooks/useTheme';
import { Modal } from '../ui/Modal';
import { ObjectReviewCard, type ObjectEdit } from './ObjectReviewCard';

type Phase = 'scanning' | 'review' | 'committing' | 'done';

/** Accounts for files the scan found but will not import. Without it, the only
 *  signal is a file count lower than the folder the user picked, which reads as
 *  the import being broken rather than as a setting doing its job. */
function SkippedNotice({ skipped, isDark }: { skipped: ImportScanSkip[]; isDark: boolean }) {
  if (skipped.length === 0) return null;
  const total = skipped.reduce((n, s) => n + s.count, 0);
  return (
    <div className={`p-3 rounded-xl text-sm text-left ${isDark ? 'bg-slate-800/60 text-slate-300' : 'bg-slate-50 text-slate-600'}`}>
      <div className="flex items-start gap-2">
        <AlertCircle className={`w-4 h-4 shrink-0 mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-400'}`} />
        <div className="space-y-1">
          <span>
            {total.toLocaleString()} file{total !== 1 ? 's' : ''} will not be imported:
          </span>
          <ul className="space-y-0.5">
            {skipped.map(s => (
              <li key={s.reason} className={isDark ? 'text-slate-400' : 'text-slate-500'}>
                {s.count.toLocaleString()} {s.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function buildEdits(result: ImportScanResult): ObjectEdit[] {
  return result.objects.map(o => ({
    folderName: o.folderName,
    fileCount: o.fileCount,
    bytes: o.bytes,
    skip: false,
    targetObjectId: o.catalogMatch?.objectId ?? o.folderName,
    targetFolderName: o.folderName,
    catalogName: o.catalogMatch?.name ?? null,
    sessions: o.sessions.map(s => ({
      derivedDate: s.date,
      finalDate: s.date,
      drop: false,
      fileCount: s.fileCount,
      confidence: s.confidence,
      source: s.source,
    })),
    unsortedCount: o.unsortedCount,
    unsortedAssign: '',
  }));
}

function buildPlan(
  rootPath: string,
  edits: ObjectEdit[],
  includeSubframes: boolean,
  includeFits: boolean,
  telescopeId: string | null,
): ImportCommitPlan {
  const objects = edits
    .filter(e => !e.skip)
    .map(e => {
      const sessionMap: Record<string, string | null> = {};
      for (const s of e.sessions) sessionMap[s.derivedDate] = s.drop ? null : s.finalDate;
      if (e.unsortedCount > 0) sessionMap['unknown'] = e.unsortedAssign || null;
      return {
        folderName: e.folderName,
        targetObjectId: e.targetObjectId,
        targetFolderName: e.targetFolderName,
        sessionMap,
      };
    });
  return { rootPath, objects, importSubFrames: includeSubframes, importFits: includeFits, telescopeId };
}

export function FolderImportWizard({
  rootPath,
  includeSubframes = false,
  includeFits = true,
  telescopeId = null,
  onClose,
  onDone,
}: {
  rootPath: string;
  includeSubframes?: boolean;
  includeFits?: boolean;
  telescopeId?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('scanning');
  const [edits, setEdits] = useState<ObjectEdit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [skipped, setSkipped] = useState<ImportScanSkip[]>([]);

  const card = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';
  const mutedText = isDark ? 'text-slate-500' : 'text-slate-400';
  const border = isDark ? 'border-slate-800' : 'border-slate-200';

  // ── Phase 1: scan ────────────────────────────────────────────────────────
  const scanMutation = useMutation({
    mutationFn: () => scanImportFolder(rootPath, includeSubframes, includeFits),
    onSuccess: (result) => {
      setEdits(buildEdits(result));
      setTruncated(result.truncated);
      setSkipped(result.skipped ?? []);
      setPhase('review');
    },
  });
  // Kick off the scan once on mount.
  const { mutate: startScan } = scanMutation;
  useEffect(() => {
    startScan();
  }, [startScan]);

  // ── Phase 2: commit ──────────────────────────────────────────────────────
  const commitMutation = useMutation({
    mutationFn: (plan: ImportCommitPlan) => commitFolderImport(plan),
    onSuccess: () => {
      // Remove any stale import-status cache (e.g. from a previous telescope
      // import) so the polling loop always starts with a fresh server response.
      queryClient.removeQueries({ queryKey: ['import-status'] });
      setPhase('committing');
    },
  });

  const statusQuery = useQuery({
    queryKey: ['import-status'],
    queryFn: getImportStatus,
    enabled: phase === 'committing',
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false;
      return query.state.data?.running ? 1000 : false;
    },
  });

  // Transition to done once the background commit stops running.
  useEffect(() => {
    if (phase !== 'committing') return;
    const status = statusQuery.data;
    if (status && !status.running) {
      setPhase('done');
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      if (!status.error) onDone();
    }
  }, [phase, statusQuery.data, queryClient, onDone]);

  const skippedTotal = useMemo(() => skipped.reduce((n, s) => n + s.count, 0), [skipped]);

  // ── Derived totals for the footer ──────────────────────────────────────────
  const selected = useMemo(() => edits.filter(e => !e.skip), [edits]);
  const totals = useMemo(() => {
    let files = 0;
    let sessions = 0;
    for (const e of selected) {
      const finalDates = new Set<string>();
      for (const s of e.sessions) {
        if (s.drop) continue;
        files += s.fileCount;
        finalDates.add(s.finalDate);
      }
      if (e.unsortedAssign) {
        files += e.unsortedCount;
        finalDates.add(e.unsortedAssign);
      }
      sessions += finalDates.size;
    }
    return { objects: selected.length, files, sessions };
  }, [selected]);

  const updateEdit = (i: number, next: ObjectEdit) =>
    setEdits(prev => prev.map((e, idx) => (idx === i ? next : e)));

  const handleCommit = () => {
    if (totals.objects === 0 || totals.files === 0) return;
    commitMutation.mutate(buildPlan(rootPath, edits, includeSubframes, includeFits, telescopeId));
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Import library from a folder"
      className={`relative w-full max-w-3xl max-h-[88vh] flex flex-col rounded-2xl border shadow-2xl ${card}`}
    >
      {/* Header */}
      <div className={`flex items-center justify-between px-6 py-4 border-b ${border}`}>
        <div className="min-w-0">
          <h2 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
            Import library
          </h2>
          <p className={`text-xs mt-0.5 font-mono truncate ${mutedText}`}>{rootPath}</p>
        </div>
        <button onClick={onClose} className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}>
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* Scanning */}
        {phase === 'scanning' && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            {scanMutation.isError ? (
              <>
                <AlertCircle className="w-8 h-8 text-red-500" />
                <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  {scanMutation.error instanceof Error ? scanMutation.error.message : 'Scan failed'}
                </p>
                <div className="flex gap-2 mt-1">
                  <button onClick={() => scanMutation.mutate()} className={`px-3 py-1.5 rounded-lg text-sm border ${border} ${subText}`}>
                    Try again
                  </button>
                  <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm bg-accent-500 text-white">Close</button>
                </div>
              </>
            ) : (
              <>
                <FolderSearch className={`w-8 h-8 ${isDark ? 'text-accent-400' : 'text-accent-500'} animate-pulse`} />
                <p className={`text-sm ${subText}`}>Scanning the folder and reading file dates...</p>
              </>
            )}
          </div>
        )}

        {/* Review */}
        {phase === 'review' && (
          <div className="space-y-3">
            {edits.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <FolderInput className={`w-8 h-8 ${mutedText}`} />
                <p className={`text-sm ${subText}`}>
                  {skippedTotal > 0
                    ? `Nothing here can be imported with your current settings. All ${skippedTotal.toLocaleString()} file${skippedTotal !== 1 ? 's' : ''} were skipped.`
                    : 'No importable files were found in this folder. Check that it contains image or FITS files.'}
                </p>
                <SkippedNotice skipped={skipped} isDark={isDark} />
              </div>
            ) : (
              <>
                <div className={`flex items-center gap-2 text-sm ${subText}`}>
                  <span>{edits.length} object{edits.length !== 1 ? 's' : ''} found.</span>
                  <span className={mutedText}>Confirm the catalog match and session dates, then import.</span>
                </div>
                {truncated && (
                  <div className={`flex items-start gap-2 p-3 rounded-xl text-sm ${isDark ? 'bg-amber-500/10 text-amber-300' : 'bg-amber-50 text-amber-700'}`}>
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    This folder has a very large number of files, so the scan stopped early. Import what's shown, then scan again to pick up the rest.
                  </div>
                )}
                <SkippedNotice skipped={skipped} isDark={isDark} />
                {edits.map((edit, i) => (
                  <ObjectReviewCard key={edit.folderName} edit={edit} onChange={next => updateEdit(i, next)} />
                ))}
              </>
            )}
          </div>
        )}

        {/* Committing / Done */}
        {(phase === 'committing' || phase === 'done') && (
          <CommitProgress
            phase={phase}
            filesTotal={statusQuery.data?.filesTotal ?? totals.files}
            filesDone={statusQuery.data?.filesDone ?? 0}
            objectsDone={statusQuery.data?.objectsDone ?? 0}
            objectsTotal={statusQuery.data?.objectsTotal ?? totals.objects}
            error={statusQuery.data?.error ?? null}
          />
        )}
      </div>

      {/* Footer */}
      {phase === 'review' && edits.length > 0 && (
        <div className={`flex items-center justify-between gap-3 px-6 py-4 border-t ${border}`}>
          <p className={`text-sm ${subText}`}>
            Importing <span className={isDark ? 'text-slate-200' : 'text-slate-800'}>{totals.files}</span> file{totals.files !== 1 ? 's' : ''} into{' '}
            <span className={isDark ? 'text-slate-200' : 'text-slate-800'}>{totals.sessions}</span> session{totals.sessions !== 1 ? 's' : ''} across{' '}
            {totals.objects} object{totals.objects !== 1 ? 's' : ''}.
          </p>
          <div className="flex items-center gap-2">
            {commitMutation.isError && (
              <span className="text-xs text-red-500">
                {commitMutation.error instanceof Error ? commitMutation.error.message : 'Failed to start'}
              </span>
            )}
            <button onClick={onClose} className={`px-4 py-2 rounded-xl text-sm font-medium border transition ${border} ${subText} ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-50'}`}>
              Cancel
            </button>
            <button
              onClick={handleCommit}
              disabled={totals.files === 0 || commitMutation.isPending}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
            >
              {commitMutation.isPending
                ? <><RotateCw className="w-4 h-4 animate-spin" /> Starting...</>
                : <>Import <ArrowRight className="w-4 h-4" /></>}
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className={`flex items-center justify-end px-6 py-4 border-t ${border}`}>
          <button onClick={onClose} className="px-5 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition">
            Done
          </button>
        </div>
      )}
    </Modal>
  );
}

function CommitProgress({
  phase, filesTotal, filesDone, objectsDone, objectsTotal, error,
}: {
  phase: Phase;
  filesTotal: number;
  filesDone: number;
  objectsDone: number;
  objectsTotal: number;
  error: string | null;
}) {
  const { isDark } = useTheme();
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';
  const pct = filesTotal > 0 ? Math.min(100, Math.round((filesDone / filesTotal) * 100)) : 0;

  if (phase === 'done' && error) {
    return (
      <div className="flex flex-col items-center gap-3 py-14 text-center">
        <AlertCircle className="w-9 h-9 text-red-500" />
        <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{error}</p>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="flex flex-col items-center gap-3 py-14 text-center">
        <CheckCircle2 className="w-10 h-10 text-emerald-500" />
        <p className={`font-medium ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Import complete</p>
        <p className={`text-sm ${subText}`}>
          {filesDone} file{filesDone !== 1 ? 's' : ''} imported into your library across {objectsTotal} object{objectsTotal !== 1 ? 's' : ''}.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 py-14 text-center">
      <RotateCw className={`w-8 h-8 ${isDark ? 'text-accent-400' : 'text-accent-500'} animate-spin`} />
      <div className="w-full max-w-sm">
        <div className={`h-2 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
          <div className="h-full bg-accent-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className={`text-sm mt-3 ${subText}`}>
          Importing... {filesDone} of {filesTotal} file{filesTotal !== 1 ? 's' : ''}
          {objectsTotal > 0 ? ` · object ${Math.min(objectsDone + 1, objectsTotal)} of ${objectsTotal}` : ''}
        </p>
      </div>
    </div>
  );
}
