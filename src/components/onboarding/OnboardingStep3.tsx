import { Clock, AlertTriangle, Image, FileText, Film, Download } from 'lucide-react';
import { OnboardingStorageChoice } from './OnboardingStorageChoice';

const INTERVAL_OPTIONS = [
  { value: 0, label: 'Manual only: no automatic import' },
  { value: 5, label: 'Every 5 minutes' },
  { value: 15, label: 'Every 15 minutes' },
  { value: 60, label: 'Every hour' },
  { value: 360, label: 'Every 6 hours' },
];

export { INTERVAL_OPTIONS };

interface OnboardingStep3Props {
  autoImportInterval: number;
  importJpg: boolean;
  importFits: boolean;
  importSubFrames: boolean;
  prefetchCatalogAssets: boolean;
  isDark: boolean;
  inputClass: string;
  labelClass: string;
  helperClass: string;
  subText: string;
  onAutoImportIntervalChange: (value: number) => void;
  onImportJpgChange: (value: boolean) => void;
  onImportFitsChange: (value: boolean) => void;
  onImportSubFramesChange: (value: boolean) => void;
  onPrefetchCatalogAssetsChange: (value: boolean) => void;
}

export function OnboardingStep3({
  autoImportInterval,
  importJpg,
  importFits,
  importSubFrames,
  prefetchCatalogAssets,
  isDark,
  inputClass,
  labelClass,
  helperClass: _helperClass,
  subText,
  onAutoImportIntervalChange,
  onImportJpgChange,
  onImportFitsChange,
  onImportSubFramesChange,
  onPrefetchCatalogAssetsChange,
}: OnboardingStep3Props) {
  return (
    <>
      <OnboardingStorageChoice isDark={isDark} subText={subText} />

      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-xl ${isDark ? 'bg-accent-500/10' : 'bg-accent-50'}`}>
          <Clock className="w-5 h-5 text-accent-500" />
        </div>
        <div>
          <h3 className={`font-display font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            Automatic Import
          </h3>
          <p className={`text-xs ${subText}`}>Configure how frequently the system imports from your telescope</p>
        </div>
      </div>

      <div>
        <label className={labelClass}>Import Frequency</label>
        <select
          value={autoImportInterval}
          onChange={e => onAutoImportIntervalChange(Number(e.target.value))}
          className={inputClass}
        >
          {INTERVAL_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Offline catalog data, downloaded after setup completes */}
      <label
        className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer border transition ${
          prefetchCatalogAssets
            ? isDark
              ? 'bg-accent-500/5 border-accent-500/30'
              : 'bg-accent-50/50 border-accent-200'
            : isDark
              ? 'border-slate-800 hover:border-slate-700'
              : 'border-slate-200 hover:border-slate-300'
        }`}
      >
        <input
          type="checkbox"
          checked={prefetchCatalogAssets}
          onChange={e => onPrefetchCatalogAssetsChange(e.target.checked)}
          className="w-4 h-4 rounded accent-accent-500 mt-0.5"
        />
        <Download className={`w-4 h-4 mt-0.5 ${isDark ? 'text-accent-400' : 'text-accent-500'}`} />
        <div className="flex-1">
          <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
            Download catalog imagery &amp; descriptions
          </span>
          <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            ~80&nbsp;MB of reference images for Messier, Caldwell, and popular targets. Downloads in the background after setup.
          </p>
        </div>
      </label>

      <div>
        <label className={labelClass}>Backup Options</label>
        <div className="space-y-0.5">
          <label className={`flex items-center gap-3 py-2 px-2 rounded-lg cursor-pointer transition ${
            isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-50'
          }`}>
            <input
              type="checkbox"
              checked={importJpg}
              onChange={e => onImportJpgChange(e.target.checked)}
              className="w-4 h-4 rounded accent-accent-500"
            />
            <Image className={`w-4 h-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
            <div>
              <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Stacked Images</span>
              <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Final stacked JPG from each session</p>
            </div>
          </label>

          <label className={`flex items-center gap-3 py-2 px-2 rounded-lg cursor-pointer transition ${
            isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-50'
          }`}>
            <input
              type="checkbox"
              checked={importFits}
              onChange={e => onImportFitsChange(e.target.checked)}
              className="w-4 h-4 rounded accent-accent-500"
            />
            <FileText className={`w-4 h-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
            <div>
              <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>FITS Files</span>
              <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Scientific data for processing and analysis</p>
            </div>
          </label>

          <label className={`flex items-center gap-3 py-2 px-2 rounded-lg cursor-pointer transition ${
            isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-50'
          }`}>
            <input
              type="checkbox"
              checked={importSubFrames}
              onChange={e => onImportSubFramesChange(e.target.checked)}
              className="w-4 h-4 rounded accent-accent-500"
            />
            <Film className={`w-4 h-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
            <div className="flex-1">
              <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Subframes</span>
              <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Individual exposure frames for manual stacking</p>
            </div>
          </label>

          {importSubFrames && (
            <div className={`flex items-start gap-2 ml-10 p-3 rounded-lg text-xs ${
              isDark ? 'bg-amber-500/5 text-amber-400/80 border border-amber-500/10' : 'bg-amber-50 text-amber-700 border border-amber-100'
            }`}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                <strong>Warning:</strong> Subframes can consume very large amounts of storage. A single night of imaging can produce several gigabytes of subframe data.
              </span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
