import { useState, memo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sparkles, CalendarDays, Heart, FileArchive } from 'lucide-react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { toggleFavorite, getLibraryObjectThumbnailUrl } from '../lib/api/library';
import type { TelescopeProfile } from '../lib/api/telescopes';
import type { AstroObject } from '../types';
import { processingStatusLabel } from '../lib/processingStatus';
import { useTheme } from '../hooks/useTheme';
import { nightSafeColor } from '../lib/nightSafeColor';
import { LibraryIntegrationRemainingChips } from './planner/IntegrationRemainingChips';

interface ObjectCardProps {
  object: AstroObject;
  isDark: boolean;
  /** Telescopes from the parent's `['telescopes']` query — passed in so this
   *  card stays Tier 3 (Dumb UI): renders only from props, owns no data. */
  telescopes: TelescopeProfile[];
  /** Dense grid: square-ish preview, name only, no type/session chips. */
  compact?: boolean;
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

export const ObjectCard = memo(function ObjectCard({ object, isDark, telescopes, compact = false }: ObjectCardProps) {
  const { isNight } = useTheme();
  const { t } = useTranslation('library');
  // Other names for the same object, so a card called "NGC188" can still be
  // recognised as "C1 · Polarissima Cluster". Never repeats the shown name.
  const alsoKnownAs = [...(object.aliases ?? []), ...(object.nicknames ?? [])]
    .filter((n, i, all) => n.toLowerCase() !== object.name.toLowerCase()
      && n.toLowerCase() !== object.catalogId.toLowerCase()
      && all.findIndex(o => o.toLowerCase() === n.toLowerCase()) === i)
    .slice(0, 3)
    .join(' · ');
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

  // Unifying Lens, not a Cache Hack: no setQueryData, no rollback. `mutationKey`
  // is shared by every ObjectCard instance, so Gallery.tsx's useMutationState
  // can overlay every in-flight toggle (including this card's own) onto the
  // 'library-objects' list for the Favorites filter, while this card derives
  // its own optimistic heart icon directly from favMutation below. When the
  // mutation settles, invalidation makes object.isFavorite authoritative again
  // for both — no local state to go stale, and no unconfirmed write can ever
  // masquerade as server truth.
  const favMutation = useMutation({
    mutationKey: ['toggle-object-favorite'],
    mutationFn: ({ next }: { objectId: string; next: boolean }) => toggleFavorite(object.id, next),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
    },
  });

  const favorited = favMutation.isPending
    ? (favMutation.variables?.next ?? object.isFavorite ?? false)
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
          ? 'bg-slate-900 border-slate-800 hover:border-accent-400'
          : 'bg-white border-slate-200 hover:border-accent-400 shadow-sm hover:shadow-md'
      }`}
    >
      {/* Preview area with sky image */}
      <div className={`relative overflow-hidden ${compact ? 'h-28 sm:h-auto sm:aspect-[4/3]' : 'h-28 sm:h-48'} ${
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
            <div className="text-center max-w-full px-2">
              <Sparkles className={`${compact ? 'w-6 h-6 sm:w-6 sm:h-6' : 'w-6 h-6 sm:w-10 sm:h-10'} mx-auto mb-1 sm:mb-2 ${isDark ? 'text-accent-500/40' : 'text-accent-400/50'}`} />
              <span className={`block truncate font-display font-bold text-lg ${compact ? 'sm:text-base' : 'sm:text-3xl'} tracking-tight ${
                isDark ? 'text-slate-300' : 'text-slate-600'
              }`}>
                {object.catalogId}
              </span>
            </div>
          )}
        </div>

        {/* Catalog ID badge when image is loaded */}
        {imgLoaded && !imgError && (
          <div className="absolute bottom-1.5 left-2 right-2 sm:bottom-2 sm:left-3 sm:right-3 z-10">
            <span className={`block truncate font-display font-bold text-sm ${compact ? 'sm:text-sm' : 'sm:text-xl'} text-white drop-shadow-lg`}>
              {object.catalogId}
            </span>
          </div>
        )}

        {/* Top-right overlay row: favorite heart, then the processing-status
            pill to its right — same translucent glass idiom as the heart
            button and the telescope dot stack, since this sits over the
            photo, not the card's light/dark body. */}
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); favMutation.mutate({ objectId: object.id, next: !favorited }); }}
            className={`p-1.5 rounded-full bg-black/30 backdrop-blur-sm hover:bg-black/50 transition-all ${
              favorited ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}
            aria-label={favorited ? t('objectCard.removeFromFavorites') : t('objectCard.addToFavorites')}
          >
            <Heart
              className={`w-4 h-4 transition-colors ${favorited ? 'text-rose-500 fill-rose-500' : 'text-white/70'}`}
            />
          </button>
          {/* Only shown once the object has left its default state — a
              permanent "Unprocessed" pill on every untouched card would be
              pure noise, same reasoning the session-count line already
              follows. Always visible (not hover-gated like the heart above):
              this is a status to be seen at a glance, not an action to keep quiet. */}
          {object.processingStatus && object.processingStatus !== 'unprocessed' && (
            <span
              className={`px-2 py-1 rounded-full text-[10px] font-medium leading-none whitespace-nowrap backdrop-blur-sm ring-1 ring-inset ${
                object.processingStatus === 'processing'
                  ? 'bg-amber-500/20 text-amber-300 ring-amber-400/30'
                  : 'bg-emerald-500/20 text-emerald-300 ring-emerald-400/30'
              }`}
            >
              {processingStatusLabel(object.processingStatus, t)}
            </span>
          )}
        </div>

        {/* Telescope dot stack — one dot per telescope that captured this
            object, only rendered when ≥2 telescopes are configured. */}
        {dotEntries.length > 0 && (
          <div
            className="absolute top-2 left-2 z-10 flex items-center gap-0.5 px-1.5 py-1 rounded-full bg-black/40 backdrop-blur-sm"
            title={dotEntries.map(t => t.name).join(', ')}
          >
            {dotEntries.map((t, i) => (
              <span
                key={t.id}
                className="w-1.5 h-1.5 rounded-full ring-1 ring-white/20"
                style={{ backgroundColor: nightSafeColor(t.color, isNight, i) }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <div className={compact ? 'p-2 sm:p-2.5' : 'p-3 sm:p-5'}>
        <h3 className={`font-display font-semibold text-sm ${compact ? 'sm:text-xs' : 'sm:text-lg'} mb-0.5 sm:mb-1 truncate ${
          isDark ? 'text-slate-100' : 'text-slate-900'
        }`}>
          {object.name}
        </h3>
        {alsoKnownAs && !compact && (
          <p className={`hidden sm:block text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`} title={alsoKnownAs}>
            {alsoKnownAs}
          </p>
        )}

        <div className={`${compact ? 'hidden' : 'flex'} flex-wrap items-center gap-1.5 sm:gap-2 mt-2 sm:mt-3 -ml-1.5 sm:-ml-2.5`}>
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-full text-[11px] sm:text-xs font-medium truncate max-w-full ${
            getTypeColor(object.type, isDark)
          }`}>
            {object.type}
          </span>

{((object.sessionCount ?? 0) > 0 || (object.projectArchiveCount ?? 0) > 0) && (
            <span className="ml-auto flex flex-col items-end gap-0.5">
              {object.sessionCount !== undefined && object.sessionCount > 0 && (
                <span className={`inline-flex items-center gap-1 text-xs ${
                  isDark ? 'text-slate-500' : 'text-slate-400'
                }`}>
                  <CalendarDays className="w-3 h-3" />
                  {t('objectCard.observationCount', { count: object.sessionCount })}
                </span>
              )}
              {/* Only shown once a processing project (Siril/PixInsight .zip) has
                  actually been archived for this object — most objects have none,
                  and a permanent "0 projects" line would just be noise. */}
              {(object.projectArchiveCount ?? 0) > 0 && (
                <span className={`inline-flex items-center gap-1 text-xs ${
                  isDark ? 'text-slate-500' : 'text-slate-400'
                }`}>
                  <FileArchive className="w-3 h-3" />
                  {t('objectCard.projectArchiveCount', { count: object.projectArchiveCount })}
                </span>
              )}
            </span>
          )}
        </div>

        {/* Campaign progress ("4h left · D2") for objects with integration
            goals; renders nothing otherwise. Hidden on the compact grid,
            like the metadata row above. */}
        {!compact && (
          <div className="mt-2 flex flex-wrap items-center gap-1 empty:hidden">
            <LibraryIntegrationRemainingChips libraryObjectId={object.id} isDark={isDark} />
          </div>
        )}

      </div>
    </Link>
  );
});
