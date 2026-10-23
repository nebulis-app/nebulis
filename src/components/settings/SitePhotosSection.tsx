import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import {
  deleteSitePhoto,
  getSitePhotos,
  sitePhotoUrl,
  updateSitePhotoCaption,
  uploadSitePhoto,
  type SitePhoto,
} from '../../lib/api/sites';
import { getHelperClass, getLabelClass } from './SettingsUI';

/**
 * The pictures kept under one observing site: add several at once, caption them, remove them.
 * Uploads and removals take effect straight away (they are not part of the modal's Save), because a picture is
 * a file on the server, not a field on the site.
 */
export function SitePhotosSection({ isDark, siteId }: { isDark: boolean; siteId: string | undefined }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const labelClass = getLabelClass(isDark);
  const helperClass = getHelperClass(isDark);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const queryKey = ['site-photos', siteId];
  const photos = useQuery({
    queryKey,
    queryFn: () => getSitePhotos(siteId as string),
    enabled: !!siteId,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteSitePhoto(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  async function addFiles(files: FileList | null) {
    if (!siteId || !files || files.length === 0) return;
    const list = Array.from(files);
    setErrors([]);
    setProgress({ done: 0, total: list.length });
    const failed: string[] = [];
    for (let i = 0; i < list.length; i++) {
      try {
        await uploadSitePhoto(siteId, list[i]);
      } catch (err) {
        failed.push(t('siteEditorModal.photosUploadFailed', {
          name: list[i].name,
          reason: err instanceof Error ? err.message : String(err),
        }));
      }
      setProgress({ done: i + 1, total: list.length });
    }
    setProgress(null);
    setErrors(failed);
    if (fileInput.current) fileInput.current.value = '';
    await queryClient.invalidateQueries({ queryKey });
  }

  const buttonClass = `inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium border transition ${
    isDark
      ? 'border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-40'
      : 'border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40'
  }`;

  return (
    <div>
      <label className={labelClass}>{t('siteEditorModal.photosLabel')}</label>
      {!siteId ? (
        <p className={helperClass}>{t('siteEditorModal.photosSaveFirst')}</p>
      ) : (
        <>
          <div className="flex items-center gap-3 flex-wrap mt-1">
            <button type="button" className={buttonClass} disabled={progress !== null} onClick={() => fileInput.current?.click()}>
              {progress ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
              {progress
                ? t('siteEditorModal.photosUploading', { done: progress.done, total: progress.total })
                : t('siteEditorModal.photosAdd')}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={e => { void addFiles(e.target.files); }}
            />
          </div>

          {errors.map(msg => (
            <p key={msg} className="mt-2 text-xs text-red-400">{msg}</p>
          ))}

          {photos.data && photos.data.length === 0 && !progress && (
            <p className={helperClass}>{t('siteEditorModal.photosEmpty')}</p>
          )}
          {photos.data && photos.data.length > 0 && (
            <ul className="mt-3 grid grid-cols-3 gap-2">
              {photos.data.map(photo => (
                <PhotoTile
                  key={photo.id}
                  photo={photo}
                  isDark={isDark}
                  removing={remove.isPending && remove.variables === photo.id}
                  onRemove={() => remove.mutate(photo.id)}
                  onCaption={() => queryClient.invalidateQueries({ queryKey })}
                />
              ))}
            </ul>
          )}
          <p className={helperClass}>{t('siteEditorModal.photosHelp')}</p>
        </>
      )}
    </div>
  );
}

function PhotoTile({
  photo, isDark, removing, onRemove, onCaption,
}: {
  photo: SitePhoto;
  isDark: boolean;
  removing: boolean;
  onRemove: () => void;
  onCaption: () => void;
}) {
  const { t } = useTranslation('settings');
  const [caption, setCaption] = useState(photo.caption);

  async function saveCaption() {
    const next = caption.trim();
    if (next === photo.caption) return;
    await updateSitePhotoCaption(photo.id, next);
    onCaption();
  }

  return (
    <li className="min-w-0">
      <div className={`group relative aspect-square overflow-hidden rounded-lg border ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-slate-100'}`}>
        <a
          href={sitePhotoUrl(photo.id)}
          target="_blank"
          rel="noreferrer"
          aria-label={t('siteEditorModal.photosOpen')}
          title={photo.fileName}
        >
          <img
            src={sitePhotoUrl(photo.id, 320)}
            alt={photo.caption || photo.fileName}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        </a>
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          aria-label={t('siteEditorModal.photosRemove')}
          title={t('siteEditorModal.photosRemove')}
          className="absolute right-1 top-1 rounded-md bg-black/60 p-1 text-white opacity-0 transition-opacity hover:bg-black/80 focus:opacity-100 group-hover:opacity-100 disabled:opacity-60"
        >
          {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      </div>
      <input
        type="text"
        value={caption}
        maxLength={300}
        placeholder={t('siteEditorModal.photosCaptionPlaceholder')}
        onChange={e => setCaption(e.target.value)}
        onBlur={() => { void saveCaption(); }}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className={`mt-1 w-full bg-transparent text-xs outline-none placeholder:text-slate-500 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
      />
    </li>
  );
}
