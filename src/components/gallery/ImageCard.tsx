import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Images } from 'lucide-react';
import { getLibraryFileThumbnailUrl, type LibraryImage } from '../../lib/api/library';

interface ImageCardProps {
  image: LibraryImage;
  isDark: boolean;
  onOpen: () => void;
  onToggleFavorite: (img: LibraryImage) => void;
}

export function ImageCard({ image, isDark, onOpen, onToggleFavorite }: ImageCardProps) {
  const [imgError, setImgError] = useState(false);
  return (
    <div className={`group relative overflow-hidden rounded-xl border transition-all ${
      isDark ? 'bg-slate-900 border-slate-800 hover:border-slate-600'
             : 'bg-white border-slate-200 hover:border-slate-300 shadow-sm hover:shadow-md'
    }`}>
      <button onClick={onOpen} className="relative block w-full aspect-square overflow-hidden cursor-zoom-in">
        {imgError ? (
          <div className={`w-full h-full flex items-center justify-center ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
            <Images className={`w-10 h-10 opacity-30 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
          </div>
        ) : (
          <img src={getLibraryFileThumbnailUrl(image.path, 400, 400)} alt={image.name} loading="lazy"
            onError={() => setImgError(true)}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" />
        )}
      </button>
      <button
        type="button"
        onClick={() => onToggleFavorite(image)}
        title={image.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        className={`absolute top-2 right-2 p-1.5 rounded-full backdrop-blur-sm transition-all ${
          image.isFavorite
            ? 'opacity-100 bg-rose-500/90 text-white hover:bg-rose-600'
            : `max-md:opacity-100 opacity-0 group-hover:opacity-100 ${isDark
                ? 'bg-black/50 text-white/70 hover:bg-black/70 hover:text-white'
                : 'bg-white/70 text-slate-500 hover:bg-white hover:text-rose-500'}`
        }`}
      >
        <Heart className={`w-4 h-4 ${image.isFavorite ? 'fill-current' : ''}`} />
      </button>

      <Link to={`/object/${encodeURIComponent(image.objectId)}`}
        className="block px-3 py-2.5 hover:bg-accent-500/5 transition-colors">
        <p className={`text-sm font-semibold truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
          {image.objectName}
        </p>
        <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {image.date !== 'unknown' ? image.date : 'Unknown date'}
        </p>
      </Link>
    </div>
  );
}
