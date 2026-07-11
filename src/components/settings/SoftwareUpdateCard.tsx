import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Download, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { Settings as SettingsType } from '../../types';
import { getUpdateStatus, checkForUpdate, applyUpdate } from '../../lib/api/update';
import { Sec, Row, Seg, ToggleRow, getCardClass } from './SettingsUI';
import { ChangelogModal } from '../ChangelogModal';

/**
 * Software Updates settings card. Self-contained: it owns the /meta/update
 * query and the check / install mutations. The channel selector writes through
 * the parent form so it saves with the rest of Settings.
 *
 * On non-desktop builds (web, Docker) the server reports platform=null and we
 * show an explanatory note instead of update controls.
 */
export function SoftwareUpdateCard({
  isDark,
  form,
  setForm,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
}) {
  const queryClient = useQueryClient();
  const channel = form.updateChannel ?? 'stable';
  const [changelogMode, setChangelogMode] = useState<'history' | 'whats-new' | null>(null);

  const statusQuery = useQuery({
    queryKey: ['update-status'],
    queryFn: getUpdateStatus,
    refetchInterval: 60_000,
  });

  const check = useMutation({
    mutationFn: checkForUpdate,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['update-status'] }),
  });

  const apply = useMutation({
    mutationFn: applyUpdate,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['update-status'] }),
  });

  const status = statusQuery.data;
  const isDesktop = status ? status.platform !== null : false;

  // Run one check when this panel is opened on a desktop build. This is a
  // foreground, user-initiated check (the user navigated here), not background
  // polling, so it respects the auto-update-off default while making the
  // panel always reflect current status. It also gives the Windows tray's
  // "Check for Updates" (which opens this page) a working check.
  const didAutoCheck = useRef(false);
  useEffect(() => {
    if (isDesktop && !didAutoCheck.current) {
      didAutoCheck.current = true;
      check.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop]);
  const muted = isDark ? 'text-slate-500' : 'text-slate-400';
  const strong = isDark ? 'text-slate-200' : 'text-slate-700';

  return (
    <Sec
      title="Software Updates"
      description="Keep Nebulis up to date. Updates are signed and verified before they install."
      isDark={isDark}
    >
      <div className={`${getCardClass(isDark)} space-y-3`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className={`text-sm font-medium ${strong}`}>Current version</div>
            {status ? (
              <>
                <div className={`text-xs mt-0.5 ${muted}`}>
                  Nebulis {status.currentVersion}{status.currentBuild ? ` (${status.currentBuild})` : ''}
                </div>
                <button
                  type="button"
                  onClick={() => setChangelogMode('history')}
                  className={`text-xs mt-1 ${isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-600 hover:text-accent-500'} hover:underline`}
                >
                  Release notes
                </button>
              </>
            ) : (
              <div className={`text-xs mt-0.5 ${muted}`}>Loading…</div>
            )}
          </div>
          {isDesktop && (
            <button
              type="button"
              onClick={() => check.mutate()}
              disabled={check.isPending}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] font-medium border transition-colors ${
                isDark
                  ? 'border-slate-700 text-slate-200 hover:bg-slate-800'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-50'
              } disabled:opacity-50`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${check.isPending ? 'animate-spin' : ''}`} />
              {check.isPending ? 'Checking…' : 'Check for updates'}
            </button>
          )}
        </div>

        {!isDesktop && status && (
          <p className={`text-xs leading-relaxed ${muted}`}>
            This build updates through its host. Docker installs update with a new image pull;
            browser and app-store installs update through their platform.
          </p>
        )}

        {isDesktop && status?.updateAvailable && (
          <div
            className={`flex items-start gap-3 p-3 rounded-lg ${
              isDark ? 'bg-accent-500/10 border border-accent-500/30' : 'bg-accent-50 border border-accent-200'
            }`}
          >
            <Download className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-medium ${strong}`}>
                Version {status.latestVersion}{status.latestBuild ? ` (build ${status.latestBuild})` : ''} is available
                {status.mandatory && ' (required)'}
              </div>
              <div className={`text-xs mt-0.5 ${muted}`}>
                {status.platform === 'win-x64'
                  ? status.staged
                    ? 'Downloaded and verified. Installing restarts the Nebulis service briefly.'
                    : 'Downloading in the background. Install becomes available once it is ready.'
                  : 'Installing restarts Nebulis to finish the update.'}
              </div>
              <button
                type="button"
                onClick={() => setChangelogMode('whats-new')}
                className={`text-xs mt-1 inline-block ${isDark ? 'text-accent-400' : 'text-accent-600'} hover:underline`}
              >
                What's new
              </button>
            </div>
            <button
              type="button"
              onClick={() => apply.mutate()}
              disabled={apply.isPending || apply.isSuccess || (status.platform === 'win-x64' && !status.staged)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-colors ${
                isDark ? 'bg-accent-500 text-slate-950 hover:bg-accent-400' : 'bg-accent-600 text-white hover:bg-accent-500'
              } disabled:opacity-50`}
            >
              {apply.isSuccess ? 'Installing…' : apply.isPending ? 'Starting…' : 'Install now'}
            </button>
          </div>
        )}

        {/* Up to date: only when a check has happened, found nothing, and the
            last check didn't error. Without this the button looked like it "did
            nothing" when actually it just found no newer version. */}
        {isDesktop && status && !status.updateAvailable && status.lastCheckedAt && !status.lastError && (
          <div className={`flex items-center gap-2 text-xs ${muted}`}>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            You're on the latest {channel} version
            {status.latestVersion
              ? ` (${status.latestVersion}${status.latestBuild ? `, build ${status.latestBuild}` : ''}).`
              : '.'}
          </div>
        )}

        {/* The check ran but the server couldn't complete it (bad signature,
            network, no build for this platform). Surfacing this means the
            button never silently does nothing. */}
        {isDesktop && status?.lastError && !status.updateAvailable && (
          <div className="flex items-start gap-2 text-xs text-amber-500">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>Last check could not complete: {status.lastError}</span>
          </div>
        )}

        {check.isError && (
          <div className="flex items-center gap-2 text-xs text-red-500">
            <AlertTriangle className="w-3.5 h-3.5" />
            {check.error instanceof Error ? check.error.message : 'Could not check for updates.'}
          </div>
        )}

        {apply.isError && (
          <div className="flex items-center gap-2 text-xs text-red-500">
            <AlertTriangle className="w-3.5 h-3.5" />
            {apply.error instanceof Error ? apply.error.message : 'Could not start the update.'}
          </div>
        )}
      </div>

      {isDesktop && (
        <>
          <ToggleRow
            label="Check for updates automatically"
            description="When enabled, updates download in the background for faster installation."
            checked={form.autoUpdateEnabled ?? false}
            onChange={v => setForm(f => ({ ...f, autoUpdateEnabled: v }))}
            isDark={isDark}
          />
          <Row
            label="Update channel"
            description="Stable is recommended. Beta gets new features earlier, with more risk."
            isDark={isDark}
          >
            <Seg
              value={channel}
              options={[
                { id: 'stable', label: 'Stable' },
                { id: 'beta', label: 'Beta' },
              ]}
              onChange={(id) => setForm(f => ({ ...f, updateChannel: id }))}
              isDark={isDark}
            />
          </Row>
        </>
      )}

      <ChangelogModal
        isOpen={changelogMode !== null}
        onClose={() => setChangelogMode(null)}
        onlyVersion={changelogMode === 'whats-new' ? (status?.latestVersion ?? status?.currentVersion) : undefined}
      />
    </Sec>
  );
}
