import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Usb, FolderOpen, RotateCw, Check } from 'lucide-react';
import { listDwarfMounts } from '../../lib/api/telescopes';

export function DwarfLocalPathPicker({
  localPath,
  setLocalPath,
  inputClass,
  labelClass,
  helperClass,
  isDark,
  autoFocus = false,
}: {
  localPath: string;
  setLocalPath: (s: string) => void;
  inputClass: string;
  labelClass: string;
  helperClass: string;
  isDark: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation('common');
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['dwarf-mounts'],
    queryFn: () => listDwarfMounts(),
    staleTime: 5_000,
  });
  // Memoized so the effect below only re-runs when the mount list actually
  // changes, not on every render while `data` is still loading (`?? []`
  // would otherwise hand back a fresh array reference each time).
  const mounts = useMemo(() => data?.mounts ?? [], [data?.mounts]);

  useEffect(() => {
    // One mount is no guess; with several, the person picks.
    if (!localPath && mounts.length === 1) {
      setLocalPath(mounts[0].path);
    }
  }, [mounts, localPath, setLocalPath]);

  return (
    <div>
      <label className={labelClass}>{t('dwarfLocalPathPicker.usbStoragePath')}</label>

      {mounts.length > 0 && (
        <div className="mb-2 space-y-1">
          {mounts.map(m => {
            const selected = m.path === localPath;
            return (
              <button
                key={m.path}
                type="button"
                onClick={() => setLocalPath(m.path)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition ${
                  selected
                    ? (isDark ? 'bg-teal-500/10 border border-teal-500/40 text-teal-200' : 'bg-teal-50 border border-teal-300 text-teal-900')
                    : (isDark ? 'border border-slate-800 hover:border-slate-700 text-slate-300' : 'border border-slate-200 hover:border-slate-300 text-slate-700')
                }`}
              >
                <Usb className={`w-4 h-4 flex-shrink-0 ${selected ? 'text-teal-500' : 'opacity-60'}`} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{m.label}</div>
                  <div className="text-xs opacity-60 truncate">{m.path}</div>
                </div>
                {selected && <Check className="w-4 h-4 text-teal-500 flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <FolderOpen className={`w-4 h-4 flex-shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
        <input
          type="text"
          placeholder={mounts.length > 0 ? t('localPathPicker.customPathPlaceholder') : t('dwarfLocalPathPicker.defaultPathPlaceholder')}
          value={localPath}
          onChange={e => setLocalPath(e.target.value)}
          className={inputClass}
          autoFocus={autoFocus}
        />
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className={`p-2 rounded-lg transition flex-shrink-0 ${
            isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
          } disabled:opacity-50`}
          aria-label={t('dwarfLocalPathPicker.refreshMounts')}
          title={t('dwarfLocalPathPicker.refreshMounts')}
        >
          <RotateCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <p className={helperClass}>
        {mounts.length > 0
          ? t('dwarfLocalPathPicker.detected', { count: mounts.length })
          : t('dwarfLocalPathPicker.plugIn')}
      </p>
    </div>
  );
}
