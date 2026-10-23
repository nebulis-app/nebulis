import { useTranslation } from 'react-i18next';
import { Satellite, ScanSearch, Download, Trash2 } from 'lucide-react';
import { NightFrameList } from '../frameAnalysis/NightFrameList';
import { useTheme } from '../../hooks/useTheme';
import type { SessionFile } from '../../types';

/** Telescope subframes: the controls for the night's raw frames, and under them the frame list with every
 *  frame's score, flags and star measurements (see NightFrameList). */
export function SubframesPanel({
  objectId,
  objectName,
  date,
  subFrames,
  isAdmin,
  telescopeOnline,
  archiveState,
  onDownloadToComputer,
  onOpenSync,
  onScanTrails,
  onAnalyzeFrames,
  onDeleteAllSubframes,
  onFramesDeleted,
}: {
  objectId: string;
  objectName: string;
  date: string;
  subFrames: SessionFile[];
  isAdmin: boolean;
  telescopeOnline: boolean;
  archiveState: { done: number; total: number } | 'idle' | 'error';
  onDownloadToComputer: () => void;
  onOpenSync: () => void;
  onScanTrails: () => void;
  onAnalyzeFrames: () => void;
  onDeleteAllSubframes: () => void;
  /** Called after frames were deleted from the list, so the page refreshes its counts. */
  onFramesDeleted: () => void;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('observations');
  const hasSubFrames = subFrames.length > 0;

  return (
    <div className={`rounded-2xl border min-w-0 flex flex-col ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
      {/* No title row: the selected tab immediately above already names this
          panel and carries its count, so the bar is only its controls. */}
      <div className={`flex items-center justify-end p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <div className="flex items-center gap-2">
          {isAdmin && hasSubFrames && subFrames.some(f => f.type === 'fits') && (
            <button
              onClick={onAnalyzeFrames}
              title={t('observationDetail.subframesPanel.analyzeFramesTitle')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                isDark
                  ? 'border-slate-700 text-slate-300 hover:text-slate-100 hover:bg-slate-800'
                  : 'border-slate-200 text-slate-600 hover:text-slate-800 hover:bg-slate-50'
              }`}
            >
              <ScanSearch className="w-3.5 h-3.5" />
              {t('observationDetail.subframesPanel.analyzeFrames')}
            </button>
          )}
          {isAdmin && hasSubFrames && subFrames.some(f => f.type === 'fits') && (
            <button
              onClick={onScanTrails}
              title={t('observationDetail.subframesPanel.scanTrailsTitle')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                isDark
                  ? 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10'
                  : 'border-amber-300 text-amber-600 hover:bg-amber-50'
              }`}
            >
              <Satellite className="w-3.5 h-3.5" />
              {t('observationDetail.subframesPanel.scanTrails')}
            </button>
          )}
          {isAdmin && (
            <span
              title={!telescopeOnline ? t('observationDetail.subframesPanel.telescopeOfflineTitle') : t('observationDetail.subframesPanel.downloadFromTelescopeTitle')}
              className={!telescopeOnline ? 'cursor-not-allowed' : undefined}
            >
              <button
                onClick={onOpenSync}
                disabled={!telescopeOnline}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                  !telescopeOnline
                    ? isDark
                      ? 'border-slate-800 text-slate-600 cursor-not-allowed'
                      : 'border-slate-200 text-slate-300 cursor-not-allowed'
                    : isDark
                      ? 'border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                      : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Download className="w-3.5 h-3.5" />
                {t('observationDetail.subframesPanel.syncSubs')}
              </button>
            </span>
          )}
          {hasSubFrames && (
            <button
              onClick={onDownloadToComputer}
              disabled={archiveState !== 'idle'}
              title={
                archiveState === 'error'
                  ? t('observationDetail.subframesPanel.retryTitle')
                  : t('observationDetail.subframesPanel.zipToComputerTitle')
              }
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition disabled:cursor-wait ${
                archiveState === 'error'
                  ? isDark
                    ? 'border-red-500/30 text-red-400'
                    : 'border-red-300 text-red-600'
                  : isDark
                    ? 'border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                    : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              {archiveState === 'idle'
                ? t('observationDetail.subframesPanel.downloadToComputer')
                : archiveState === 'error'
                  ? t('observationDetail.subframesPanel.downloadFailed')
                  : t('observationDetail.subframesPanel.zipping', { done: archiveState.done, total: archiveState.total })}
            </button>
          )}
          {isAdmin && hasSubFrames && (
            <button
              onClick={onDeleteAllSubframes}
              title={t('observationDetail.subframesPanel.deleteAllTitle')}
              className={`p-1.5 rounded-lg transition ${isDark ? 'text-slate-600 hover:text-red-400 hover:bg-red-500/10' : 'text-slate-400 hover:text-red-500 hover:bg-red-50'}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {subFrames.length > 0 ? (
        <div className="p-3">
          <NightFrameList
            objectId={objectId}
            objectName={objectName}
            date={date}
            isAdmin={isAdmin}
            onFramesDeleted={onFramesDeleted}
          />
        </div>
      ) : (
        <div className={`p-8 text-center ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
          {t('observationDetail.subframesPanel.empty')}
        </div>
      )}
    </div>
  );
}
