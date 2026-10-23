import { useState } from 'react';
import { useQuery, skipToken } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import {
  HardDrive, FolderOpen, ChevronRight, ArrowUp, Check,
  AlertTriangle, Loader2, RefreshCw, Server, ShieldCheck,
} from 'lucide-react';
import {
  listVolumes, browseDirectory,
  startLibraryMigration, startNetworkLibraryMigration, testNetworkLibraryConnection,
  type VolumeInfo, type DirectoryEntry, type LibraryLocation, type NetworkLibraryConfig,
} from '../../lib/api/storage';
import { getInputClass } from './formClasses';
import { looksLikeShareAddress, parseShareAddress } from '../../lib/uncInput';
import { formatBytes } from '../../lib/utils';
import { Modal } from './Modal';

// Join a server-side path with a folder name using that path's own separator
// (so Windows D:\ and macOS /Volumes both render correctly). The server
// normalizes the result, so this only needs to be good enough to display.
function joinPath(base: string, name: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

export function ChangeLocationModal({
  isDark, location, onClose, onStarted,
}: {
  isDark: boolean;
  location: LibraryLocation | undefined;
  onClose: () => void;
  onStarted: () => void;
}) {
  const { t } = useTranslation('common');
  const [tab, setTab] = useState<'drive' | 'network'>('drive');
  const [volume, setVolume] = useState<VolumeInfo | null>(null);
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('Nebulis');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const { data: volumesData, isLoading: volumesLoading, refetch: refetchVolumes } = useQuery({
    queryKey: ['storage-volumes'],
    queryFn: listVolumes,
    enabled: tab === 'drive',
  });

  const { data: browseData } = useQuery({
    queryKey: ['storage-browse', browsePath],
    queryFn: browsePath ? () => browseDirectory(browsePath) : skipToken,
    enabled: tab === 'drive' && !!browsePath,
  });

  const heading = isDark ? 'text-white' : 'text-slate-800';
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const sub = isDark ? 'text-slate-500' : 'text-slate-400';

  function pickVolume(v: VolumeInfo) {
    setVolume(v);
    setBrowsePath(v.path);
    setError('');
  }

  // The destination is the chosen location plus the folder name. The move
  // creates this folder itself, so there is no separate "create" step. An
  // empty name means "use the folder shown" as-is.
  const folderName = newFolderName.trim();
  const nameError = folderName && (/[\\/]/.test(folderName) || folderName === '.' || folderName === '..')
    ? t('changeLocationModal.folderNameSlashError')
    : '';
  const targetPath = browsePath && !nameError
    ? (folderName ? joinPath(browsePath, folderName) : browsePath)
    : null;

  async function handleStart() {
    if (!targetPath) return;
    setStarting(true);
    setError('');
    try {
      await startLibraryMigration(targetPath);
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('changeLocationModal.couldNotStartMove'));
      setStarting(false);
    }
  }

  const atVolumeRoot = volume ? browsePath === volume.path : true;
  const canGoUp = !!volume && !atVolumeRoot;
  const showTabs = !!location?.networkLibrarySupported;

  return (
    <Modal isOpen onClose={onClose} title={t('changeLocationModal.title')}>
      <div
        className={`w-full max-w-lg rounded-2xl shadow-2xl ${isDark ? 'bg-slate-900' : 'bg-white'} max-h-[85vh] flex flex-col`}
      >
        <div className="px-5 py-4 border-b border-slate-500/10">
          <h3 className={`font-display text-lg font-semibold ${heading}`}>{t('changeLocationModal.title')}</h3>
          <p className={`text-xs mt-0.5 ${sub}`}>
            {t('changeLocationModal.subtitle')}
          </p>
          {showTabs && (
            <div className={`flex gap-1 mt-3 p-1 rounded-lg w-fit ${isDark ? 'bg-slate-800/60' : 'bg-slate-100'}`}>
              <button
                type="button"
                onClick={() => { setTab('drive'); setError(''); }}
                className={`text-xs font-medium px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 ${
                  tab === 'drive'
                    ? isDark ? 'bg-slate-700 text-white' : 'bg-white text-slate-800 shadow-sm'
                    : sub
                }`}
              >
                <HardDrive className="w-3.5 h-3.5" /> {t('changeLocationModal.driveTab')}
              </button>
              <button
                type="button"
                onClick={() => { setTab('network'); setError(''); }}
                className={`text-xs font-medium px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 ${
                  tab === 'network'
                    ? isDark ? 'bg-slate-700 text-white' : 'bg-white text-slate-800 shadow-sm'
                    : sub
                }`}
              >
                <Server className="w-3.5 h-3.5" /> {t('changeLocationModal.networkTab')}
              </button>
            </div>
          )}
        </div>

        {tab === 'network' && showTabs ? (
          <NetworkShareForm
            isDark={isDark}
            location={location}
            starting={starting}
            setStarting={setStarting}
            error={error}
            setError={setError}
            onClose={onClose}
            onStarted={onStarted}
          />
        ) : (
        <>
        <div className="px-5 py-4 overflow-y-auto space-y-4">
          {/* Volumes */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-medium uppercase tracking-wide ${sub}`}>{t('changeLocationModal.drivesHeading')}</span>
              <button
                type="button"
                onClick={() => refetchVolumes()}
                className={`text-xs inline-flex items-center gap-1 ${sub} hover:opacity-80`}
              >
                <RefreshCw className="w-3 h-3" /> {t('changeLocationModal.refresh')}
              </button>
            </div>
            {volumesLoading ? (
              <div className={`text-sm ${sub}`}>{t('changeLocationModal.lookingForDrives')}</div>
            ) : (
              <div className="space-y-1.5">
                {(volumesData?.volumes ?? []).map(v => (
                  <button
                    type="button"
                    key={v.path}
                    onClick={() => pickVolume(v)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border transition-colors ${
                      volume?.path === v.path
                        ? isDark ? 'bg-accent-500/10 border-accent-500/40' : 'bg-accent-50 border-accent-300'
                        : isDark ? 'border-slate-800 hover:bg-slate-800/50' : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className={`text-sm font-medium truncate ${body}`}>{v.label}</span>
                      <span className={`text-xs tabular-nums ${sub}`}>{t('changeLocationModal.freeSpace', { size: formatBytes(v.freeBytes) })}</span>
                    </div>
                    <div className={`text-xs font-mono mt-0.5 truncate ${sub}`}>{v.path}</div>
                  </button>
                ))}
                {(volumesData?.volumes ?? []).length === 0 && (
                  <div className={`text-sm ${sub}`}>{t('changeLocationModal.noDrivesFound')}</div>
                )}
              </div>
            )}
          </div>

          {/* Location + folder name */}
          {volume && (
            <div>
              <span className={`text-xs font-medium uppercase tracking-wide ${sub}`}>{t('changeLocationModal.locationHeading')}</span>
              <div className="flex items-center gap-2 mt-2 mb-2">
                <button
                  type="button"
                  disabled={!canGoUp}
                  onClick={() => {
                    if (!browsePath || !canGoUp) return;
                    const parent = browsePath.replace(/[\\/][^\\/]+$/, '');
                    setBrowsePath(parent || volume.path);
                  }}
                  className={`p-1.5 rounded-lg ${canGoUp ? (isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100') : 'opacity-40'}`}
                  title={t('changeLocationModal.upOneFolder')}
                >
                  <ArrowUp className={`w-4 h-4 ${body}`} />
                </button>
                <span className={`text-xs font-mono truncate flex-1 ${body}`}>{browsePath}</span>
              </div>
              <div className={`${isDark ? 'bg-slate-800/40' : 'bg-slate-50'} rounded-xl max-h-36 overflow-y-auto`}>
                {(browseData?.directories ?? []).map((d: DirectoryEntry) => (
                  <button
                    type="button"
                    key={d.path}
                    onClick={() => setBrowsePath(d.path)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${body} ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
                  >
                    <FolderOpen className="w-4 h-4 text-accent-500 shrink-0" />
                    <span className="truncate flex-1">{d.name}</span>
                    <ChevronRight className="w-3.5 h-3.5 opacity-40" />
                  </button>
                ))}
                {(browseData?.directories ?? []).length === 0 && (
                  <div className={`px-3 py-2.5 text-xs ${sub}`}>{t('changeLocationModal.noSubfolders')}</div>
                )}
              </div>

              <label className={`block text-xs font-medium uppercase tracking-wide mt-3 mb-1.5 ${sub}`}>
                {t('changeLocationModal.folderName')}
              </label>
              <input
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                placeholder={t('changeLocationModal.folderNamePlaceholder')}
                className={`${getInputClass(isDark)} w-full`}
              />
              {nameError ? (
                <p className="text-xs mt-1.5 text-red-500">{nameError}</p>
              ) : targetPath && (
                <p className={`text-xs mt-1.5 ${sub}`}>
                  <Trans
                    i18nKey="changeLocationModal.willBeStoredIn"
                    ns="common"
                    values={{ path: targetPath }}
                    components={{ 1: <span className={`font-mono ${body}`} /> }}
                  />
                  {folderName ? ` ${t('changeLocationModal.folderCreatedAutomatically')}` : ''}
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
              <p className={`text-xs ${body}`}>{error}</p>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-500/10 flex items-center justify-between gap-3">
          <span className={`text-xs truncate ${sub}`}>
            {targetPath
              ? <Trans i18nKey="changeLocationModal.moveTo" ns="common" values={{ path: targetPath }} components={{ 1: <span className="font-mono" /> }} />
              : t('changeLocationModal.pickDriveToBegin')}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className={`text-sm font-medium px-3.5 py-2 rounded-lg ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
            >
              {t('confirmModal.cancel')}
            </button>
            <button
              type="button"
              disabled={!targetPath || starting}
              onClick={handleStart}
              className={`text-sm font-medium px-3.5 py-2 rounded-lg inline-flex items-center gap-1.5 ${
                !targetPath || starting
                  ? 'opacity-50 cursor-not-allowed bg-slate-500/10 text-slate-400'
                  : 'bg-accent-500 text-white hover:bg-accent-600'
              }`}
            >
              {starting && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('changeLocationModal.moveLibraryHere')}
            </button>
          </div>
        </div>
        </>
        )}
      </div>
    </Modal>
  );
}

const DEFAULT_NETWORK_CONFIG: NetworkLibraryConfig = {
  host: '', share: '', domain: '', username: '', password: '', subpath: 'Nebulis',
};

function NetworkShareForm({
  isDark, location, starting, setStarting, error, setError, onClose, onStarted,
}: {
  isDark: boolean;
  location: LibraryLocation | undefined;
  starting: boolean;
  setStarting: (v: boolean) => void;
  error: string;
  setError: (v: string) => void;
  onClose: () => void;
  onStarted: () => void;
}) {
  const { t } = useTranslation('common');
  const [cfg, setCfg] = useState<NetworkLibraryConfig>(() => ({
    ...DEFAULT_NETWORK_CONFIG,
    ...(location?.network ?? {}),
    password: '',
  }));
  const [showDomain, setShowDomain] = useState(!!location?.network.domain);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; reason?: string } | null>(null);

  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const sub = isDark ? 'text-slate-500' : 'text-slate-400';

  /** The same paste people make here: `\\host\share` into the server field. See
   *  src/lib/uncInput.ts. */
  function updateServer(value: string) {
    if (!looksLikeShareAddress(value)) {
      update('host', value);
      return;
    }
    const parsed = parseShareAddress(value);
    if (parsed === null) {
      update('host', value);
      return;
    }
    setCfg(c => ({
      ...c,
      host: parsed.host,
      share: parsed.share === '' ? c.share : parsed.share,
      subpath: parsed.subpath === '' ? c.subpath : parsed.subpath,
    }));
    setTestResult(null);
    setError('');
  }

  function update(field: keyof NetworkLibraryConfig, value: string) {
    setCfg(c => ({ ...c, [field]: value }));
    setTestResult(null);
    setError('');
  }

  const canSubmit = cfg.host.trim().length > 0 && cfg.share.trim().length > 0;

  async function handleTest() {
    if (!canSubmit) return;
    setTesting(true);
    setTestResult(null);
    setError('');
    try {
      const result = await testNetworkLibraryConnection(cfg);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, reason: err instanceof Error ? err.message : t('changeLocationModal.network.couldNotTestConnection') });
    } finally {
      setTesting(false);
    }
  }

  async function handleStart() {
    if (!canSubmit) return;
    setStarting(true);
    setError('');
    try {
      await startNetworkLibraryMigration(cfg);
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('changeLocationModal.couldNotStartMove'));
      setStarting(false);
    }
  }

  return (
    <>
      <div className="px-5 py-4 overflow-y-auto space-y-3.5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={`block text-xs font-medium uppercase tracking-wide mb-1.5 ${sub}`}>{t('changeLocationModal.network.serverAddress')}</label>
            <input
              value={cfg.host}
              onChange={e => updateServer(e.target.value)}
              placeholder={t('changeLocationModal.network.serverAddressPlaceholder')}
              className={`${getInputClass(isDark)} w-full`}
            />
          </div>
          <div>
            <label className={`block text-xs font-medium uppercase tracking-wide mb-1.5 ${sub}`}>{t('changeLocationModal.network.shareName')}</label>
            <input
              value={cfg.share}
              onChange={e => update('share', e.target.value)}
              placeholder={t('changeLocationModal.network.shareNamePlaceholder')}
              className={`${getInputClass(isDark)} w-full`}
            />
          </div>
        </div>

        <div>
          <label className={`block text-xs font-medium uppercase tracking-wide mb-1.5 ${sub}`}>{t('changeLocationModal.network.folderOnShare')}</label>
          <input
            value={cfg.subpath}
            onChange={e => update('subpath', e.target.value)}
            placeholder="Nebulis"
            className={`${getInputClass(isDark)} w-full`}
          />
          <p className={`text-xs mt-1 ${sub}`}>{t('changeLocationModal.network.createdAutomatically')}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={`block text-xs font-medium uppercase tracking-wide mb-1.5 ${sub}`}>{t('changeLocationModal.network.username')}</label>
            <input
              value={cfg.username}
              onChange={e => update('username', e.target.value)}
              placeholder={t('changeLocationModal.network.usernamePlaceholder')}
              className={`${getInputClass(isDark)} w-full`}
            />
          </div>
          <div>
            <label className={`block text-xs font-medium uppercase tracking-wide mb-1.5 ${sub}`}>{t('changeLocationModal.network.password')}</label>
            <input
              type="password"
              value={cfg.password}
              onChange={e => update('password', e.target.value)}
              className={`${getInputClass(isDark)} w-full`}
            />
          </div>
        </div>

        {showDomain ? (
          <div>
            <label className={`block text-xs font-medium uppercase tracking-wide mb-1.5 ${sub}`}>{t('changeLocationModal.network.domainOptional')}</label>
            <input
              value={cfg.domain}
              onChange={e => update('domain', e.target.value)}
              placeholder={t('changeLocationModal.network.domainPlaceholder')}
              className={`${getInputClass(isDark)} w-full`}
            />
          </div>
        ) : (
          <button type="button" onClick={() => setShowDomain(true)} className={`text-xs font-medium ${sub} hover:opacity-80`}>
            {t('changeLocationModal.network.addDomain')}
          </button>
        )}

        <button
          type="button"
          onClick={handleTest}
          disabled={!canSubmit || testing}
          className={`text-sm font-medium px-3.5 py-2 rounded-lg inline-flex items-center gap-1.5 ${
            !canSubmit || testing
              ? 'opacity-50 cursor-not-allowed bg-slate-500/10 text-slate-400'
              : isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
          {t('changeLocationModal.network.testConnection')}
        </button>

        {testResult && (
          <div className={`flex items-start gap-2.5 p-3 rounded-xl border ${
            testResult.ok
              ? 'bg-emerald-500/10 border-emerald-500/20'
              : 'bg-red-500/10 border-red-500/20'
          }`}>
            {testResult.ok
              ? <Check className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
              : <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />}
            <p className={`text-xs leading-relaxed ${body}`}>
              {testResult.ok ? t('changeLocationModal.network.connectedSuccessfully') : testResult.reason}
            </p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
            <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            <p className={`text-xs ${body}`}>{error}</p>
          </div>
        )}
      </div>

      <div className="px-5 py-4 border-t border-slate-500/10 flex items-center justify-between gap-3">
        <span className={`text-xs truncate ${sub}`}>
          {canSubmit
            ? <Trans i18nKey="changeLocationModal.moveTo" ns="common" values={{ path: `\\\\${cfg.host}\\${cfg.share}\\${cfg.subpath}` }} components={{ 1: <span className="font-mono" /> }} />
            : t('changeLocationModal.network.enterServerAndShare')}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className={`text-sm font-medium px-3.5 py-2 rounded-lg ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
          >
            {t('confirmModal.cancel')}
          </button>
          <button
            type="button"
            disabled={!canSubmit || starting}
            onClick={handleStart}
            className={`text-sm font-medium px-3.5 py-2 rounded-lg inline-flex items-center gap-1.5 ${
              !canSubmit || starting
                ? 'opacity-50 cursor-not-allowed bg-slate-500/10 text-slate-400'
                : 'bg-accent-500 text-white hover:bg-accent-600'
            }`}
          >
            {starting && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('changeLocationModal.moveLibraryHere')}
          </button>
        </div>
      </div>
    </>
  );
}
