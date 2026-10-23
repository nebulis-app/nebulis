import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RotateCw, AlertCircle, Bug, Download } from 'lucide-react';
import {
  getDebugLoggingStatus,
  enableDebugLogging,
  disableDebugLogging,
  downloadDebugLog,
} from '../../lib/api/settings';
import { Sec, Row } from './SettingsUI';

export function DebugLoggingSection({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const { data: status } = useQuery({
    queryKey: ['debug-logging-status'],
    queryFn: getDebugLoggingStatus,
    refetchInterval: (query) => (query.state.data?.enabled ? 5_000 : 30_000),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['debug-logging-status'] });

  const enableMutation = useMutation({ mutationFn: enableDebugLogging, onSuccess: invalidate });
  const disableMutation = useMutation({ mutationFn: disableDebugLogging, onSuccess: invalidate });

  const isEnabled = status?.enabled ?? false;
  const hasLog = status?.hasLog ?? false;
  const minutesRemaining = status?.minutesRemaining ?? 0;
  const isPending = enableMutation.isPending || disableMutation.isPending;

  const handleToggle = () => {
    setDownloadError(null);
    if (isEnabled) disableMutation.mutate();
    else enableMutation.mutate();
  };

  const handleDownload = async () => {
    setDownloadError(null);
    setDownloading(true);
    try {
      await downloadDebugLog();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : t('dangerSection.debugLogging.downloadFailed'));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Sec
      title={t('dangerSection.debugLogging.title')}
      description={t('dangerSection.debugLogging.description')}
      isDark={isDark}
    >
      <Row
        label={t('dangerSection.debugLogging.toggleLabel')}
        description={
          isEnabled
            ? t('dangerSection.debugLogging.activeDescription', { minutes: minutesRemaining })
            : t('dangerSection.debugLogging.offDescription')
        }
        isDark={isDark}
      >
        <div className="flex items-center gap-3">
          {isEnabled && (
            <span className={`flex items-center gap-1.5 text-xs font-medium ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
              <Bug className="w-3.5 h-3.5" />
              {t('dangerSection.debugLogging.active')}
            </span>
          )}
          <button
            onClick={handleToggle}
            disabled={isPending}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm ${
              isEnabled
                ? isDark
                  ? 'bg-slate-700 text-slate-200 hover:bg-slate-600'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                : isDark
                  ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 shadow-amber-500/10'
                  : 'bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200'
            }`}
          >
            {isPending && <RotateCw className="w-4 h-4 animate-spin" />}
            {isEnabled ? t('dangerSection.debugLogging.turnOff') : t('dangerSection.debugLogging.turnOn')}
          </button>
        </div>
      </Row>

      <Row
        label={t('dangerSection.debugLogging.downloadLabel')}
        description={t('dangerSection.debugLogging.downloadDescription')}
        isDark={isDark}
      >
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={handleDownload}
            disabled={!hasLog || downloading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed bg-slate-600 text-white hover:bg-slate-500 shadow-sm"
          >
            {downloading ? <RotateCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {t('dangerSection.debugLogging.downloadButton')}
          </button>
          {downloadError && (
            <p className="flex items-center gap-1.5 text-xs text-red-500">
              <AlertCircle className="w-3.5 h-3.5" />
              {downloadError}
            </p>
          )}
        </div>
      </Row>
    </Sec>
  );
}
