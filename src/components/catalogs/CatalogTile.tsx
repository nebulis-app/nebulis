import { getCatalogStaticThumbnailUrl, getCatalogThumbnailUrl } from '../../lib/catalogImage';
import type { CatalogProgressObject } from '../../lib/api/catalogs';
import { Check } from 'lucide-react';

interface Props {
  object: CatalogProgressObject;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
  onClick: () => void;
}

export function CatalogTile({ object, isDark, isNight, isSpace, onClick }: Props) {
  const staticUrl = getCatalogStaticThumbnailUrl(object.id);
  const apiUrl = getCatalogThumbnailUrl(object.id, object.majorAxisArcmin);

  const ringColor = isNight
    ? 'ring-red-400 shadow-red-400/20'
    : isSpace
      ? 'ring-violet-400 shadow-violet-400/20'
      : 'ring-amber-400 shadow-amber-400/20';

  const checkColor = isNight
    ? 'bg-red-500'
    : isSpace
      ? 'bg-violet-500'
      : 'bg-amber-500';

  return (
    <button
      onClick={onClick}
      className={`
        group relative rounded-xl overflow-hidden aspect-square text-left
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950
        transition-all duration-200
        ${object.isImaged
          ? `ring-2 ${ringColor} shadow-lg hover:scale-[1.03] hover:shadow-xl focus-visible:ring-amber-400`
          : `hover:scale-[1.03] ${isDark ? 'ring-1 ring-slate-700/50 hover:ring-slate-600' : 'ring-1 ring-slate-200 hover:ring-slate-300'} focus-visible:ring-slate-500`
        }
      `}
      aria-label={`${object.id} – ${object.name}${object.isImaged ? ' (imaged)' : ''}`}
    >
      {/* Image */}
      <img
        src={staticUrl}
        onError={(e) => {
          const img = e.currentTarget;
          if (img.src !== apiUrl) img.src = apiUrl;
        }}
        alt={`${object.id} reference`}
        className={`w-full h-full object-cover transition-all duration-200 group-hover:brightness-110 ${
          object.isImaged ? '' : 'grayscale opacity-55 group-hover:opacity-70'
        }`}
      />

      {/* Dark vignette so text is always readable */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

      {/* Imaged check badge */}
      {object.isImaged && (
        <div className={`absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center shadow-lg ${checkColor}`}>
          <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />
        </div>
      )}

      {/* Label */}
      <div className="absolute bottom-0 left-0 right-0 p-2">
        <div className="text-[11px] font-bold text-white leading-tight tracking-wide">
          {object.id}
        </div>
        <div className={`text-[10px] leading-tight mt-0.5 truncate ${object.isImaged ? 'text-white/90' : 'text-white/60'}`}>
          {object.name !== object.id ? object.name : object.type}
        </div>
      </div>
    </button>
  );
}
