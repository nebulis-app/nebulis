import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, ChevronRight, ExternalLink, FolderOpen, HelpCircle, Loader2, LogOut } from 'lucide-react';

import {
  cancelGdriveSignIn,
  disconnectGdrive,
  getGdriveSignInStatus,
  prepareGdriveBackupFolder,
  startGdriveSignIn,
  type GdriveBackupConfig,
  type GdriveFolder,
} from '../../lib/api/gdriveBackup';
import { ApiRequestError } from '../../lib/api/client';
import { getInputClass } from './SettingsUI';

/** Direct links into Google Cloud Console, one per setup step. */
const GCP_LINKS = {
  project: 'https://console.cloud.google.com/projectcreate',
  driveApi: 'https://console.cloud.google.com/apis/library/drive.googleapis.com',
  branding: 'https://console.cloud.google.com/auth/overview',
  audience: 'https://console.cloud.google.com/auth/audience',
  clients: 'https://console.cloud.google.com/auth/clients/create',
} as const;
const GUIDE_STEPS = ['project', 'driveApi', 'branding', 'audience', 'clients'] as const;

/**
 * The Google Drive connection, on the Google Drive backup page, in two stages.
 *
 * 1. **Sign in.** Google's device-code flow: the user pastes the OAuth client they
 *    created in Google Cloud (a step-by-step guide sits right here, because that is
 *    where newcomers get stuck), Nebulis shows a short code, and the user enters it
 *    at google.com/device.
 * 2. **The folder.** No picker: with the `drive.file` scope Nebulis could only list
 *    the folders it made, so it uses a `Nebulis` folder at the top of My Drive (made
 *    when missing) and the user moves or renames it in Drive as they like. It is kept
 *    by id, so it is found again wherever it goes.
 *
 * Creating that empty folder is the only thing written to Drive here. The folder is
 * handed back through `onFolderReady`; saving it and adopting it are the section's.
 */
export function GdriveConnectionPanel({
  isDark,
  config,
  onFolderReady,
  onError,
}: {
  isDark: boolean;
  config: GdriveBackupConfig;
  onFolderReady: (folder: GdriveFolder | null) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState(config.clientId);
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [guideOpen, setGuideOpen] = useState(config.clientId === '');

  const { data: status, refetch } = useQuery({
    queryKey: ['gdrive-backup-sign-in'],
    queryFn: getGdriveSignInStatus,
    // Poll only while the user is entering the code.
    refetchInterval: query => (query.state.data?.state === 'pending' ? 2000 : false),
  });
  const connected = status?.state === 'connected';

  // Right after sign-in, the backup folder: the one saved before, else a Nebulis folder
  // at the top of My Drive (made when missing). A query rather than a mutation so it runs
  // once per sign-in and can be retried; it is idempotent on the server.
  const {
    data: prepared,
    error: folderError,
    isFetching: folderLoading,
    refetch: retryFolder,
  } = useQuery({
    queryKey: ['gdrive-backup-folder', status?.account ?? ''],
    queryFn: prepareGdriveBackupFolder,
    enabled: connected,
    // A Drive error is nearly always a setup problem (the API is off): show it, don't hammer Google.
    retry: false,
    refetchOnWindowFocus: false,
  });
  const folder = connected ? prepared?.folder : undefined;

  useEffect(() => {
    // The backup's status carries `connected` too; refresh it once the sign-in lands.
    if (connected) void queryClient.invalidateQueries({ queryKey: ['gdrive-backup'] });
  }, [connected, queryClient]);

  useEffect(() => {
    onFolderReady(folder ?? null);
  }, [folder, onFolderReady]);

  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';
  const border = isDark ? 'border-slate-800' : 'border-slate-200';
  const labelClass = `mb-1.5 block text-[0.8125rem] font-medium ${body}`;
  const btnBase =
    'px-3.5 py-2 rounded-lg text-[0.8125rem] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnSubtle = isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200';
  const linkClass = 'inline-flex items-center gap-1 font-medium text-accent-500 hover:underline';

  async function act(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    onError('');
    try {
      await action();
      return true;
    } catch (err) {
      onError(err instanceof Error ? err.message : t('archiveGdrive.failed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const connect = () =>
    act(async () => {
      await startGdriveSignIn({ clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) });
      await refetch();
    });

  const canConnect = clientId.trim() !== '' && (clientSecret.trim() !== '' || config.hasClientSecret);

  // ─── Stage 2: signed in, the backup folder ────────────────────────────────
  if (connected) {
    return (
      <div className="space-y-4">
        <div className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${border}`}>
          <div className="flex min-w-0 items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
            <span className={`truncate text-sm ${body}`}>
              {status?.account ? t('archiveGdrive.signedInAs', { account: status.account }) : t('archiveGdrive.signedIn')}
            </span>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => act(async () => { await disconnectGdrive(); await refetch(); await queryClient.invalidateQueries({ queryKey: ['gdrive-backup'] }); })}
            className={`${btnBase} ${btnSubtle} inline-flex items-center gap-1.5`}
          >
            <LogOut className="h-3.5 w-3.5" /> {t('archiveGdrive.disconnect')}
          </button>
        </div>

        <div className={`rounded-xl border p-3 ${border}`}>
          <div className={`mb-1.5 text-[0.8125rem] font-medium ${body}`}>{t('archiveGdrive.folderTitle')}</div>
          {folderError && !folderLoading ? (
            <div className="space-y-2 text-xs text-red-500">
              <p className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{folderError instanceof Error ? folderError.message : t('archiveGdrive.failed')}</span>
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {folderError instanceof ApiRequestError && folderError.code === 'GDRIVE_API_DISABLED' && (
                  <a href={GCP_LINKS.driveApi} target="_blank" rel="noreferrer" className={linkClass}>
                    {t('archiveGdrive.guide.driveApi.link')} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                <button type="button" onClick={() => void retryFolder()} className={`${btnBase} ${btnSubtle}`}>
                  {t('archiveGdrive.retry')}
                </button>
              </div>
            </div>
          ) : !folder ? (
            <p className={`flex items-center gap-2 text-xs ${subText}`}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('archiveGdrive.preparingFolder')}
            </p>
          ) : (
            <>
              <p className={`flex items-center gap-2 text-sm ${body}`}>
                <FolderOpen className="h-4 w-4 shrink-0 text-accent-500" />
                <span className="truncate">{prepared?.created ? t('archiveGdrive.folderCreated', { name: folder.name }) : t('archiveGdrive.folderFound', { name: folder.name })}</span>
              </p>
              <p className={`mt-2 text-[0.75rem] leading-relaxed ${subText}`}>{t('archiveGdrive.folderMoveHint')}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  // ─── Waiting for the code to be entered ───────────────────────────────────
  if (status?.state === 'pending') {
    return (
      <div className={`space-y-3 rounded-xl border p-4 text-center ${border}`}>
        <p className={`text-xs ${body}`}>{t('archiveGdrive.enterCode')}</p>
        <p className={`font-mono text-2xl font-semibold tracking-widest ${isDark ? 'text-white' : 'text-slate-800'}`}>{status.userCode}</p>
        <a href={status.verificationUrl} target="_blank" rel="noreferrer" className={`${linkClass} text-sm`}>
          {status.verificationUrl} <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <p className={`text-xs leading-relaxed ${subText}`}>{t('archiveGdrive.unverifiedHint')}</p>
        <p className={`inline-flex w-full items-center justify-center gap-1.5 text-xs ${subText}`}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('archiveGdrive.waiting')}
        </p>
        <button type="button" disabled={busy} onClick={() => act(async () => { await cancelGdriveSignIn(); await refetch(); })} className={`${btnBase} ${btnSubtle}`}>
          {t('archiveGdrive.cancel')}
        </button>
      </div>
    );
  }

  // ─── Stage 1: sign in ─────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <p className={`text-xs leading-relaxed ${subText}`}>{t('archiveGdrive.intro')}</p>

      <div className={`rounded-xl border ${border}`}>
        <button
          type="button"
          onClick={() => setGuideOpen(open => !open)}
          aria-expanded={guideOpen}
          className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-[0.8125rem] font-medium ${body}`}
        >
          <HelpCircle className="h-4 w-4 shrink-0 text-accent-500" />
          <span className="flex-1">{t('archiveGdrive.guide.title')}</span>
          <ChevronRight className={`h-3.5 w-3.5 opacity-50 transition-transform ${guideOpen ? 'rotate-90' : ''}`} />
        </button>
        {guideOpen && (
          <div className={`space-y-3 border-t px-3 py-3 ${border}`}>
            <p className={`text-[0.75rem] leading-relaxed ${subText}`}>{t('archiveGdrive.guide.why')}</p>
            <ol className="space-y-3">
              {GUIDE_STEPS.map((step, i) => (
                <li key={step} className="flex gap-2.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-500/15 text-[0.6875rem] font-semibold text-accent-500">
                    {i + 1}
                  </span>
                  <div className="min-w-0 space-y-1">
                    <div className={`text-[0.8125rem] font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                      {t(`archiveGdrive.guide.${step}.title`)}
                    </div>
                    <p className={`text-[0.75rem] leading-relaxed ${subText}`}>
                      <Trans t={t} i18nKey={`archiveGdrive.guide.${step}.body`} components={{ b: <strong className={body} /> }} />
                    </p>
                    <a href={GCP_LINKS[step]} target="_blank" rel="noreferrer" className={`${linkClass} text-[0.75rem]`}>
                      {t(`archiveGdrive.guide.${step}.link`)} <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </li>
              ))}
            </ol>
            <p className={`text-[0.75rem] leading-relaxed ${subText}`}>{t('archiveGdrive.guide.free')}</p>
          </div>
        )}
      </div>

      <div>
        <label className={labelClass} htmlFor="gdrive-client-id">
          {t('archiveGdrive.clientId')}
        </label>
        <input
          id="gdrive-client-id"
          value={clientId}
          onChange={e => setClientId(e.target.value)}
          placeholder={t('archiveGdrive.clientIdPlaceholder')}
          spellCheck={false}
          className={getInputClass(isDark)}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="gdrive-client-secret">
          {t('archiveGdrive.clientSecret')}
        </label>
        <input
          id="gdrive-client-secret"
          type="password"
          value={clientSecret}
          onChange={e => setClientSecret(e.target.value)}
          placeholder={config.hasClientSecret ? t('archiveGdrive.secretStored') : ''}
          spellCheck={false}
          autoComplete="off"
          className={getInputClass(isDark)}
        />
      </div>
      {(status?.state === 'denied' || status?.state === 'expired' || status?.state === 'error') && status.error && (
        <p className="text-xs text-red-500">{status.error}</p>
      )}
      <button type="button" disabled={busy || !canConnect} onClick={connect} className={`${btnBase} ${btnSubtle} inline-flex items-center gap-1.5`}>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {t('archiveGdrive.connect')}
      </button>
    </div>
  );
}
