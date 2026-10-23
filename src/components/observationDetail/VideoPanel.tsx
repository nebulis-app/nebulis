import { useTranslation } from 'react-i18next';
import { Download, Film } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import type { SessionFile } from '../../types';
import { formatDate } from '../../lib/formatLocale';

/** True for containers a browser (and the native AVPlayer/ExoPlayer clients)
 *  can actually decode. Raw AVI from older SeeStar planetary captures streams
 *  fine from `/library/video` but nothing plays it, so it falls back to a
 *  download card. */
function isPlayable(file: SessionFile): boolean {
  return /\.(mp4|mov)$/i.test(file.name);
}

/**
 * The "Videos" panel: lunar/solar/planetary video and timelapse captures.
 *
 * Kept separate from SessionFileGrid because a video is not a still: it has no
 * thumbnail to crown, compare, or favorite, and the gallery lightbox only knows
 * images and FITS. An inline `<video>` per file is the whole feature.
 */
export function VideoPanel({ videos, date }: { videos: SessionFile[]; date: string }) {
  const { isDark } = useTheme();
  const { t } = useTranslation('observations');

  const dateLabel = date && date !== 'unknown'
    ? formatDate(new Date(date + 'T12:00:00'), { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  return (
    <div className={`rounded-2xl border ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
      {videos.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4">
          {videos.map(file => {
            const playable = isPlayable(file);
            const isTimelapse = /-timelapse\.[^.]+$/i.test(file.name);
            return (
              <div
                key={file.path}
                className={`rounded-xl overflow-hidden border ${isDark ? 'border-slate-800 bg-slate-800' : 'border-slate-200 bg-slate-100'}`}
              >
                <div className="relative aspect-video bg-black">
                  {playable && file.videoUrl ? (
                    <video
                      controls
                      preload="metadata"
                      playsInline
                      className="w-full h-full object-contain"
                      src={file.videoUrl}
                    />
                  ) : (
                    <div className={`w-full h-full flex flex-col items-center justify-center gap-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      <Film className="w-7 h-7" />
                      <span className="text-[0.6875rem] font-medium">
                        {t('observationDetail.videoPanel.downloadToPlay', { ext: file.name.split('.').pop()?.toUpperCase() })}
                      </span>
                    </div>
                  )}
                </div>

                <div className={`flex items-center justify-between gap-2 px-3 py-2 ${isDark ? 'bg-slate-900/80' : 'bg-white/90'}`}>
                  <div className="min-w-0">
                    <p className={`text-xs font-medium truncate ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                      {file.name}
                    </p>
                    <p className={`text-[0.625rem] mt-0.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                      {[isTimelapse ? t('observationDetail.videoPanel.timelapse') : t('observationDetail.videoPanel.video'), dateLabel].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <a
                    href={file.downloadUrl}
                    download={file.name}
                    className={`shrink-0 p-2 rounded-lg transition ${isDark ? 'text-slate-400 hover:text-accent-400 hover:bg-slate-800' : 'text-slate-500 hover:text-accent-500 hover:bg-slate-100'}`}
                    title={t('observationDetail.videoPanel.download')}
                  >
                    <Download className="w-4 h-4" />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className={`p-8 text-center ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
          {t('observationDetail.videoPanel.empty')}
        </div>
      )}
    </div>
  );
}
