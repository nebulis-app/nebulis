import {
  Telescope,
  Wifi,
  WifiOff,
  CheckCircle2,
  AlertCircle,
  RotateCw,
  Info,
  Usb,
  Network,
} from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import {
  TELESCOPE_PRESETS,
  TELESCOPE_KINDS,
  toTelescopeKind,
  isDwarfKind as isDwarfTelescopeKind,
  isSeestarKind as isSeestarTelescopeKind,
  isAsiairKind as isAsiairTelescopeKind,
  type TelescopeKind,
} from '../../lib/telescopePresets';
import type { ConnectionType } from '../../lib/api/telescopes';
import { hostAddressError } from '../../lib/hostAddress';
import { DwarfLocalPathPicker } from '../ui/DwarfLocalPathPicker';
import { LocalPathPicker } from '../ui/LocalPathPicker';
import { HelpBlockText } from '../ui/HelpBlockText';

export type TestStatus = 'idle' | 'testing' | 'success' | 'error';

interface OnboardingStep2Props {
  kind: TelescopeKind | '';
  /** Resolved transport for this step. True when transportMode === 'local'. */
  isLocalKind: boolean;
  /** Drives which transport fields render. Optional so legacy callers
   *  (none currently) still work. Defaults to following the kind. */
  transportMode?: ConnectionType;
  telescopeName: string;
  hostname: string;
  localPath: string;
  smbShareName: string;
  smbUsername: string;
  smbPassword: string;
  testStatus: TestStatus;
  testMessage: string;
  isDark: boolean;
  inputClass: string;
  labelClass: string;
  helperClass: string;
  subText: string;
  onKindChange: (kind: TelescopeKind | '') => void;
  onTransportModeChange?: (mode: ConnectionType) => void;
  onTelescopeNameChange: (value: string) => void;
  onHostnameChange: (value: string) => void;
  onLocalPathChange: (value: string) => void;
  onSmbShareNameChange: (value: string) => void;
  onSmbUsernameChange: (value: string) => void;
  onSmbPasswordChange: (value: string) => void;
  onTestConnection: () => void;
}

export function OnboardingStep2({
  kind,
  isLocalKind,
  transportMode,
  telescopeName,
  hostname,
  localPath,
  smbShareName,
  smbUsername,
  smbPassword,
  testStatus,
  testMessage,
  isDark,
  inputClass,
  labelClass,
  helperClass,
  subText,
  onKindChange,
  onTransportModeChange,
  onTelescopeNameChange,
  onHostnameChange,
  onLocalPathChange,
  onSmbShareNameChange,
  onSmbUsernameChange,
  onSmbPasswordChange,
  onTestConnection,
}: OnboardingStep2Props) {
  const { t } = useTranslation('onboarding');
  const preset = kind ? TELESCOPE_PRESETS[kind] : null;
  // Same check the telescope editor and the server apply. Catching it here
  // means a first-run user who pastes "10.0.1.5/SeeStar/" is told which half
  // goes where, rather than a connection failure that blames the network.
  const hostError = isLocalKind ? null : hostAddressError(hostname);
  const isSeestarKind = kind !== '' && isSeestarTelescopeKind(kind);
  const isDwarfKind = kind !== '' && isDwarfTelescopeKind(kind);
  const isAsiairKind = kind !== '' && isAsiairTelescopeKind(kind);
  const effectiveMode: ConnectionType = transportMode ?? (isLocalKind ? 'local' : 'smb');
  const isFtpMode = effectiveMode === 'ftp';
  /** The network transport this kind offers: FTP for Dwarf, SMB otherwise. */
  const networkMode: ConnectionType = isDwarfKind ? 'ftp' : 'smb';

  return (
    <>
      <div className="flex items-center gap-3 mb-1">
        <div className={`p-2 rounded-xl ${isDark ? 'bg-teal-500/10' : 'bg-teal-50'}`}>
          <Telescope className="w-5 h-5 text-teal-500" />
        </div>
        <div>
          <h3 className={`font-display font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            {t('step2.heading')}
          </h3>
          <p className={`text-xs ${subText}`}>
            {isLocalKind ? t('step2.subheadingLocal') : t('step2.subheadingNetwork')}
          </p>
        </div>
      </div>

      <div>
        <label className={labelClass}>{t('step2.telescopeTypeLabel')}</label>
        <select
          value={kind}
          onChange={e => {
            const newKind: TelescopeKind | '' = e.target.value ? toTelescopeKind(e.target.value) : '';
            onKindChange(newKind);
          }}
          className={inputClass}
        >
          <option value="" disabled>{t('step2.selectPlaceholder')}</option>
          {TELESCOPE_KINDS.map(k => (
            <option key={k} value={k}>{TELESCOPE_PRESETS[k].label}</option>
          ))}
        </select>
        <p className={helperClass}>{t('step2.telescopeTypeHelp')}</p>
      </div>

      <div>
        <label className={labelClass}>{t('step2.displayNameLabel')} <span className="opacity-60">{t('step2.optional')}</span></label>
        <input
          type="text"
          placeholder={preset?.label ?? t('step2.displayNamePlaceholder')}
          value={telescopeName}
          onChange={e => onTelescopeNameChange(e.target.value)}
          className={inputClass}
          disabled={!kind}
        />
      </div>

      {/* Transport selector. The network option is FTP for Dwarf (its only
          network interface) and SMB for Seestar. */}
      {(isSeestarKind || isDwarfKind || isAsiairKind) && onTransportModeChange && (
        <div>
          <label className={labelClass}>{t('step2.connectionLabel')}</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onTransportModeChange(networkMode)}
              className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition ${
                effectiveMode === networkMode
                  ? (isDark ? 'bg-teal-500/15 border border-teal-500/50 text-teal-200' : 'bg-teal-50 border border-teal-300 text-teal-900')
                  : (isDark ? 'border border-slate-800 text-slate-400 hover:border-slate-700' : 'border border-slate-200 text-slate-600 hover:border-slate-300')
              }`}
            >
              <Network className="w-4 h-4" />
              {isDwarfKind ? t('step2.wifiFtp') : t('step2.wifiSmb')}
            </button>
            <button
              type="button"
              onClick={() => onTransportModeChange('local')}
              className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition ${
                effectiveMode === 'local'
                  ? (isDark ? 'bg-teal-500/15 border border-teal-500/50 text-teal-200' : 'bg-teal-50 border border-teal-300 text-teal-900')
                  : (isDark ? 'border border-slate-800 text-slate-400 hover:border-slate-700' : 'border border-slate-200 text-slate-600 hover:border-slate-300')
              }`}
            >
              <Usb className="w-4 h-4" />
              {t('step2.usbCable')}
            </button>
          </div>
        </div>
      )}

      {/* "Make sure powered on" — shown below the transport selector for the
          network transports, hidden for USB. */}
      {!isLocalKind && (
        <div className={`flex items-start gap-3 p-3 rounded-xl ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
          <Info className={`w-4 h-4 mt-0.5 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
          <p className={`text-sm ${subText}`}>
            {isFtpMode ? t('step2.poweredOnFtp') : t('step2.poweredOnNetwork')}
          </p>
        </div>
      )}

      {isLocalKind && (
        isSeestarKind || isAsiairKind ? (
          <LocalPathPicker
            kind={isAsiairKind ? 'asiair' : 'seestar'}
            localPath={localPath}
            setLocalPath={onLocalPathChange}
            inputClass={inputClass}
            labelClass={labelClass}
            helperClass={helperClass}
            isDark={isDark}
          />
        ) : (
          <DwarfLocalPathPicker
            localPath={localPath}
            setLocalPath={onLocalPathChange}
            inputClass={inputClass}
            labelClass={labelClass}
            helperClass={helperClass}
            isDark={isDark}
          />
        )
      )}

      {!isLocalKind && (
        <>
          <div>
            <label className={labelClass}>{t('step2.hostnameLabel')}</label>
            <div className="flex gap-2 items-center">
              <input
                type="text"
                placeholder={preset?.defaultHostname || t('step2.hostnamePlaceholder')}
                value={hostname}
                onChange={e => onHostnameChange(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && kind && hostname.trim() && onTestConnection()}
                className={`${inputClass} flex-1`}
                disabled={!kind}
                aria-invalid={!!hostError}
              />
              <button
                onClick={onTestConnection}
                disabled={testStatus === 'testing' || !hostname.trim() || !kind || !!hostError}
                className={`shrink-0 inline-flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium transition disabled:opacity-50 ${
                  isDark
                    ? 'bg-teal-500/10 text-teal-400 hover:bg-teal-500/20 border border-teal-500/30'
                    : 'bg-teal-50 text-teal-700 hover:bg-teal-100 border border-teal-200'
                }`}
              >
                {testStatus === 'testing' ? (
                  <RotateCw className="w-4 h-4 animate-spin" />
                ) : testStatus === 'success' ? (
                  <Wifi className="w-4 h-4" />
                ) : testStatus === 'error' ? (
                  <WifiOff className="w-4 h-4" />
                ) : (
                  <Wifi className="w-4 h-4" />
                )}
                {t('step2.testConnection')}
              </button>
            </div>

            {hostError && (
              <p className={`text-xs mt-1 ${isDark ? 'text-red-400' : 'text-red-600'}`}>{hostError}</p>
            )}

            {testStatus === 'success' && (
              <div className={`flex items-start gap-3 p-3 rounded-xl mt-2 ${
                isDark ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-emerald-50 border border-emerald-200'
              }`}>
                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                <span className={`text-sm ${isDark ? 'text-emerald-300' : 'text-emerald-700'}`}>
                  {testMessage}
                </span>
              </div>
            )}

            {testStatus === 'error' && (
              <div className={`flex items-start gap-3 p-3 rounded-xl mt-2 ${
                isDark ? 'bg-danger-500/10 border border-danger-500/20' : 'bg-red-50 border border-red-200'
              }`}>
                <AlertCircle className="w-4 h-4 text-danger-500 shrink-0 mt-0.5" />
                <span className={`text-sm ${isDark ? 'text-red-300' : 'text-red-700'}`}>
                  {testMessage}
                </span>
              </div>
            )}
          </div>

          {kind === 'other' && (
            <>
              <div>
                <label className={labelClass}>{t('step2.smbShareNameLabel')}</label>
                <input
                  type="text"
                  placeholder={t('step2.smbShareNamePlaceholder')}
                  value={smbShareName}
                  onChange={e => onSmbShareNameChange(e.target.value)}
                  className={inputClass}
                />
                {preset?.shareHelp && <HelpBlockText block={preset.shareHelp} className={helperClass} />}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>{t('step2.usernameLabel')}</label>
                  <input
                    type="text"
                    placeholder={t('step2.usernamePlaceholder')}
                    value={smbUsername}
                    onChange={e => onSmbUsernameChange(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>{t('step2.passwordLabel')}</label>
                  <input
                    type="password"
                    placeholder={t('step2.passwordPlaceholderOptional')}
                    value={smbPassword}
                    onChange={e => onSmbPasswordChange(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
            </>
          )}

          <div className={`flex items-start gap-2 p-3 rounded-lg text-xs ${
            isDark ? 'bg-amber-500/5 text-amber-400/80 border border-amber-500/10' : 'bg-amber-50 text-amber-700 border border-amber-100'
          }`}>
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              {isFtpMode
                ? <Trans i18nKey="step2.ftpDhcpNote" ns="onboarding" components={{ 1: <strong />, 3: <strong /> }} />
                : <Trans i18nKey="step2.networkDhcpNote" ns="onboarding" components={{ 1: <strong /> }} />}
            </span>
          </div>
        </>
      )}
    </>
  );
}
