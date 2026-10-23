import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowUp,
  ChevronRight,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Server,
} from 'lucide-react';

import {
  browseArchiveDestination,
  browseDirectory,
  listVolumes,
  testArchiveDestination,
  type ArchiveConfig,
  type ArchiveNetworkPatch,
  type DirectoryEntry,
  type VolumeInfo,
} from '../../lib/api/storage';
import { formatBytes } from '../../lib/utils';
import { getInputClass } from './SettingsUI';
import { looksLikeShareAddress, parseShareAddress } from '../../lib/uncInput';
import { Modal } from '../ui/Modal';

/** What the picker hands back. `createFolder` is true when the folder the user chose
 *  does not exist yet, which is the only case where adopting creates one. */
export type DestinationChoice =
  | { kind: 'local'; path: string; createFolder: boolean }
  | { kind: 'network'; network: ArchiveNetworkPatch; createFolder: boolean };

/**
 * Choosing where the archive lives.
 *
 * Two tabs, because the two answers are different kinds of thing: a folder on a disk
 * the operating system has already mounted, or a share Nebulis connects to itself
 * with credentials it stores. The drive tab lists volumes and walks folders; the
 * network tab fills in a share, tests it, and then walks its folders once it is
 * connected.
 *
 * The picker writes nothing to any disk. It returns a choice, the caller saves it, and
 * adopting is still a separate press in the settings section: that is the distinction
 * the server enforces, and the UI has to keep it rather than collapse it into one
 * button that both saves and claims a disk.
 */
export function ArchiveDestinationModal({
  isDark,
  config,
  networkSupported,
  onChoose,
  onClose,
}: {
  isDark: boolean;
  config: ArchiveConfig;
  networkSupported: boolean;
  onChoose: (choice: DestinationChoice) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const startOnNetwork = config.locationType === 'network' && networkSupported;

  const [tab, setTab] = useState<'drive' | 'network'>(startOnNetwork ? 'network' : 'drive');
  const [volume, setVolume] = useState<VolumeInfo | null>(null);
  const [browsePath, setBrowsePath] = useState<string>('');
  const [newFolderName, setNewFolderName] = useState('');
  const [network, setNetwork] = useState<ArchiveNetworkPatch & { host: string; share: string; domain: string; username: string; subpath: string }>({
    host: config.network.host,
    share: config.network.share,
    domain: config.network.domain,
    username: config.network.username,
    // Not defaulted. An empty subpath means the whole share, which is a deliberate
    // choice the contract allows, and defaulting it here would silently move a
    // destination that already means that. The suggestion lives in the placeholder.
    subpath: config.network.subpath,
    password: '',
  });
  const [passwordStored, setPasswordStored] = useState(config.network.hasPassword);
  /** Set by the explicit control, and sent as `clearPassword` so a stored credential
   *  can be removed and a test can say it means no password. */
  const [clearPassword, setClearPassword] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; reason: string | null } | null>(null);
  /** The folder inside the share the user has selected, once the share is connected.
   *  The listing starts at the share root when this is null. */
  const [sharePath, setSharePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { data: volumesData, isLoading: volumesLoading, refetch: refetchVolumes } = useQuery({
    queryKey: ['storage-volumes'],
    queryFn: listVolumes,
    enabled: tab === 'drive',
  });

  const { data: browseData } = useQuery({
    queryKey: ['storage-browse', browsePath],
    queryFn: () => browseDirectory(browsePath),
    enabled: tab === 'drive' && browsePath !== '',
  });

  /** Only fetched once the share has been tested: browsing a share that is not
   *  connected would just fail, and the test is what connects it.
   *
   *  The network it sends is the one on screen, not the saved one: on a first visit
   *  nothing is saved yet, so the saved destination would be a local folder and the
   *  browse would be refused. */
  const { data: shareData, isFetching: shareBrowsing } = useQuery({
    queryKey: ['archive-share-browse', network.host, network.share, network.username, network.subpath, sharePath ?? ''],
    queryFn: () =>
      browseArchiveDestination({
        network: {
          host: network.host,
          share: network.share,
          domain: network.domain,
          username: network.username,
          subpath: network.subpath,
          password: network.password ?? '',
          clearPassword,
        },
        path: sharePath ?? undefined,
      }),
    enabled: tab === 'network' && testResult?.ok === true,
  });

  const heading = isDark ? 'text-white' : 'text-slate-800';
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const sub = isDark ? 'text-slate-500' : 'text-slate-400';
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';
  const btnBase =
    'px-3.5 py-2 rounded-lg text-[0.8125rem] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const btnPrimary = 'bg-accent-500 text-white hover:bg-accent-600';
  const btnSubtle = isDark
    ? 'bg-slate-800 text-slate-200 hover:bg-slate-700'
    : 'bg-slate-100 text-slate-700 hover:bg-slate-200';

  // ─── Drive tab ────────────────────────────────────────────────────────────
  const trimmedFolderName = newFolderName.trim();
  const folderNameInvalid = /[\\/]/.test(trimmedFolderName) || trimmedFolderName === '.' || trimmedFolderName === '..';
  const folderNameExists = trimmedFolderName !== ''
    && (browseData?.directories ?? []).some(d => d.name.toLowerCase() === trimmedFolderName.toLowerCase());
  const localTarget = browsePath === ''
    ? ''
    : trimmedFolderName === '' || folderNameInvalid
      ? browsePath
      : joinLocal(browsePath, trimmedFolderName);
  const localCreatesFolder = trimmedFolderName !== '' && !folderNameInvalid && !folderNameExists;

  const canGoUp = browsePath !== '' && volume !== null && browsePath !== volume.path;

  function pickVolume(v: VolumeInfo): void {
    setVolume(v);
    setBrowsePath(v.path);
    setNewFolderName('');
    setError('');
  }

  function goUp(): void {
    if (!canGoUp) return;
    const parent = browsePath.replace(/[\\/][^\\/]+$/, '');
    setBrowsePath(parent === '' ? (volume?.path ?? '') : parent);
  }

  // ─── Network tab ──────────────────────────────────────────────────────────
  /** Editing what the connection is made of invalidates a test: a different server,
   *  share or account is a different connection. */
  /**
   * Fill the share fields from whatever was typed or pasted into Server.
   *
   * A person who knows what a UNC path is pastes `\\192.168.1.12\Nebulis2` into the
   * server field, and refusing that as "characters that cannot be used" is correct about
   * the field and wrong about the address. A value with no separator is a server and is
   * left alone, so typing just an address still works.
   */
  function enterServer(value: string): void {
    if (!looksLikeShareAddress(value)) {
      editNetwork({ host: value });
      return;
    }
    const parsed = parseShareAddress(value);
    if (parsed === null) {
      editNetwork({ host: value });
      return;
    }
    editNetwork({
      host: parsed.host,
      ...(parsed.share === '' ? {} : { share: parsed.share }),
      ...(parsed.subpath === '' ? {} : { subpath: parsed.subpath }),
    });
  }

  function editNetwork(patch: Partial<typeof network>): void {
    setNetwork(current => ({ ...current, ...patch }));
    setTestResult(null);
    setSharePath(null);
  }

  /** Choosing the folder inside the share does not. The connection was tested against
   *  the same server and share, and resetting the test here would disable the save
   *  button the moment the user picked the folder they came for. */
  function editSubpath(subpath: string): void {
    setNetwork(current => ({ ...current, subpath }));
  }

  async function runTest(): Promise<void> {
    setBusy(true);
    setError('');
    // Normalised here as well as on entry: a value pasted and tested without leaving the
    // field would otherwise reach the server unsplit.
    const current = looksLikeShareAddress(network.host) ? parseShareAddress(network.host) : null;
    if (current !== null) enterServer(network.host);
    try {
      const result = await testArchiveDestination({
        host: network.host,
        share: network.share,
        domain: network.domain,
        username: network.username,
        subpath: network.subpath,
        password: network.password ?? '',
        // Told explicitly, because an empty password otherwise means "use the stored
        // one": after clearing, a test has to fail honestly if the share needs one.
        clearPassword,
      });
      setTestResult(result);
      setSharePath(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('archiveDestination.testFailed'));
    } finally {
      setBusy(false);
    }
  }

  const shareRootName = network.host.trim() && network.share.trim()
    ? `\\\\${network.host.trim()}\\${network.share.trim()}`
    : '';
  const shareRoot = shareData?.root ?? '';
  /** The folder currently being listed, relative to the share root. Empty at the top. */
  const relativeHere = shareRoot !== '' && shareData ? relativeTo(shareData.path, shareRoot) : '';
  const canClimbShare = shareRoot !== '' && shareData !== undefined && shareData.path !== shareRoot;

  /** True only for a subpath that names a folder the listing did not show, which is a
   *  folder the user introduced rather than one they picked. Creating one that already
   *  exists would be a no-op, so the flag only has to be honest about intent. */
  const listedRelativePaths = (shareData?.directories ?? []).map(d => relativeTo(d.path, shareRoot));
  const networkCreatesFolder =
    network.subpath.trim() !== '' &&
    testResult?.ok === true &&
    !listedRelativePaths.includes(network.subpath.trim());

  function enterShareFolder(directory: DirectoryEntry): void {
    setSharePath(directory.path);
    editSubpath(relativeTo(directory.path, shareRoot));
  }

  function climbShare(): void {
    if (!canClimbShare || !shareData) return;
    const parent = shareData.path.replace(/[\\/][^\\/]+$/, '');
    const next = parent.length < shareRoot.length ? shareRoot : parent;
    setSharePath(next);
    editSubpath(relativeTo(next, shareRoot));
  }

  function chooseLocal(): void {
    if (localTarget === '') return;
    onChoose({ kind: 'local', path: localTarget, createFolder: localCreatesFolder });
  }

  function chooseNetwork(): void {
    onChoose({
      kind: 'network',
      network: {
        host: network.host.trim(),
        share: network.share.trim(),
        domain: network.domain.trim(),
        username: network.username.trim(),
        subpath: network.subpath.trim(),
        password: network.password ?? '',
        // The flag the clear control sets, and the reason it is state of its own: an
        // empty password on its own means "keep the stored one".
        clearPassword,
      },
      createFolder: networkCreatesFolder,
    });
  }

  const networkReady = network.host.trim() !== '' && network.share.trim() !== '' && testResult?.ok === true;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('archiveDestination.title')}
      className={`w-full max-w-lg rounded-2xl border shadow-xl ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
      }`}
    >
      <div className={`flex items-start justify-between gap-4 border-b px-5 py-4 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <div className="min-w-0">
          <h3 className={`text-base font-semibold ${heading}`}>{t('archiveDestination.title')}</h3>
          <p className={`mt-0.5 text-xs ${subText}`}>{t('archiveDestination.subtitle')}</p>
        </div>
        {networkSupported && (
          <div className={`flex shrink-0 gap-1 rounded-lg p-1 ${isDark ? 'bg-slate-800/60' : 'bg-slate-100'}`}>
            <button
              type="button"
              onClick={() => { setTab('drive'); setError(''); }}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
                tab === 'drive' ? (isDark ? 'bg-slate-700 text-white' : 'bg-white text-slate-800 shadow-sm') : sub
              }`}
            >
              <HardDrive className="h-3.5 w-3.5" /> {t('archiveDestination.driveTab')}
            </button>
            <button
              type="button"
              onClick={() => { setTab('network'); setError(''); }}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
                tab === 'network' ? (isDark ? 'bg-slate-700 text-white' : 'bg-white text-slate-800 shadow-sm') : sub
              }`}
            >
              <Server className="h-3.5 w-3.5" /> {t('archiveDestination.networkTab')}
            </button>
          </div>
        )}
      </div>

      <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
        {tab === 'drive' ? (
          <>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className={`text-xs font-medium uppercase tracking-wide ${subText}`}>
                  {t('archiveDestination.drivesHeading')}
                </span>
                <button
                  type="button"
                  onClick={() => void refetchVolumes()}
                  className={`inline-flex items-center gap-1 text-xs ${sub} hover:opacity-80`}
                >
                  <RefreshCw className="h-3 w-3" /> {t('archiveDestination.refresh')}
                </button>
              </div>
              {volumesLoading ? (
                <p className={`text-sm ${subText}`}>{t('archiveDestination.lookingForDrives')}</p>
              ) : (volumesData?.volumes ?? []).length === 0 ? (
                <p className={`text-sm ${subText}`}>{t('archiveDestination.noDrives')}</p>
              ) : (
                <div className="space-y-1.5">
                  {(volumesData?.volumes ?? []).map(v => (
                    <button
                      type="button"
                      key={v.path}
                      onClick={() => pickVolume(v)}
                      className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
                        volume?.path === v.path
                          ? isDark
                            ? 'border-accent-500/40 bg-accent-500/10'
                            : 'border-accent-300 bg-accent-50'
                          : isDark
                            ? 'border-slate-800 hover:bg-slate-800/50'
                            : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className={`truncate text-sm font-medium ${body}`}>{v.label}</span>
                        <span className={`text-xs tabular-nums ${subText}`}>
                          {t('archiveDestination.freeSpace', { size: formatBytes(v.freeBytes) })}
                        </span>
                      </div>
                      <div className={`mt-0.5 truncate font-mono text-xs ${subText}`}>{v.path}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {volume && (
              <div>
                <span className={`text-xs font-medium uppercase tracking-wide ${subText}`}>
                  {t('archiveDestination.locationHeading')}
                </span>
                <div className="my-2 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!canGoUp}
                    onClick={goUp}
                    title={t('archiveDestination.upOneFolder')}
                    className={`rounded-lg p-1.5 ${canGoUp ? (isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100') : 'opacity-40'}`}
                  >
                    <ArrowUp className={`h-4 w-4 ${body}`} />
                  </button>
                  <span className={`flex-1 truncate font-mono text-xs ${body}`}>{browsePath}</span>
                </div>
                <div className={`max-h-36 overflow-y-auto rounded-xl ${isDark ? 'bg-slate-800/40' : 'bg-slate-50'}`}>
                  {(browseData?.directories ?? []).map((d: DirectoryEntry) => (
                    <button
                      type="button"
                      key={d.path}
                      onClick={() => { setBrowsePath(d.path); setNewFolderName(''); }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${body} ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
                    >
                      <FolderOpen className="h-4 w-4 shrink-0 text-accent-500" />
                      <span className="flex-1 truncate">{d.name}</span>
                      <ChevronRight className="h-3.5 w-3.5 opacity-40" />
                    </button>
                  ))}
                  {(browseData?.directories ?? []).length === 0 && (
                    <div className={`px-3 py-2.5 text-xs ${subText}`}>{t('archiveDestination.noSubfolders')}</div>
                  )}
                </div>

                <label className={`mt-3 block text-xs font-medium uppercase tracking-wide ${subText}`} htmlFor="archive-new-folder">
                  {t('archiveDestination.newFolder')}
                </label>
                <input
                  id="archive-new-folder"
                  value={newFolderName}
                  onChange={e => setNewFolderName(e.target.value)}
                  placeholder={t('archiveDestination.newFolderPlaceholder')}
                  className={getInputClass(isDark)}
                />
                {folderNameInvalid ? (
                  <p className="mt-1.5 text-xs text-red-500">{t('archiveDestination.folderNameInvalid')}</p>
                ) : localTarget !== '' ? (
                  <p className={`mt-1.5 font-mono text-xs ${subText}`}>{localTarget}</p>
                ) : null}
              </div>
            )}
          </>
        ) : (
          <>
            <NetworkField
              id="archive-net-host"
              label={t('archiveDestination.host')}
              value={network.host}
              onChange={enterServer}
              placeholder={t('archiveDestination.hostPlaceholder')}
              isDark={isDark}
            />
            <NetworkField
              id="archive-net-share"
              label={t('archiveDestination.share')}
              value={network.share}
              onChange={v => editNetwork({ share: v })}
              placeholder={t('archiveDestination.sharePlaceholder')}
              isDark={isDark}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <NetworkField
                id="archive-net-domain"
                label={t('archiveDestination.domain')}
                value={network.domain}
                onChange={v => editNetwork({ domain: v })}
                placeholder=""
                isDark={isDark}
              />
              <NetworkField
                id="archive-net-username"
                label={t('archiveDestination.username')}
                value={network.username}
                onChange={v => editNetwork({ username: v })}
                placeholder={t('archiveDestination.usernamePlaceholder')}
                isDark={isDark}
              />
            </div>
            <div>
              <NetworkField
                id="archive-net-password"
                label={t('archiveDestination.password')}
                value={network.password ?? ''}
                onChange={v => editNetwork({ password: v })}
                type="password"
                placeholder={passwordStored ? t('archiveDestination.passwordStored') : ''}
                isDark={isDark}
              />
              <p className={`mt-1.5 text-xs ${subText}`}>
                {passwordStored ? t('archiveDestination.passwordKeepHint') : t('archiveDestination.passwordHint')}
              </p>
              {passwordStored && (
                <button
                  type="button"
                  onClick={() => {
                    setPasswordStored(false);
                    setClearPassword(true);
                    editNetwork({ password: '' });
                  }}
                  className={`mt-1.5 text-xs font-medium ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  {t('archiveDestination.clearPassword')}
                </button>
              )}
            </div>
            <NetworkField
              id="archive-net-subpath"
              label={t('archiveDestination.subpath')}
              value={network.subpath}
              onChange={editSubpath}
              placeholder={t('archiveDestination.subpathPlaceholder')}
              isDark={isDark}
            />

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void runTest()}
                disabled={busy || network.host.trim() === '' || network.share.trim() === ''}
                className={`${btnBase} ${btnSubtle} inline-flex items-center gap-1.5`}
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {busy ? t('archiveDestination.testing') : t('archiveDestination.testConnection')}
              </button>
              {shareRootName !== '' && <span className={`truncate font-mono text-xs ${subText}`}>{shareRootName}</span>}
            </div>

            {testResult && (
              <div
                className={`flex items-start gap-2.5 rounded-lg px-3.5 py-3 text-[0.75rem] leading-relaxed ${
                  testResult.ok
                    ? isDark
                      ? 'bg-emerald-500/10 text-emerald-200/90'
                      : 'bg-emerald-50 text-emerald-900'
                    : isDark
                      ? 'bg-red-500/10 text-red-200/90'
                      : 'bg-red-50 text-red-900'
                }`}
              >
                {!testResult.ok && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
                <span>{testResult.ok ? t('archiveDestination.testOk') : testResult.reason}</span>
              </div>
            )}

            {/* Folders on the share, once it is connected. The subpath is chosen
                here rather than typed, which is the whole point of testing first. */}
            {testResult?.ok === true && (
              <div>
                <span className={`text-xs font-medium uppercase tracking-wide ${subText}`}>
                  {t('archiveDestination.shareFolders')}
                </span>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!canClimbShare}
                    onClick={climbShare}
                    title={t('archiveDestination.upOneFolder')}
                    className={`rounded-lg p-1.5 ${
                      canClimbShare ? (isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100') : 'opacity-40'
                    }`}
                  >
                    <ArrowUp className={`h-4 w-4 ${body}`} />
                  </button>
                  <span className={`flex-1 truncate font-mono text-xs ${body}`}>
                    {shareRootName}
                    {relativeHere === '' ? '' : `\\${relativeHere.replace(/\//g, '\\')}`}
                  </span>
                </div>
                <div className={`mt-2 max-h-36 overflow-y-auto rounded-xl ${isDark ? 'bg-slate-800/40' : 'bg-slate-50'}`}>
                  {shareBrowsing ? (
                    <div className={`px-3 py-2.5 text-xs ${subText}`}>{t('archiveDestination.loading')}</div>
                  ) : (shareData?.directories ?? []).length === 0 ? (
                    <div className={`px-3 py-2.5 text-xs ${subText}`}>{t('archiveDestination.noSubfolders')}</div>
                  ) : (
                    (shareData?.directories ?? []).map(d => (
                      <button
                        type="button"
                        key={d.path}
                        onClick={() => enterShareFolder(d)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${body} ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
                      >
                        <FolderOpen className="h-4 w-4 shrink-0 text-accent-500" />
                        <span className="flex-1 truncate">{d.name}</span>
                        {relativeTo(d.path, shareRoot) === network.subpath && (
                          <span className={`text-xs ${subText}`}>{t('archiveDestination.current')}</span>
                        )}
                        <ChevronRight className="h-3.5 w-3.5 opacity-40" />
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            {!networkSupported && (
              <p className={`text-[0.75rem] leading-relaxed ${subText}`}>{t('archiveDestination.unsupported')}</p>
            )}
          </>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <p className={`text-xs ${body}`}>{error}</p>
          </div>
        )}
      </div>

      <div className={`flex items-center justify-between gap-3 border-t px-5 py-4 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <span className={`min-w-0 truncate font-mono text-xs ${subText}`}>
          {tab === 'drive'
            ? localTarget !== ''
              ? localTarget
              : t('archiveDestination.pickDrive')
            : shareRootName}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className={`${btnBase} ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
          >
            {t('archiveDestination.cancel')}
          </button>
          {tab === 'drive' ? (
            <button
              type="button"
              onClick={chooseLocal}
              disabled={localTarget === '' || folderNameInvalid}
              className={`${btnBase} ${btnPrimary}`}
            >
              {t('archiveDestination.useFolder')}
            </button>
          ) : (
            <button
              type="button"
              onClick={chooseNetwork}
              disabled={!networkReady}
              className={`${btnBase} ${btnPrimary}`}
            >
              {t('archiveDestination.useShare')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function NetworkField({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  isDark,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: 'text' | 'password';
  isDark: boolean;
}) {
  return (
    <div>
      <label className={`mb-1.5 block text-[0.8125rem] font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={getInputClass(isDark)}
      />
    </div>
  );
}

/** The part of `full` below `root`, with no leading separator. Empty when they are
 *  the same directory. */
function relativeTo(full: string, root: string): string {
  if (root === '' || full.length <= root.length) return '';
  return full.slice(root.length).replace(/^[\\/]+/, '');
}

/** Join a server-side path with a folder name using that path's own separator. */
function joinLocal(base: string, name: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}
