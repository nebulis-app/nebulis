import {
  User,
  Telescope,
  Clock,
  CheckCircle2,
  AlertCircle,
  Info,
  Image,
} from 'lucide-react';
import { TELESCOPE_PRESETS, type TelescopeKind } from '../../lib/telescopePresets';
import { INTERVAL_OPTIONS } from './OnboardingStep3';
import type { TestStatus } from './OnboardingStep2';

export interface OnboardingStep4Props {
  username: string;
  kind: TelescopeKind | '';
  isLocalKind: boolean;
  telescopeName: string;
  hostname: string;
  localPath: string;
  autoImportInterval: number;
  importJpg: boolean;
  importFits: boolean;
  importSubFrames: boolean;
  testStatus: TestStatus;
  finishError: Error | null;
  isDark: boolean;
  subText: string;
}

interface SummaryRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  status?: 'connected' | 'untested';
  isDark: boolean;
}

function SummaryRow({ icon, label, value, status, isDark }: SummaryRowProps) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${isDark ? 'bg-slate-900' : 'bg-white'}`}>
      <div className="shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{label}</p>
        <p className={`text-sm font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{value}</p>
      </div>
      {status === 'connected' && (
        <span className="flex items-center gap-1 text-xs text-emerald-500">
          <CheckCircle2 className="w-3 h-3" /> Connected
        </span>
      )}
      {status === 'untested' && (
        <span className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Not tested</span>
      )}
    </div>
  );
}

export function OnboardingStep4({
  username,
  kind,
  isLocalKind,
  telescopeName,
  hostname,
  localPath,
  autoImportInterval,
  importJpg,
  importFits,
  importSubFrames,
  testStatus,
  finishError,
  isDark,
  subText,
}: OnboardingStep4Props) {
  const preset = kind ? TELESCOPE_PRESETS[kind] : null;
  const intervalLabel = INTERVAL_OPTIONS.find(o => o.value === autoImportInterval)?.label || `${autoImportInterval} min`;
  const backupItems = [
    importJpg && 'Stacked Images',
    importFits && 'FITS Files',
    importSubFrames && 'Subframes',
  ].filter(Boolean) as string[];

  return (
    <>
      <div className="flex items-center gap-3 mb-1">
        <div className={`p-2 rounded-xl ${isDark ? 'bg-accent-500/10' : 'bg-accent-50'}`}>
          <CheckCircle2 className="w-5 h-5 text-accent-500" />
        </div>
        <div>
          <h3 className={`font-display font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            Review Setup
          </h3>
          <p className={`text-xs ${subText}`}>Confirm your configuration</p>
        </div>
      </div>

      <div className={`rounded-xl border divide-y ${
        isDark ? 'border-slate-800 divide-slate-800' : 'border-slate-200 divide-slate-200'
      }`}>
        <SummaryRow
          icon={<User className="w-4 h-4 text-emerald-500" />}
          label="Admin Account"
          value={username}
          isDark={isDark}
        />
        <SummaryRow
          icon={<Telescope className="w-4 h-4 text-teal-500" />}
          label="Telescope"
          value={
            isLocalKind
              ? (localPath && preset ? `${telescopeName.trim() || preset.label} (${localPath})` : '(not configured)')
              : (hostname && preset ? `${telescopeName.trim() || preset.label} (${hostname})` : '(not configured)')
          }
          status={!isLocalKind && testStatus === 'success' ? 'connected' : (!isLocalKind && hostname) ? 'untested' : undefined}
          isDark={isDark}
        />
        <SummaryRow
          icon={<Clock className="w-4 h-4 text-accent-500" />}
          label="Import Frequency"
          value={intervalLabel}
          isDark={isDark}
        />
        <SummaryRow
          icon={<Image className="w-4 h-4 text-accent-500" />}
          label="Backup"
          value={backupItems.length > 0 ? backupItems.join(', ') : 'None selected'}
          isDark={isDark}
        />
      </div>

      {!isLocalKind && testStatus !== 'success' && hostname && (
        <div className={`flex items-start gap-2 p-3 rounded-lg text-xs ${
          isDark ? 'bg-amber-500/5 text-amber-400/80 border border-amber-500/10' : 'bg-amber-50 text-amber-700 border border-amber-100'
        }`}>
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>Connection has not been verified. You can test it later from Settings.</span>
        </div>
      )}

      {finishError && (
        <div className="flex items-center gap-2 text-sm text-danger-500">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {finishError.message}
        </div>
      )}
    </>
  );
}
