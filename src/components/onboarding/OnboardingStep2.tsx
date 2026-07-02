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
import {
  TELESCOPE_PRESETS,
  TELESCOPE_KINDS,
  toTelescopeKind,
  type TelescopeKind,
} from '../../lib/telescopePresets';
import { DwarfLocalPathPicker } from '../settings/DwarfLocalPathPicker';
import { LocalPathPicker } from '../settings/LocalPathPicker';

export type TestStatus = 'idle' | 'testing' | 'success' | 'error';

interface OnboardingStep2Props {
  kind: TelescopeKind | '';
  /** Resolved transport for this step. True when transportMode === 'local'
   *  or the kind is Dwarf (Dwarf has no SMB path). */
  isLocalKind: boolean;
  /** Drives which transport fields render. Optional so legacy callers
   *  (none currently) still work. Defaults to following the kind. */
  transportMode?: 'smb' | 'local';
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
  onTransportModeChange?: (mode: 'smb' | 'local') => void;
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
  const preset = kind ? TELESCOPE_PRESETS[kind] : null;
  const isSeestarKind = kind === 'seestar-s50' || kind === 'seestar-s30';
  const effectiveMode = transportMode ?? (isLocalKind ? 'local' : 'smb');

  return (
    <>
      <div className="flex items-center gap-3 mb-1">
        <div className={`p-2 rounded-xl ${isDark ? 'bg-teal-500/10' : 'bg-teal-50'}`}>
          <Telescope className="w-5 h-5 text-teal-500" />
        </div>
        <div>
          <h3 className={`font-display font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            Connect Your Telescope
          </h3>
          <p className={`text-xs ${subText}`}>
            {isLocalKind ? 'Select the type and plug in the USB drive' : 'Select the type and enter its IP address or hostname'}
          </p>
        </div>
      </div>

      <div>
        <label className={labelClass}>Telescope Type</label>
        <select
          value={kind}
          onChange={e => {
            const newKind: TelescopeKind | '' = e.target.value ? toTelescopeKind(e.target.value) : '';
            onKindChange(newKind);
          }}
          className={inputClass}
        >
          <option value="" disabled>Select a telescope…</option>
          {TELESCOPE_KINDS.map(k => (
            <option key={k} value={k}>{TELESCOPE_PRESETS[k].label}</option>
          ))}
        </select>
        <p className={helperClass}>Pick your telescope model, or "Other" for a custom SMB share.</p>
      </div>

      <div>
        <label className={labelClass}>Display Name <span className="opacity-60">(optional)</span></label>
        <input
          type="text"
          placeholder={preset?.label ?? 'My Telescope'}
          value={telescopeName}
          onChange={e => onTelescopeNameChange(e.target.value)}
          className={inputClass}
          disabled={!kind}
        />
      </div>

      {/* Seestar transport selector */}
      {isSeestarKind && onTransportModeChange && (
        <div>
          <label className={labelClass}>Connection</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onTransportModeChange('smb')}
              className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition ${
                effectiveMode === 'smb'
                  ? (isDark ? 'bg-teal-500/15 border border-teal-500/50 text-teal-200' : 'bg-teal-50 border border-teal-300 text-teal-900')
                  : (isDark ? 'border border-slate-800 text-slate-400 hover:border-slate-700' : 'border border-slate-200 text-slate-600 hover:border-slate-300')
              }`}
            >
              <Network className="w-4 h-4" />
              Wi-Fi (SMB)
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
              USB cable
            </button>
          </div>
        </div>
      )}

      {/* "Make sure powered on" — shown below transport selector for SMB, hidden for USB */}
      {!isLocalKind && (
        <div className={`flex items-start gap-3 p-3 rounded-xl ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
          <Info className={`w-4 h-4 mt-0.5 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
          <p className={`text-sm ${subText}`}>
            Make sure your telescope is powered on and connected to the same network as this device.
          </p>
        </div>
      )}

      {isLocalKind && (
        isSeestarKind ? (
          <LocalPathPicker
            kind="seestar"
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
            <label className={labelClass}>Hostname / IP Address</label>
            <div className="flex gap-2 items-center">
              <input
                type="text"
                placeholder="192.168.1.100"
                value={hostname}
                onChange={e => onHostnameChange(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && kind && hostname.trim() && onTestConnection()}
                className={`${inputClass} flex-1`}
                disabled={!kind}
              />
              <button
                onClick={onTestConnection}
                disabled={testStatus === 'testing' || !hostname.trim() || !kind}
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
                Test Connection
              </button>
            </div>

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
                <label className={labelClass}>SMB Share Name</label>
                <input
                  type="text"
                  placeholder="e.g. Astronomy"
                  value={smbShareName}
                  onChange={e => onSmbShareNameChange(e.target.value)}
                  className={inputClass}
                />
                <p className={helperClass}>{preset?.shareHelp}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Username</label>
                  <input
                    type="text"
                    placeholder="guest"
                    value={smbUsername}
                    onChange={e => onSmbUsernameChange(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Password</label>
                  <input
                    type="password"
                    placeholder="(optional)"
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
              For best reliability, configure a <strong>DHCP reservation</strong> in your router so your telescope keeps the same IP address.
            </span>
          </div>
        </>
      )}
    </>
  );
}
