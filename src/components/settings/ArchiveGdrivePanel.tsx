import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ExternalLink, Loader2, LogOut } from 'lucide-react';

import {
  cancelGdriveSignIn,
  disconnectGdrive,
  getGdriveSignInStatus,
  startGdriveSignIn,
  type ArchiveConfig,
} from '../../lib/api/storage';
import { getInputClass } from './SettingsUI';

/**
 * The Google Drive tab of the destination picker.
 *
 * Signing in uses Google's device-code flow: the user pastes the OAuth client they
 * created in Google Cloud, Nebulis shows a short code, and the user enters it at
 * google.com/device on any device. Nothing is written to Drive here. Like the other
 * tabs, this only hands back a choice; adopting the folder is the separate,
 * explicit step in the settings section.
 */
export function ArchiveGdrivePanel({
  isDark,
  config,
  folderName,
  onFolderNameChange,
  onConnectedChange,
  onError,
}: {
  isDark: boolean;
  config: ArchiveConfig;
  folderName: string;
  onFolderNameChange: (name: string) => void;
  onConnectedChange: (connected: boolean) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState(config.gdrive.clientId);
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: status, refetch } = useQuery({
    queryKey: ['archive-gdrive-status'],
    queryFn: getGdriveSignInStatus,
    // Poll only while the user is entering the code.
    refetchInterval: query => (query.state.data?.state === 'pending' ? 2000 : false),
  });

  const connected = status?.state === 'connected';
  useEffect(() => {
    onConnectedChange(connected);
    // The archive status carries `gdrive.connected` too; refresh it once the sign-in lands.
    if (connected) void queryClient.invalidateQueries({ queryKey: ['archive-status'] });
  }, [connected, onConnectedChange, queryClient]);

  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';
  const labelClass = `mb-1.5 block text-[0.8125rem] font-medium ${body}`;
  const btnBase =
    'px-3.5 py-2 rounded-lg text-[0.8125rem] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnSubtle = isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200';

  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    onError('');
    try {
      await action();
      await refetch();
    } catch (err) {
      onError(err instanceof Error ? err.message : t('archiveGdrive.failed'));
    } finally {
      setBusy(false);
    }
  }

  const connect = () =>
    act(() =>
      startGdriveSignIn({
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        folderName: folderName.trim(),
      }),
    );

  const canConnect = clientId.trim() !== '' && (clientSecret.trim() !== '' || config.gdrive.hasClientSecret) && folderName.trim() !== '';

  return (
    <div className="space-y-4">
      <p className={`text-xs leading-relaxed ${subText}`}>{t('archiveGdrive.intro')}</p>

      <div>
        <label className={labelClass} htmlFor="archive-gdrive-folder">
          {t('archiveGdrive.folder')}
        </label>
        <input
          id="archive-gdrive-folder"
          value={folderName}
          onChange={e => onFolderNameChange(e.target.value)}
          placeholder="Nebulis"
          spellCheck={false}
          className={getInputClass(isDark)}
        />
        <p className={`mt-1 text-[0.75rem] ${subText}`}>{t('archiveGdrive.folderHint')}</p>
      </div>

      {connected ? (
        <div className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className="flex min-w-0 items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
            <span className={`truncate text-sm ${body}`}>
              {status?.account ? t('archiveGdrive.signedInAs', { account: status.account }) : t('archiveGdrive.signedIn')}
            </span>
          </div>
          <button type="button" disabled={busy} onClick={() => act(disconnectGdrive)} className={`${btnBase} ${btnSubtle} inline-flex items-center gap-1.5`}>
            <LogOut className="h-3.5 w-3.5" /> {t('archiveGdrive.disconnect')}
          </button>
        </div>
      ) : status?.state === 'pending' ? (
        <div className={`space-y-3 rounded-xl border p-4 text-center ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <p className={`text-xs ${body}`}>{t('archiveGdrive.enterCode')}</p>
          <p className={`font-mono text-2xl font-semibold tracking-widest ${isDark ? 'text-white' : 'text-slate-800'}`}>{status.userCode}</p>
          <a
            href={status.verificationUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-accent-500 hover:underline"
          >
            {status.verificationUrl} <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <p className={`inline-flex items-center justify-center gap-1.5 text-xs ${subText} w-full`}>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('archiveGdrive.waiting')}
          </p>
          <button type="button" disabled={busy} onClick={() => act(cancelGdriveSignIn)} className={`${btnBase} ${btnSubtle}`}>
            {t('archiveGdrive.cancel')}
          </button>
        </div>
      ) : (
        <>
          <div>
            <label className={labelClass} htmlFor="archive-gdrive-client-id">
              {t('archiveGdrive.clientId')}
            </label>
            <input
              id="archive-gdrive-client-id"
              value={clientId}
              onChange={e => setClientId(e.target.value)}
              placeholder={t('archiveGdrive.clientIdPlaceholder')}
              spellCheck={false}
              className={getInputClass(isDark)}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="archive-gdrive-client-secret">
              {t('archiveGdrive.clientSecret')}
            </label>
            <input
              id="archive-gdrive-client-secret"
              type="password"
              value={clientSecret}
              onChange={e => setClientSecret(e.target.value)}
              placeholder={config.gdrive.hasClientSecret ? t('archiveGdrive.secretStored') : ''}
              spellCheck={false}
              autoComplete="off"
              className={getInputClass(isDark)}
            />
            <p className={`mt-1 text-[0.75rem] leading-relaxed ${subText}`}>{t('archiveGdrive.clientHint')}</p>
          </div>
          {(status?.state === 'denied' || status?.state === 'expired' || status?.state === 'error') && status.error && (
            <p className="text-xs text-red-500">{status.error}</p>
          )}
          <button type="button" disabled={busy || !canConnect} onClick={connect} className={`${btnBase} ${btnSubtle} inline-flex items-center gap-1.5`}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('archiveGdrive.connect')}
          </button>
        </>
      )}

      <p className={`text-[0.75rem] leading-relaxed ${subText}`}>{t('archiveGdrive.limits')}</p>
    </div>
  );
}
