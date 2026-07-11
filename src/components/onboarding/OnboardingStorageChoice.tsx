import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Pencil } from 'lucide-react';
import { getLibraryLocation } from '../../lib/api/storage';
import { ChangeLocationModal } from '../settings/LibraryLocationSection';

/**
 * Compact storage-location chooser for onboarding. The library is empty at
 * setup, so picking a drive just records the location (the copy is a no-op).
 * Defaults to the built-in location; the user can change it later in Settings.
 */
export function OnboardingStorageChoice({ isDark, subText }: { isDark: boolean; subText: string }) {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);

  const { data } = useQuery({ queryKey: ['library-location'], queryFn: getLibraryLocation });
  const location = data?.location;

  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <div className={`p-2 rounded-xl ${isDark ? 'bg-accent-500/10' : 'bg-accent-50'}`}>
          <HardDrive className="w-5 h-5 text-accent-500" />
        </div>
        <div>
          <h3 className={`font-display font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            Storage location
          </h3>
          <p className={`text-xs ${subText}`}>Where your imported images and sub-frames are stored</p>
        </div>
      </div>

      <div className={`flex items-center justify-between gap-3 p-3.5 rounded-xl border ${
        isDark ? 'border-slate-800 bg-slate-800/30' : 'border-slate-200 bg-slate-50'
      }`}>
        <div className="min-w-0">
          <div className={`text-sm font-mono truncate ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            {location?.path ?? 'Default location'}
          </div>
          <div className={`text-xs mt-0.5 ${subText}`}>
            {location?.isDefault === false
              ? 'Custom drive. Change any time in Settings, Storage.'
              : 'Default location. Change to a USB or external drive now or later in Settings, Storage.'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className={`shrink-0 inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg ${
            isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
          }`}
        >
          <Pencil className="w-3.5 h-3.5" /> Choose drive
        </button>
      </div>

      {modalOpen && (
        <ChangeLocationModal
          isDark={isDark}
          location={location}
          onClose={() => setModalOpen(false)}
          onStarted={() => {
            setModalOpen(false);
            queryClient.invalidateQueries({ queryKey: ['library-location'] });
          }}
        />
      )}
    </div>
  );
}
