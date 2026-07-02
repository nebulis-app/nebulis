import { useState, memo } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, CalendarDays, Heart } from 'lucide-react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { toggleFavorite, getLibraryObjectThumbnailUrl } from '../lib/api/library';
import type { TelescopeProfile } from '../lib/api/telescopes';
import type { AstroObject } from '../types';

interface ObjectCardProps {
  object: AstroObject;
  isDark: boolean;
  /** Telescopes from the parent's `['telescopes']` query — passed in so this
   *  card stays Tier 3 (Dumb UI): renders only from props, owns no data. */
  telescopes: TelescopeProfile[];
}

const typeColors: Record<string, { bg: string; text: string; darkBg: string; darkText: string }> = {
  'Spiral Galaxy': { bg: 'bg-blue-50', text: 'text-blue-700', darkBg: 'bg-blue-500/10', darkText: 'text-blue-400' },
  'Barred Spiral Galaxy': { bg: 'bg-blue-50', text: 'text-blue-700', darkBg: 'bg-blue-500/10', darkText: 'text-blue-400' },
  'Elliptical Galaxy': { bg: 'bg-indigo-50', text: 'text-indigo-700', darkBg: 'bg-indigo-500/10', darkText: 'text-indigo-400' },
  'Lenticular Galaxy': { bg: 'bg-indigo-50', text: 'text-indigo-700', darkBg: 'bg-indigo-500/10', darkText: 'text-indigo-400' },
  'Irregular Galaxy': { bg: 'bg-sky-50', text: 'text-sky-700', darkBg: 'bg-sky-500/10', darkText: 'text-sky-400' },
  'Galaxy': { bg: 'bg-blue-50', text: 'text-blue-700', darkBg: 'bg-blue-500/10', darkText: 'text-blue-400' },
  'Galaxy Pair': { bg: 'bg-blue-50', text: 'text-blue-700', darkBg: 'bg-blue-500/10', darkText: 'text-blue-400' },
  'Galaxy Triplet': { bg: 'bg-blue-50', text: 'text-blue-700', darkBg: 'bg-blue-500/10', darkText: 'text-blue-400' },
  'Galaxy Group': { bg: 'bg-blue-50', text: 'text-blue-700', darkBg: 'bg-blue-500/10', darkText: 'text-blue-400' },
  'Emission Nebula': { bg: 'bg-rose-50', text: 'text-rose-700', darkBg: 'bg-rose-500/10', darkText: 'text-rose-400' },
  'Planetary Nebula': { bg: 'bg-violet-50', text: 'text-violet-700', darkBg: 'bg-violet-500/10', darkText: 'text-violet-400' },
  'Globular Cluster': { bg: 'bg-amber-50', text: 'text-amber-700', darkBg: 'bg-amber-500/10', darkText: 'text-amber-400' },
  'Open Cluster': { bg: 'bg-emerald-50', text: 'text-emerald-700', darkBg: 'bg-emerald-500/10', darkText: 'text-emerald-400' },
  'Cluster + Nebula': { bg: 'bg-teal-50', text: 'text-teal-700', darkBg: 'bg-teal-500/10', darkText: 'text-teal-400' },
  'Supernova Remnant': { bg: 'bg-orange-50', text: 'text-orange-700', darkBg: 'bg-orange-500/10', darkText: 'text-orange-400' },
  'Dark Nebula': { bg: 'bg-gray-100', text: 'text-gray-700', darkBg: 'bg-gray-500/10', darkText: 'text-gray-400' },
  'Reflection Nebula': { bg: 'bg-cyan-50', text: 'text-cyan-700', darkBg: 'bg-cyan-500/10', darkText: 'text-cyan-400' },
  'Nebula': { bg: 'bg-pink-50', text: 'text-pink-700', darkBg: 'bg-pink-500/10', darkText: 'text-pink-400' },
  'Stellar Association': { bg: 'bg-lime-50', text: 'text-lime-700', darkBg: 'bg-lime-500/10', darkText: 'text-lime-400' },
  default: { bg: 'bg-slate-100', text: 'text-slate-600', darkBg: 'bg-slate-700', darkText: 'text-slate-300' },
};

const typeColorEntries = Object.entries(typeColors);

function getTypeColor(type: string, isDark: boolean) {
  const base = typeColorEntries.find(([key]) => type.includes(key));
  const colors = base ? base[1] : typeColors.default;
  return isDark ? `${colors.darkBg} ${colors.darkText}` : `${colors.bg} ${colors.text}`;
}

export const ObjectCard = memo(function ObjectCard({ object, isDark, telescopes }: ObjectCardProps) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const queryClient = useQueryClient();

  // Pass `galleryImageVersion` as the cache-buster: it combines the user's
  // selection with the source file's mtime, so re-uploading a custom image
  // (which keeps the path identical) still changes the URL and defeats the
  // browser's 24h cache. Falls back to bare galleryImage on older payloads.
  const imageUrl = getLibraryObjectThumbnailUrl(
    object.id, 400, 400,
    object.galleryImageVersion ?? object.galleryImage,
  );

  // Optimistically patch the cached library list instead of invalidating it.
  // Invalidation forced a full re-fetch of every object (a DB read plus a stat
  // per object server-side) just to flip one boolean. Here we update the one
  // entry in place and roll back only if the request fails — no refetch, and
  // the Favorites filter still reacts because object.isFavorite changes.
  const favMutation = useMutation({
    mutationFn: (next: boolean) => toggleFavorite(object.id, next),
    onMutate: async (next: boolean) => {
      await queryClient.cancelQueries({ queryKey: ['library-objects'] });
      const previous = queryClient.getQueryData<AstroObject[]>(['library-objects']);
      queryClient.setQueryData<AstroObject[]>(['library-objects'], old =>
        old?.map(o => (o.id === object.id ? { ...o, isFavorite: next } : o)),
      );
      return { previous };
    },
    onError: (_err, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['library-objects'], context.previous);
      }
    },
  });

  // Derive optimistic favorite state from the in-flight mutation's target value.
  // When the mutation settles and the query re-fetches, object.isFavorite becomes
  // authoritative again — no local state to go stale.
  const favorited = favMutation.isPending
    ? (favMutation.variables ?? object.isFavorite ?? false)
    : (object.isFavorite ?? false);

  // Telescopes arrive as a prop from the parent's `['telescopes']` query.
  // Render the dot stack only when ≥2 are configured and at least one
  // captured this object.
  const showTelescopeDots = telescopes.length >= 2 && (object.telescopeIds?.length ?? 0) > 0;
  const dotEntries = showTelescopeDots
    ? (object.telescopeIds ?? [])
        .map(id => telescopes.find(t => t.id === id))
        .filter((t): t is NonNullable<typeof t> => !!t)
        .slice(0, 3)
    : [];

  return (
    <Link
      to={`/object/${encodeURIComponent(object.id)}`}
      className={`group card-hover block rounded-2xl overflow-hidden border transition-all ${
        isDark
          ? 'bg-slate-900 border-slate-800 hover:border-slate-700'
          : 'bg-white border-slate-200 hover:border-slate-300 shadow-sm hover:shadow-md'
      }`}
    >
      {/* Preview area with sky image */}
      <div className={`relative h-48 overflow-hidden ${
        isDark
          ? 'bg-gradient-to-br from-slate-800 via-slate-900 to-slate-800'
          : 'bg-gradient-to-br from-slate-100 via-slate-50 to-slate-100'
      }`}>
        {/* Sky survey image */}
        {!imgError && (
          <img
            src={imageUrl}
            alt={object.name}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
            className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${
              imgLoaded ? 'opacity-100' : 'opacity-0'
            }`}
          />
        )}

        {/* Gradient overlay for text readability */}
        {imgLoaded && !imgError && (
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
        )}

        {/* Fallback: decorative stars (shown while loading or on error) */}
        {(!imgLoaded || imgError) && (
          <div className="absolute inset-0 opacity-20">
            <div className="absolute top-4 left-6 w-1 h-1 rounded-full bg-accent-400 animate-pulse" />
            <div className="absolute top-12 right-10 w-0.5 h-0.5 rounded-full bg-teal-400" />
            <div className="absolute bottom-8 left-16 w-0.5 h-0.5 rounded-full bg-slate-400" />
            <div className="absolute top-6 right-24 w-1 h-1 rounded-full bg-blue-400 animate-pulse" style={{ animationDelay: '1s' }} />
            <div className="absolute bottom-16 right-8 w-0.5 h-0.5 rounded-full bg-accent-300" />
          </div>
        )}

        {/* Catalog ID overlay */}
        <div className={`absolute inset-0 flex items-center justify-center z-10 ${
          imgLoaded && !imgError ? '' : ''
        }`}>
          {(!imgLoaded || imgError) && (
            <div className="text-center">
              <Sparkles className={`w-10 h-10 mx-auto mb-2 ${isDark ? 'text-accent-500/40' : 'text-accent-400/50'}`} />
              <span className={`font-display font-bold text-3xl tracking-tight ${
                isDark ? 'text-slate-300' : 'text-slate-600'
              }`}>
                {object.catalogId}
              </span>
            </div>
          )}
        </div>

        {/* Catalog ID badge when image is loaded */}
        {imgLoaded && !imgError && (
          <div className="absolute bottom-2 left-3 z-10">
            <span className="font-display font-bold text-xl text-white drop-shadow-lg">
              {object.catalogId}
            </span>
          </div>
        )}

        {/* Favorite heart button — hidden until hover, always visible when favorited */}
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); favMutation.mutate(!favorited); }}
          className={`absolute top-2 right-2 z-10 p-1.5 rounded-full bg-black/30 backdrop-blur-sm hover:bg-black/50 transition-all ${
            favorited ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Heart
            className={`w-4 h-4 transition-colors ${favorited ? 'text-rose-500 fill-rose-500' : 'text-white/70'}`}
          />
        </button>

        {/* Telescope dot stack — one dot per telescope that captured this
            object, only rendered when ≥2 telescopes are configured. */}
        {dotEntries.length > 0 && (
          <div
            className="absolute top-2 left-2 z-10 flex items-center gap-0.5 px-1.5 py-1 rounded-full bg-black/40 backdrop-blur-sm"
            title={dotEntries.map(t => t.name).join(', ')}
          >
            {dotEntries.map(t => (
              <span
                key={t.id}
                className="w-1.5 h-1.5 rounded-full ring-1 ring-white/20"
                style={{ backgroundColor: t.color }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-5">
        <h3 className={`font-display font-semibold text-lg mb-1 ${
          isDark ? 'text-slate-100' : 'text-slate-900'
        }`}>
          {object.name}
        </h3>

        <div className="flex flex-wrap items-center gap-2 mt-3 -ml-2.5">
          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${
            getTypeColor(object.type, isDark)
          }`}>
            {object.type}
          </span>

{object.sessionCount !== undefined && object.sessionCount > 0 && (
            <span className={`inline-flex items-center gap-1 text-xs ml-auto ${
              isDark ? 'text-slate-500' : 'text-slate-400'
            }`}>
              <CalendarDays className="w-3 h-3" />
              {object.sessionCount} observation{object.sessionCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

      </div>
    </Link>
  );
});
