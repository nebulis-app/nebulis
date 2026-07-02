import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, X } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { getUpdateStatus, applyUpdate } from '../lib/api/update';
import { ChangelogModal } from './ChangelogModal';

/**
 * App-wide "update available" banner. Mounted once at the shell level. Renders
 * nothing unless the server reports a desktop update is available. A non-
 * mandatory banner can be dismissed for the session; a mandatory one cannot.
 */
export function UpdateBanner() {
  const { theme } = useTheme();
  const isDark = theme !== 'light';
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['update-status'],
    queryFn: getUpdateStatus,
    refetchInterval: 60_000,
  });

  const apply = useMutation({
    mutationFn: applyUpdate,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['update-status'] }),
  });

  const status = statusQuery.data;
  if (!status || status.platform === null || !status.updateAvailable) return null;
  if (dismissed && !status.mandatory) return null;

  // Windows must finish staging before Install is meaningful.
  const canInstall = status.platform !== 'win-x64' || status.staged;

  return (
    <>
    <div
      role="status"
      className={`flex items-center gap-3 px-4 py-2 text-sm border-b ${
        isDark ? 'bg-accent-500/15 border-accent-500/30 text-slate-100' : 'bg-accent-50 border-accent-200 text-slate-800'
      }`}
    >
      <Download className={`w-4 h-4 flex-shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
      <span className="flex-1 min-w-0 truncate">
        Nebulis {status.latestVersion}{status.latestBuild ? ` (build ${status.latestBuild})` : ''} is available{status.mandatory ? ' (required)' : ''}.
        {status.platform === 'win-x64' && status.staged && ' Downloaded and verified. Installing restarts the Nebulis service briefly.'}
        {status.platform === 'win-x64' && !status.staged && (
          status.lastError ? ` Download failed: ${status.lastError}` : ' Downloading…'
        )}
      </span>
      <button
        type="button"
        onClick={() => setWhatsNewOpen(true)}
        className={`hidden sm:inline text-xs ${isDark ? 'text-accent-300' : 'text-accent-700'} hover:underline`}
      >
        What's new
      </button>
      <button
        type="button"
        onClick={() => apply.mutate()}
        disabled={!canInstall || apply.isPending || apply.isSuccess}
        className={`flex-shrink-0 px-3 py-1 rounded-md text-[13px] font-semibold transition-colors ${
          isDark ? 'bg-accent-500 text-slate-950 hover:bg-accent-400' : 'bg-accent-600 text-white hover:bg-accent-500'
        } disabled:opacity-50`}
      >
        {apply.isSuccess ? 'Installing…' : apply.isPending ? 'Starting…' : 'Install'}
      </button>
      {!status.mandatory && (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className={`flex-shrink-0 p-1 rounded ${isDark ? 'hover:bg-slate-700/50' : 'hover:bg-slate-200'}`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
    <ChangelogModal
      isOpen={whatsNewOpen}
      onClose={() => setWhatsNewOpen(false)}
      onlyVersion={status?.latestVersion ?? undefined}
    />
    </>
  );
}
