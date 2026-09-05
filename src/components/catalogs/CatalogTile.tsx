/**
 * One object in a catalog board grid.
 *
 * Imaged objects are shown in full colour inside an accent frame. Un-imaged
 * ones sit desaturated and dim, and come up to full colour on hover, so a
 * board reads at a glance as "what I have caught" against "what is still out
 * there" without either state being invisible.
 */
import { memo } from 'react';
import { getCatalogStaticThumbnailUrl, getCatalogThumbnailUrl } from '../../lib/catalogImage';
import type { CatalogProgressObject } from '../../lib/api/catalogs';
import { Check } from 'lucide-react';

interface Props {
  object: CatalogProgressObject;
  isDark: boolean;
  /**
   * Theme accent as a colour value. Passed in rather than taken from a
   * utility class because only a fixed whitelist of accent-* classes is
   * re-mapped for the night and space themes.
   */
  accent: string;
  /** Takes the object id, not a bound callback, so the board can pass its
   *  setState setter directly — a stable reference `memo` can actually rely
   *  on, instead of a fresh arrow that would re-render every tile whenever
   *  the board re-renders (as-typed on a 400-object catalog like Herschel 400). */
  onSelect: (id: string) => void;
}

export const CatalogTile = memo(function CatalogTile({ object, isDark, accent, onSelect }: Props) {
  const staticUrl = getCatalogStaticThumbnailUrl(object.id);
  const apiUrl = getCatalogThumbnailUrl(object.id, object.majorAxisArcmin);
  const imaged = object.isImaged;

  // Secondary line: prefer the common name, fall back to the object type.
  const subtitle = object.name !== object.id ? object.name : object.type;

  return (
    <button
      onClick={() => onSelect(object.id)}
      className={`group relative aspect-square overflow-hidden rounded-2xl bg-slate-950 text-left
        transition-transform duration-300 ease-out hover:-translate-y-1
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
        ${isDark ? 'focus-visible:ring-offset-slate-950' : 'focus-visible:ring-offset-slate-50'}
        focus-visible:ring-accent-500/40`}
      style={{ boxShadow: imaged ? `0 14px 30px -18px ${accent}b3` : '0 10px 24px -20px rgba(0,0,0,0.9)' }}
      aria-label={`${object.id}, ${object.name}${imaged ? ', imaged' : ', not yet imaged'}`}
    >
      <img
        src={staticUrl}
        onError={(e) => {
          const img = e.currentTarget;
          if (img.src !== apiUrl) img.src = apiUrl;
        }}
        alt=""
        aria-hidden="true"
        loading="lazy"
        className={`w-full h-full object-cover transition-all duration-500 ease-out group-hover:scale-[1.08]
          ${imaged
            ? 'saturate-110 group-hover:brightness-110'
            : 'saturate-0 opacity-50 group-hover:saturate-100 group-hover:opacity-95'
          }`}
      />

      {/* Scrim: holds the label legible over any sky field */}
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/25 to-transparent" />

      {/* Frame. Accent for imaged, a quiet hairline otherwise, warming on hover. */}
      <div
        className="absolute inset-0 rounded-2xl pointer-events-none transition-all duration-300"
        style={{
          boxShadow: imaged
            ? `inset 0 0 0 1.5px ${accent}, inset 0 0 22px -8px ${accent}`
            : `inset 0 0 0 1px rgba(255,255,255,${isDark ? 0.10 : 0.16})`,
        }}
      />
      {!imaged && (
        <div
          className="absolute inset-0 rounded-2xl pointer-events-none opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{ boxShadow: `inset 0 0 0 1.5px ${accent}80` }}
        />
      )}

      {/* Imaged badge */}
      {imaged && (
        <div
          className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full"
          style={{ background: accent, boxShadow: `0 0 14px -2px ${accent}` }}
        >
          <Check className="w-3.5 h-3.5 text-slate-950" strokeWidth={3.5} />
        </div>
      )}

      {/* Magnitude, kept out of the way until the tile is hovered */}
      {object.magnitude != null && (
        <div className="absolute top-2 left-2 rounded-full bg-slate-950/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white/80 opacity-0 ring-1 ring-inset ring-white/15 backdrop-blur-md transition-opacity duration-300 group-hover:opacity-100">
          mag {object.magnitude.toFixed(1)}
        </div>
      )}

      {/* Label */}
      <div className="absolute inset-x-0 bottom-0 p-2.5">
        <div className="flex items-baseline gap-1.5">
          <span
            className="font-display text-[13px] font-bold leading-none tracking-wide"
            style={{ color: imaged ? accent : 'rgba(255,255,255,0.92)' }}
          >
            {object.id}
          </span>
          {object.constellation && (
            <span className="ml-auto truncate text-[10px] uppercase tracking-wider text-white/45">
              {object.constellation}
            </span>
          )}
        </div>
        <div className={`mt-1 truncate text-[11px] leading-tight ${imaged ? 'text-white/85' : 'text-white/55'}`}>
          {subtitle}
        </div>
        {imaged && object.sessionCount > 0 && (
          <div className="mt-1 text-[10px] tabular-nums text-white/45">
            {object.sessionCount} {object.sessionCount === 1 ? 'session' : 'sessions'}
          </div>
        )}
      </div>
    </button>
  );
});
