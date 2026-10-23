import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Trash2 } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { deleteLibraryFile } from '../../lib/api/library';
import { isLinkedPath } from '../../lib/linkedPaths';
import { CloseConfirm } from '../ui/CloseConfirm';

interface Props {
  selection: ReadonlySet<string>;
  badCount: number;
  flaggedCount: number;
  onSelectBad: () => void;
  onSelectFlagged: () => void;
  onClear: () => void;
  /** Marks the selection keep (true), reject (false) or back to its grade (null). Omitted: no review buttons. */
  onReview?: (keep: boolean | null) => Promise<void>;
  /** Called with the paths that were deleted, so the page can refresh. */
  onDeleted: (paths: string[]) => void;
}

const BASE = 'observationDetail.frameAnalysisModal';

/** Sticks to the bottom of the list while frames are selected: pick the bad ones, then delete them. */
export function SubframeSelectionBar({ selection, badCount, flaggedCount, onSelectBad, onSelectFlagged, onClear, onReview, onDeleted }: Props) {
  const { t } = useTranslation('observations');
  const { isDark } = useTheme();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string | null>(null);

  const linked = [...selection].filter(isLinkedPath).length;
  const button = `px-3 py-1.5 rounded-lg text-xs font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed ${
    isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
  }`;

  const discard = async () => {
    setConfirming(false);
    setBusy(true);
    const removed: string[] = [];
    const failures: string[] = [];
    for (const path of selection) {
      try {
        await deleteLibraryFile(path, { deleteLinked: isLinkedPath(path) });
        removed.push(path);
      } catch (err) {
        failures.push(`${path.split('/').pop() ?? path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setBusy(false);
    if (removed.length > 0) onDeleted(removed);
    setReport(failures.length > 0
      ? t(`${BASE}.discardFailures`, { removed: removed.length, count: failures.length, details: failures.slice(0, 5).join('\n') })
      : null);
  };

  return (
    <div
      className={`sticky bottom-3 z-30 mt-3 flex flex-wrap items-center gap-2 overflow-hidden rounded-xl border px-4 py-2.5 shadow-lg ${
        isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
      }`}
    >
      <span className={`min-w-[12rem] flex-1 whitespace-pre-line text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        {report ?? (selection.size === 0 ? t(`${BASE}.selectHint`) : t(`${BASE}.selectedCount`, { count: selection.size }))}
      </span>
      <button type="button" onClick={onSelectBad} disabled={badCount === 0} className={button}>{t(`${BASE}.selectBad`)}</button>
      <button type="button" onClick={onSelectFlagged} disabled={flaggedCount === 0} className={button}>{t(`${BASE}.selectFlagged`)}</button>
      <button type="button" onClick={onClear} disabled={selection.size === 0} className={button}>{t(`${BASE}.clear`)}</button>
      {onReview && ([[true, 'markKeep'], [false, 'markReject'], [null, 'followGrade']] as const).map(([keep, key]) => (
        <button
          key={key}
          type="button"
          disabled={selection.size === 0 || busy}
          onClick={() => { setBusy(true); void onReview(keep).finally(() => setBusy(false)); }}
          className={button}
        >
          {t(`${BASE}.${key}`)}
        </button>
      ))}
      <button
        type="button"
        onClick={() => { setReport(null); setConfirming(true); }}
        disabled={selection.size === 0 || busy}
        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ${
          isDark ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30' : 'bg-red-50 text-red-700 hover:bg-red-100'
        }`}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        {t(`${BASE}.discard`)}
      </button>

      {confirming && (
        <CloseConfirm
          isDark={isDark}
          message={linked > 0
            ? t(`${BASE}.confirmDiscardLinked`, { count: selection.size, linked })
            : t(`${BASE}.confirmDiscard`, { count: selection.size })}
          cancelLabel={t(`${BASE}.keepFrames`)}
          onCancel={() => setConfirming(false)}
          onDiscard={() => void discard()}
        />
      )}
    </div>
  );
}
