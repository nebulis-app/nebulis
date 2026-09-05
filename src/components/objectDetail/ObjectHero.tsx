/**
 * The banner at the top of a library object.
 *
 * An object page is the record of a target you keep coming back to, so it opens
 * on the best picture you have of it and the totals that picture cost. The old
 * header set that picture as a 176px square beside a paragraph, with a 176px
 * rail of catalog values ruled off to the right and four equally loud buttons
 * in a row underneath. The picture now gets the room, the catalog values move
 * to a panel where they can be read at body size, and the actions are ranked:
 * one accent button for the thing you came to do, quiet glass for the rest.
 *
 * Built to match the observation hero deliberately: same mat, same ambient
 * blur, same rail. An object and one of its nights should feel like the same
 * page at two scales. Dark in every theme, like every other hero, which is why
 * it takes the bright `accent` hex rather than `accent-*` utilities.
 */
import { Link } from 'react-router-dom';
import { useRef, useState } from 'react';
import {
  CalendarDays, Columns, Download, FolderOpen, Image as ImageIcon, Layers, Loader2, MoreHorizontal,
  Pencil, PlusCircle, Star, Telescope, Trash2,
} from 'lucide-react';
import { useClickOutside } from '../../hooks/useClickOutside';
import { FileLocationModal } from '../library/FileLocationModal';
import { HeroBackdrop } from '../ui/HeroBackdrop';
import { HERO_IMAGES } from '../../lib/heroImagery';
import { CaptureRail } from '../ui/CaptureRail';
import type { CaptureMetric } from '../../lib/captureMetrics';

export interface HeroTelescope {
  id: string;
  name: string;
  color: string;
}

interface Props {
  displayName: string;
  /** Catalog id, type and constellation, in whatever combination is known.
   *  Empty entries are dropped by the caller. */
  eyebrow: string[];
  /** The object's picture: its gallery image, or the catalog's reference shot.
   *  Null while the source is still being resolved, which renders as the mat
   *  with a spinner rather than as "no image". */
  imageSrc: string | null;
  /** True once the source resolved to nothing, or failed twice. */
  imageFailed: boolean;
  /** The picture 404'd. The page owns what happens next (one silent refetch, in
   *  case the file simply moved, then give up), because it owns the query. */
  onImageError: () => void;
  /** Opens the picker that sets which image represents this object. Null for a
   *  viewer who may not change it. */
  onEditImage: (() => void) | null;

  telescopes: HeroTelescope[];
  metrics: CaptureMetric[];
  accent: string;

  isFavorite: boolean;
  onToggleFavorite: () => void;

  onAddObservation: (() => void) | null;
  /** Null when there are fewer than two observations to compare. Rendered as
   *  a disabled button with an explanatory title, not hidden — see
   *  `hideTargetActions` for the case where it should disappear entirely. */
  onCompare: (() => void) | null;
  onCombine: () => void;
  /** Starts the whole-object ZIP download. Async under the hood (mints a signed
   *  URL, then triggers the browser download), so the page owns the pending and
   *  error state — see `downloadPending`. */
  onDownloadAll: () => void;
  downloadPending?: boolean;
  /** Pulls raw sub-frames for every night of this object from the telescope
   *  into the library. Null for a viewer who may not run a sync. */
  onSyncAllSubframes: (() => void) | null;
  /** Opens the planner with this object searched. Null when it has no
   *  coordinates to plan against. */
  onPlan: (() => void) | null;
  onEditDetails: (() => void) | null;
  onDelete: (() => void) | null;
  /** Library object id, for the "Show file location" panel. */
  objectId: string;
  /** True for the synthetic Star Trails object: it isn't a celestial target,
   *  so "Plan a night", "Compare" and "Combine subs" (which all assume one
   *  target shot across nights, with coordinates to plan against) don't apply
   *  and are omitted rather than shown disabled. */
  hideTargetActions?: boolean;
}

/** The height the picture is given. Fixed rather than derived from the image,
 *  so the hero is the same height before and after it loads and a portrait
 *  mosaic does not make the panel taller than a wide one. Matches the
 *  observation hero's steps. Width is deliberately NOT fixed alongside it (see
 *  the column below): a square catalog crop and a 16:9 mosaic both get this
 *  same height and then take only the width their own aspect ratio needs. */
const FRAME_HEIGHT = 'h-[240px] sm:h-[300px] lg:h-[360px]';
/** The same steps as a max, applied to the picture itself. A percentage would
 *  resolve against the shrink-to-fit wrapper, which has no height of its own. */
const FRAME_MAX_HEIGHT = 'max-h-[240px] sm:max-h-[300px] lg:max-h-[360px]';
/** Square footprint for the two states that have no picture to size against
 *  (still loading, or nothing to show): a shrink-wrapped column with nothing
 *  inside it collapses to zero width, and reserving `FRAME_HEIGHT`'s worth of
 *  width keeps the loading spinner from jumping the layout once a wider or
 *  narrower image actually lands. */
const FRAME_PLACEHOLDER = `${FRAME_HEIGHT} aspect-square`;

export function ObjectHero({
  displayName, eyebrow, imageSrc, imageFailed, onImageError, onEditImage,
  telescopes, metrics, accent,
  isFavorite, onToggleFavorite,
  onAddObservation, onCompare, onCombine, onDownloadAll, downloadPending = false, onSyncAllSubframes,
  onPlan, onEditDetails, onDelete,
  objectId, hideTargetActions = false,
}: Props) {
  const [showLocation, setShowLocation] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  // Changing the object's picture swaps the src on the same element, which
  // starts a fresh load while `imgLoaded` still describes the previous one.
  // Keyed on the src so the placeholder comes back for the new picture. Reset
  // during render rather than in an effect, which would paint one frame of the
  // old image at the new size first.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  if (imgLoaded && loadedSrc !== imageSrc) {
    setImgLoaded(false);
    setLoadedSrc(imageSrc);
  }
  const noteLoaded = () => { setImgLoaded(true); setLoadedSrc(imageSrc); };

  const showImage = imageSrc !== null && !imageFailed;

  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel"
    >
      {/* Stock artwork only when the object has no picture of its own: one it
          does have is its own sky and always beats a stand-in. */}
      {!showImage && <HeroBackdrop image={HERO_IMAGES.westerlund} intensity={0.5} />}

      {/* Ambient: the picture itself, thrown far out of focus, so the panel
          takes its colour from the target and a narrow frame leaves no dead
          slab beside it. */}
      {showImage && (
        <img
          src={imageSrc}
          alt=""
          aria-hidden="true"
          className={`absolute inset-0 h-full w-full scale-[1.6] object-cover blur-[64px] saturate-150
            transition-opacity duration-700 ${imgLoaded ? 'opacity-55' : 'opacity-0'}`}
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-slate-950/60" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/75 to-slate-950/45" />
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{ background: `radial-gradient(80% 120% at 88% 10%, ${accent}1f 0%, transparent 65%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-3xl"
        style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }}
      />

      <div className="relative flex flex-col gap-5 p-5 sm:p-7">
        {/* Full-width row above the picture and text columns, so it sits at
            the true upper-left of the panel rather than starting wherever
            the text column happens to start (which, beside a wide picture,
            was well right of the panel's own left edge). */}
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
          <Link to="/" className="text-white/45 transition hover:text-white">Library</Link>
          <span className="text-white/20">/</span>
          <span className="truncate text-white/70">{displayName}</span>
        </nav>

        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:gap-9">
        {/* The picture, standing on the panel rather than sitting in a box.
            It was a bordered mat with the picture shadowed inside it, which on
            a wide export read as a frame inside a frame: the mat's ring drew
            one rectangle and the picture's own edge drew a second, with a band
            of dead surface between them.

            The column used to be a fixed 52% of the hero regardless of the
            picture's own shape, which left a dead band of empty panel between
            a square or portrait picture and the text next to it — fixing the
            frame-in-a-frame look just moved the same "why is there a box of
            nothing here" problem from around the picture to beside it. On
            `lg` the column now shrinks to whatever width the picture actually
            renders at (capped so a panoramic mosaic can't crowd out the
            text), so the gap the text starts at follows the picture's real
            edge instead of a fraction that assumes a particular aspect
            ratio. Below `lg` it stays full width: stacked above the text,
            there is no "beside it" gap to create. */}
        <div className="w-full shrink-0 lg:w-auto lg:max-w-[58%]">
          <div className={`flex ${FRAME_HEIGHT} w-full items-center justify-center lg:w-auto`}>
            {showImage ? (
              <>
                {!imgLoaded && (
                  <div className={`flex ${FRAME_PLACEHOLDER} items-center justify-center`}>
                    <Loader2 className="h-5 w-5 animate-spin text-white/40" />
                  </div>
                )}
                <div className={`group relative items-center justify-center ${imgLoaded ? 'flex max-w-full' : 'hidden'}`}>
                  <img
                    src={imageSrc}
                    alt={displayName}
                    onLoad={noteLoaded}
                    // Deliberately does NOT call noteLoaded(): that would flip
                    // the wrapper from the loading placeholder to this <img>
                    // element while it is still broken, and a broken <img> with
                    // no forced box renders as the browser's tiny native icon.
                    // The placeholder keeps showing (spinning) until the page's
                    // retry either lands a working src (a real onLoad follows)
                    // or gives up and imageFailed flips true, which routes
                    // rendering to the "No image yet" branch instead.
                    onError={onImageError}
                    className={`${FRAME_MAX_HEIGHT} max-w-full rounded-xl object-contain`}
                    // A hard rectangle with a drop shadow read as a photo pasted
                    // onto the panel. This dissolves the picture's own edges into
                    // it instead: the ambient blurred copy behind the whole hero
                    // (above) is already the same picture, so fading into it
                    // reads as one continuous surface rather than two stacked
                    // layers. The ellipse's default (farthest-corner) sizing
                    // means the fade barely touches the actual top/bottom/left/
                    // right edges — corners are where a hard rectangle reads as
                    // "pasted on", so that is where nearly all of the fade lands.
                    // Framing detail near an edge is never hidden, only the
                    // geometric corners are. `rounded-xl` is kept as the fallback
                    // shape for the rare engine that ignores mask-image.
                    style={{
                      maskImage: 'radial-gradient(ellipse at center, black 78%, transparent 100%)',
                      WebkitMaskImage: 'radial-gradient(ellipse at center, black 78%, transparent 100%)',
                    }}
                  />

                  {/* An explicit button rather than making the whole picture a
                      hidden edit target: clicking a photograph should not
                      silently open a file picker. */}
                  {onEditImage && (
                    <button
                      onClick={onEditImage}
                      title="Choose the image that represents this object"
                      className="absolute right-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-lg bg-black/45 px-2.5 py-1.5
                        text-[11px] font-medium text-white opacity-0 backdrop-blur-md transition hover:bg-black/70
                        group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none
                        focus-visible:ring-2 focus-visible:ring-white/70"
                    >
                      <Pencil className="h-3 w-3" />
                      Change image
                    </button>
                  )}
                </div>
              </>
            ) : imageSrc === null ? (
              <div className={`flex ${FRAME_PLACEHOLDER} items-center justify-center`}>
                <Loader2 className="h-5 w-5 animate-spin text-white/40" />
              </div>
            ) : (
              // Nothing to stand on the panel, so the empty state supplies its
              // own surface. This is the one case a box is right: it says the
              // picture is missing rather than leaving a hole.
              <div className={`flex ${FRAME_PLACEHOLDER} flex-col items-center justify-center gap-2.5
                rounded-2xl bg-white/[0.03] ring-1 ring-inset ring-white/10`}>
                <ImageIcon className="h-8 w-8 text-white/20" />
                <p className="text-sm font-medium text-white/50">No image yet</p>
                {onEditImage && (
                  <button
                    onClick={onEditImage}
                    className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5
                      text-[11px] font-medium text-white/80 ring-1 ring-inset ring-white/15 transition
                      hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2
                      focus-visible:ring-white/70"
                  >
                    <Pencil className="h-3 w-3" />
                    Choose an image
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Identity and actions. Top-anchored (lg:self-start) rather than
            centred against the picture: on a tall portrait image (any
            Seestar stack) centring stranded the eyebrow/title mid-picture
            instead of at the top where they belong. Matches SessionHero's
            identical fix. */}
        <div className="flex min-w-0 flex-1 flex-col gap-5 lg:self-start">
            <div className="min-w-0">
              {eyebrow.length > 0 && (
                <div className="truncate text-[11px] font-medium uppercase tracking-[0.18em] text-white/50">
                  {eyebrow.join(' · ')}
                </div>
              )}

              <div className="mt-1.5 flex items-start gap-3">
                <h1 className="font-display min-w-0 text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-[42px] lg:leading-[1.05]">
                  {displayName}
                </h1>
                <button
                  onClick={onToggleFavorite}
                  aria-pressed={isFavorite}
                  title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                  className="mt-1 shrink-0 rounded-full p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  <Star
                    className={`h-5 w-5 ${isFavorite ? 'fill-amber-400 text-amber-400' : ''}`}
                  />
                </button>
              </div>

              {telescopes.length > 0 && (
                <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-white/65">
                  <span className="inline-flex items-center gap-1.5">
                    <Telescope className="h-3.5 w-3.5 text-white/40" />
                    {/* Which telescopes have been on this target. A target shot on
                        two rigs is worth knowing about before comparing nights. */}
                    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                      {telescopes.map(t => (
                        <span key={t.id} className="inline-flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.color }} />
                          {t.name}
                        </span>
                      ))}
                    </span>
                  </span>
                </div>
              )}
            </div>

          <div className="flex flex-wrap items-center gap-2">
            {onAddObservation && (
              <button
                onClick={onAddObservation}
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold text-slate-950
                  transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                style={{ background: accent, boxShadow: `0 8px 24px -12px ${accent}` }}
              >
                <PlusCircle className="h-4 w-4" />
                Add observation
              </button>
            )}
            {!hideTargetActions && onPlan && (
              <HeroAction onClick={onPlan} icon={CalendarDays} label="Plan a night"
                title="Open the planner with this object" />
            )}
            {!hideTargetActions && (
              <HeroAction
                onClick={onCompare ?? undefined}
                icon={Columns}
                label="Compare"
                title={onCompare ? 'Compare two observations of this object' : 'Needs two or more observations'}
              />
            )}
            {!hideTargetActions && (
              <HeroAction onClick={onCombine} icon={Layers} label="Combine subs"
                title="Combine sub-frames from several nights and download the set" />
            )}
            <HeroAction onClick={downloadPending ? undefined : onDownloadAll} icon={Download}
              label={downloadPending ? 'Preparing…' : 'Download'}
              title="Download every file for this object" />

            {/* Editing the catalog entry and deleting the object are neither
                frequent nor reversible, so they do not sit at the same weight as
                Download. Behind one button, and only for someone who may use
                them. "Show file location" rides along in the same menu. */}
            <OverflowMenu
              onEditDetails={onEditDetails}
              onDelete={onDelete}
              onShowLocation={() => setShowLocation(true)}
              onSyncAllSubframes={hideTargetActions ? null : onSyncAllSubframes}
            />
          </div>
        </div>
        </div>
      </div>

      <CaptureRail metrics={metrics} accent={accent} />

      {showLocation && (
        <FileLocationModal
          objectId={objectId}
          displayName={displayName}
          onClose={() => setShowLocation(false)}
        />
      )}
    </section>
  );
}

/** The rarely-used, hard-to-undo actions. Drops back onto a solid surface once
 *  open: a translucent menu over a photograph is unreadable. */
function OverflowMenu({ onEditDetails, onDelete, onShowLocation, onSyncAllSubframes }: {
  onEditDetails: (() => void) | null;
  onDelete: (() => void) | null;
  onShowLocation: () => void;
  onSyncAllSubframes: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useClickOutside(wrapRef, () => setOpen(false), { enabled: open, closeOnEscape: true });

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        className="inline-flex items-center gap-2 rounded-full bg-white/[0.07] px-3 py-2 text-[13px] font-medium
          text-white/85 ring-1 ring-inset ring-white/15 backdrop-blur-md transition-colors hover:bg-white/15
          hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <MoreHorizontal className="h-4 w-4" />
        <span className="sr-only">More actions</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 w-52 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-2xl"
        >
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onShowLocation(); }}
            className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-slate-200 transition hover:bg-slate-800"
          >
            <FolderOpen className="h-3.5 w-3.5 text-slate-400" />
            Show file location
          </button>
          {onSyncAllSubframes && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onSyncAllSubframes(); }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-slate-200 transition hover:bg-slate-800"
            >
              <Layers className="h-3.5 w-3.5 text-slate-400" />
              Sync all sub-frames
            </button>
          )}
          {onEditDetails && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onEditDetails(); }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-slate-200 transition hover:bg-slate-800"
            >
              <Pencil className="h-3.5 w-3.5 text-slate-400" />
              Edit object details
            </button>
          )}
          {onDelete && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onDelete(); }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-red-300 transition hover:bg-red-500/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete object
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The quiet action style shared with the observation hero: glass on the panel,
 * never a second accent button competing with the primary one. Renders an
 * anchor when given an href, since a download must be a real link.
 */
function HeroAction({ onClick, href, icon: Icon, label, title, danger }: {
  onClick?: () => void;
  href?: string;
  icon: typeof Columns;
  label: string;
  title: string;
  danger?: boolean;
}) {
  const disabled = !onClick && !href;
  const className = `inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-medium
    ring-1 ring-inset backdrop-blur-md transition-colors
    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
    disabled
      ? 'cursor-not-allowed bg-white/[0.03] text-white/30 ring-white/10'
      : danger
        ? 'bg-red-500/10 text-red-300 ring-red-400/25 hover:bg-red-500/20 hover:text-red-200'
        : 'bg-white/[0.07] text-white/85 ring-white/15 hover:bg-white/15 hover:text-white'
  }`;

  if (href) {
    return (
      <a href={href} title={title} className={className}>
        <Icon className="h-4 w-4" />
        {label}
      </a>
    );
  }

  return (
    <button onClick={onClick} title={title} aria-disabled={disabled} className={className}>
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
