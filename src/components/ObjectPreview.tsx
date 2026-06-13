import { useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, ImageOff, RefreshCw } from 'lucide-react';
import { getCatalogObjectInfo } from '../lib/api/catalog';
import { getGalleryImage, getLibraryFileUrl } from '../lib/api/library';
import { getCatalogThumbnailUrl, getCatalogSourceThumbnailUrl, parseSourceSentinel } from '../lib/catalogImage';

interface ObjectPreviewProps {
  objectId: string;
  /** Object size in arcminutes — used to pick an appropriate FOV for the thumbnail */
  majorAxisArcmin: number | null;
  isDark: boolean;
  /** Called when the image is clicked; receives the resolved image URL */
  onImageClick?: (url: string) => void;
}

/**
 * Compact image + blurb preview for a catalog DSO.
 *
 * Prefers the user's own gallery image (from their library) when they've
 * already imaged this object — matching ObjectCard's behavior. Falls back
 * to the catalog sky-survey image (/api/catalog/:id/image).
 */
export function ObjectPreview({ objectId, majorAxisArcmin, isDark, onImageClick }: ObjectPreviewProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const retry = useCallback(() => { setImageFailed(false); setIsLoaded(false); setRetryKey(k => k + 1); }, []);

  const { data: info } = useQuery({
    queryKey: ['catalog-info', objectId],
    queryFn: () => getCatalogObjectInfo(objectId),
    staleTime: Infinity,
  });

  const { data: galleryData } = useQuery({
    queryKey: ['gallery-image', objectId],
    queryFn: () => getGalleryImage(objectId),
    staleTime: Infinity,
  });

  // Prefer the user's own observation; fall back to catalog sky-survey image.
  // A `catalog-source:<source>` sentinel pins to a specific cached master.
  const pinnedSource = parseSourceSentinel(galleryData?.galleryImage);
  const imgSrc = pinnedSource
    ? getCatalogSourceThumbnailUrl(objectId, pinnedSource)
    : galleryData?.galleryImage
      ? getLibraryFileUrl(galleryData.galleryImage)
      : getCatalogThumbnailUrl(objectId, majorAxisArcmin);

  const description = info?.description?.trim() || '';
  const wikiUrl = info?.wikiUrl || null;

  // Reset error/loaded state when image source changes
  useEffect(() => {
    setImageFailed(false);
    setIsLoaded(false);
    setRetryKey(k => k + 1);
  }, [imgSrc]);

  return (
    <div className="flex flex-col gap-3">
      <div className="shrink-0">
        {imageFailed ? (
          <button
            onClick={retry}
            title="Retry image fetch"
            className={`flex items-center justify-center w-full max-w-[192px] aspect-square rounded-xl border group ${
              isDark
                ? 'border-slate-800 bg-slate-900/60 text-slate-600 hover:text-slate-400'
                : 'border-slate-200 bg-slate-50 text-slate-400 hover:text-slate-600'
            }`}
          >
            <div className="flex flex-col items-center gap-1.5 px-3 text-center">
              <ImageOff className="w-5 h-5 group-hover:hidden" />
              <RefreshCw className="w-5 h-5 hidden group-hover:block" />
              <span className="text-[10px] leading-tight">No image - tap to retry</span>
            </div>
          </button>
        ) : (
          <div className="relative w-full max-w-[192px] aspect-square">
            {!isLoaded && (
              <div className={`absolute inset-0 rounded-xl border animate-pulse ${
                isDark ? 'border-slate-800 bg-slate-800/60' : 'border-slate-200 bg-slate-200/60'
              }`} />
            )}
            <img
              key={retryKey}
              src={imgSrc}
              alt={info?.name || objectId}
              width={192}
              height={192}
              loading="lazy"
              onLoad={() => setIsLoaded(true)}
              onError={() => setImageFailed(true)}
              onClick={() => onImageClick?.(imgSrc)}
              className={`block w-full aspect-square rounded-xl object-cover border transition-opacity duration-300 ${
                isLoaded ? 'opacity-100' : 'opacity-0'
              } ${onImageClick ? 'cursor-pointer hover:brightness-110' : ''} ${
                isDark ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-slate-50'
              }`}
            />
          </div>
        )}
      </div>
      {description ? (
        <div className="min-w-0">
          <p
            className={`text-[12px] leading-relaxed line-clamp-4 ${
              isDark ? 'text-slate-400' : 'text-slate-600'
            }`}
          >
            {description}
          </p>
          {wikiUrl && (
            <a
              href={wikiUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1 text-[11px] mt-1.5 ${
                isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              Wikipedia
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      ) : imageFailed ? (
        <p
          className={`text-[11px] leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`}
        >
          Image unavailable. Tap the photo area to retry, or run catalog download in Settings → Catalog.
        </p>
      ) : null}
    </div>
  );
}
