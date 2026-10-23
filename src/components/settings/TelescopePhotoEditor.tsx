import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ImagePlus, Loader2, Telescope as TelescopeIcon, Trash2 } from 'lucide-react';
import {
  deleteTelescopePhoto,
  listTelescopes,
  telescopePhotoUrl,
  uploadTelescopePhoto,
  type TelescopeProfile,
} from '../../lib/api/telescopes';
import { getHelperClass, getLabelClass } from './SettingsUI';

/**
 * The owner's own picture of one telescope. Like site pictures it is a file on the server, so choosing or removing one takes
 * effect straight away rather than waiting for the modal's Save. Reads the profile fresh from the `['telescopes']` query so the
 * new picture shows as soon as the upload returns.
 */
export function TelescopePhotoEditor({ profile, isDark }: { profile: TelescopeProfile; isDark: boolean }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const labelClass = getLabelClass(isDark);
  const helperClass = getHelperClass(isDark);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState('');

  const { data: telescopes } = useQuery({ queryKey: ['telescopes'], queryFn: listTelescopes });
  const live = telescopes?.find(tel => tel.id === profile.id) ?? profile;
  const version = live.photoVersion ?? null;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['telescopes'] });

  const upload = useMutation({
    mutationFn: (file: File) => uploadTelescopePhoto(profile.id, file),
    onSuccess: () => { setError(''); void invalidate(); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    onSettled: () => { if (fileInput.current) fileInput.current.value = ''; },
  });
  const remove = useMutation({
    mutationFn: () => deleteTelescopePhoto(profile.id),
    onSuccess: () => { setError(''); void invalidate(); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const buttonClass = `inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium border transition ${
    isDark
      ? 'border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-40'
      : 'border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40'
  }`;
  const busy = upload.isPending || remove.isPending;

  return (
    <div>
      <label className={labelClass}>{t('addTelescopeModal.photoTitle')}</label>
      <div className="flex items-center gap-4 mt-1">
        <div className={`w-28 h-20 shrink-0 rounded-xl border overflow-hidden flex items-center justify-center ${
          isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-slate-100'
        }`}>
          {version ? (
            <img
              src={telescopePhotoUrl(profile.id, version)}
              alt={t('addTelescopeModal.photoAlt', { name: live.name })}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <TelescopeIcon className={`w-6 h-6 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} aria-hidden="true" />
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" className={buttonClass} disabled={busy} onClick={() => fileInput.current?.click()}>
            {upload.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
            {upload.isPending
              ? t('addTelescopeModal.photoUploading')
              : version ? t('addTelescopeModal.photoChange') : t('addTelescopeModal.photoChoose')}
          </button>
          {version && (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => remove.mutate()}>
              <Trash2 className="w-4 h-4" />
              {t('addTelescopeModal.photoRemove')}
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={e => { const file = e.target.files?.[0]; if (file) upload.mutate(file); }}
          />
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      <p className={helperClass}>{t('addTelescopeModal.photoHelp')}</p>
    </div>
  );
}
