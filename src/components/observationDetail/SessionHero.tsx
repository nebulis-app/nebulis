/**
 * The banner at the top of an observation.
 *
 * An observation page is, first, a picture you went outside and earned. The old
 * layout put that picture in a small bordered card capped at 420px and set it
 * beside a column of 10px labels, so the thing the page exists for competed
 * with its own metadata. Here the frame gets the room, and everything that
 * describes it sits on the same dark panel: where you are, what it is, when you
 * shot it, what it cost, and the three actions that operate on the session.
 *
 * The panel is dark in every theme, matching the Catalogs panels and the
 * Planner's night hero: it is a photograph of the night sky, so the page around
 * it stays theme-driven while this stays night-side. That is also why it takes
 * the bright `accent` hex directly instead of `accent-*` utilities, which
 * light mode darkens for a light surface this panel does not have.
 *
 * Orientation is handled by the layout rather than measured. The frame is
 * `object-contain` inside a height cap, so a tall Seestar stack simply comes
 * out narrower than a wide Dwarf one and the text column takes the width it
 * gives up. A blurred copy of the same frame fills the panel behind everything,
 * which is what keeps a portrait image from reading as a ribbon stranded in a
 * wide box. Nothing is ever cropped: cropping an astro frame hides the framing
 * the observer is checking.
 */
import { Link } from 'react-router-dom';
import { useState } from 'react';
import {
  Calendar,
  Clock,
  Crown,
  FileImage,
  Film,
  FolderOpen,
  Layers,
  Loader2,
  Merge,
  NotebookPen,
  Pencil,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { FitsPreview } from '../FitsPreview';
import { FileLocationModal } from '../library/FileLocationModal';
import { HeroBackdrop } from '../ui/HeroBackdrop';
import { HERO_IMAGES } from '../../lib/heroImagery';
import { TelescopeChip } from './TelescopeChip';
import { CaptureRail } from '../ui/CaptureRail';
import type { TelescopeProfile } from '../../lib/api/telescopes';

/** What is actually being shown as the session's picture. */
export type HeroMedia =
  | { kind: 'image'; src: string; alt: string; onEdit: () => void }
  | { kind: 'fits'; url: string }
  // A lunar/planetary session that produced only video. The frame plays it
  // inline; `playable` is false for containers no browser decodes (AVI), which
  // fall back to a "download to play" card.
  | { kind: 'video'; src: string; playable: boolean; onOpen: () => void }
  | null;

/** Which of the ways the picture got chosen, since they mean different things:
 *  a crown is deliberate, the rest are the page's own pick. */
export type HeroBadge =
  | { tone: 'crown'; text: string }
  | { tone: 'processed'; text: string }
  | { tone: 'stacked'; text: string }
  | { tone: 'video'; text: string }
  | null;

interface Props {
  objectId: string;
  date: string;
  displayName: string;
  /** Long form, e.g. "Monday, March 30, 2026". */
  formattedDate: string;
  /** Compact form for the breadcrumb, e.g. "Mar 30, 2026". The trail is
   *  navigation, not a fact sheet, and spelling the night out twice in two
   *  lines of each other reads as a mistake. */
  shortDate: string;
  /** Already formatted "20:14" / "20:14 - 23:41", or null when unrecorded. */
  timeRange: string | null;
  /** Catalog id, object type and constellation, in whatever combination the
   *  catalog actually knows. Empty entries are dropped by the caller. */
  eyebrow: string[];

  media: HeroMedia;
  badge: HeroBadge;
  /** Opens the picture in the full-screen viewer. */
  onOpenMedia: () => void;
  /** Clears an explicit crown. Null when there is nothing to clear, or the
   *  viewer is not allowed to. */
  onResetCrown: (() => void) | null;
  /** Why the session has no picture, e.g. "Raw FITS frames only". */
  emptyReason: string;

  telescope: TelescopeProfile | null;
  telescopes: TelescopeProfile[];
  isAdmin: boolean;

  captureMetrics: React.ComponentProps<typeof CaptureRail>['metrics'];
  accent: string;

  onOpenNotes: (() => void) | null;
  hasNote: boolean;
  onCombine: (() => void) | null;
  onDelete: (() => void) | null;
}

/** Height of the frame's mat. Fixed rather than derived from the picture, so
 *  the panel is the same size before and after the image loads and either
 *  orientation sits on the same mat. The identity column matches its `lg` step
 *  (see below) to line its top and bottom up with the frame's. */
const FRAME_HEIGHT = 'h-[260px] sm:h-[330px] lg:h-[420px]';
/** Same steps as FRAME_HEIGHT. FitsPreview draws into a canvas inside its own
 *  auto-height wrapper, so a percentage cap there resolves to nothing; it needs
 *  the pixel values spelled out. */
const FRAME_MAX_HEIGHT = 'max-h-[260px] sm:max-h-[330px] lg:max-h-[420px]';
/** Square footprint for the one state that has no picture to size against —
 *  see FRAME_PLACEHOLDER in ObjectHero for the full reasoning, which this
 *  mirrors exactly: a shrink-wrapped column with nothing to shrink around
 *  collapses to zero width. */
const FRAME_PLACEHOLDER = `${FRAME_HEIGHT} aspect-square`;
/** Same corner-only fade as ObjectHero's picture, and for the same reason:
 *  matched deliberately so an object and one of its nights read as the same
 *  design system rather than two different treatments of "a picture in a dark
 *  panel". See the comment on the `<img>` below for how the percentage was
 *  chosen. Not applied to the FITS canvas — see the FITS branch below. */
const FRAME_FADE_MASK = 'radial-gradient(ellipse at center, black 78%, transparent 100%)';

const BADGE_TONE = {
  crown: { icon: Crown, className: 'bg-amber-500/90 text-white' },
  processed: { icon: Sparkles, className: 'bg-white/15 text-white ring-1 ring-inset ring-white/25' },
  stacked: { icon: Layers, className: 'bg-white/15 text-white ring-1 ring-inset ring-white/25' },
  video: { icon: Film, className: 'bg-white/15 text-white ring-1 ring-inset ring-white/25' },
} as const;

export function SessionHero({
  objectId, date, displayName, formattedDate, shortDate, timeRange, eyebrow,
  media, badge, onOpenMedia, onResetCrown, emptyReason,
  telescope, telescopes, isAdmin,
  captureMetrics, accent,
  onOpenNotes, hasNote, onCombine, onDelete,
}: Props) {
  const [showLocation, setShowLocation] = useState(false);
  /** A plain `<img>` reserves no space until it loads, so without a
   *  fixed-size placeholder the hero collapses to nothing and then jumps to
   *  full height, shoving the tabs and file grid down. That jump landing while
   *  someone is mid-scroll is what reads as the page jittering. */
  const [imgLoaded, setImgLoaded] = useState(false);
  const ambientSrc = media?.kind === 'image' ? media.src : null;
  // Crowning a different file swaps the src on the same element, which starts a
  // fresh load while `imgLoaded` still says the previous one finished. Keyed on
  // the src so the placeholder comes back for the new picture. State reset
  // during render rather than in an effect: an effect would paint one frame of
  // the old image at the new size first.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  if (imgLoaded && loadedSrc !== ambientSrc) {
    setImgLoaded(false);
    setLoadedSrc(ambientSrc);
  }
  const noteLoaded = () => { setImgLoaded(true); setLoadedSrc(ambientSrc); };

  /**
   * Width/height of a FITS frame, learned once `renderFitsToCanvas` has
   * actually decoded it. `onNaturalSize` already existed on FitsPreview for
   * exactly this ("Lets the hero slot size its column to the frame's
   * orientation") but nothing consumed it, which is why the column below used
   * to be a fixed percentage regardless of what shape the frame actually was.
   *
   * Unlike the image case, FitsPreview manages its own loading/error UI
   * internally (a spinner, then either the canvas or its own error message),
   * so there is nothing here to gate on: the card is always shown, and its
   * width simply snaps once from the square default to the frame's real
   * aspect ratio.
   */
  const [fitsAspect, setFitsAspect] = useState<number | null>(null);
  const fitsUrl = media?.kind === 'fits' ? media.url : null;
  const [fitsAspectFor, setFitsAspectFor] = useState<string | null>(null);
  if (fitsAspectFor !== fitsUrl) {
    if (fitsAspect !== null) setFitsAspect(null);
    setFitsAspectFor(fitsUrl);
  }

  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel"
    >
      {/* Only when the session has no picture of its own: a session that does
          gets its ambient from the frame below, which is its own sky and always
          beats stock artwork. Pitched high because this panel then lays its own
          scrims over the top of the ones the backdrop already carries. */}
      {(!media || media.kind === 'video') && <HeroBackdrop image={HERO_IMAGES['southern-ring']} intensity={0.72} />}

      {/* Ambient: the frame itself, thrown far out of focus. Every observation
          brings its own colour to the panel this way, and a narrow frame no
          longer leaves a dead slab of background beside it. */}
      {ambientSrc && (
        <img
          src={ambientSrc}
          alt=""
          aria-hidden="true"
          // Scaled well past the panel so the blur's own soft edge is cropped
          // away; left at 100% it feathers to transparent inside the panel and
          // the ambient reads as a rectangle floating on the background.
          className={`absolute inset-0 h-full w-full scale-[1.6] object-cover blur-[64px] saturate-150
            transition-opacity duration-700 ${imgLoaded ? 'opacity-55' : 'opacity-0'}`}
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-slate-950/60" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/75 to-slate-950/45" />
      {/* On a narrow portrait frame the identity column (now capped below,
          see lg:max-w-xl) leaves a wide slab of panel that carries nothing
          but this glow. Sized to bloom across that whole region rather than
          just the top-right corner, so it reads as deliberate atmosphere
          instead of unused space. Still subtle enough to sit behind the
          white text without competing with it. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: `radial-gradient(90% 140% at 72% 42%, ${accent}26 0%, transparent 70%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-3xl"
        style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }}
      />

      <div className="relative flex flex-col gap-5 p-5 sm:p-7">
        {/* Full-width row above the picture and text columns, so it sits at
            the true upper-left of the panel rather than starting wherever
            the text column happens to start. Matches ObjectHero's identical
            fix. */}
        <div className="flex items-start justify-between gap-3">
          <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
            <Link to="/observations" className="text-white/45 transition hover:text-white">
              Observations
            </Link>
            <span className="text-white/20">/</span>
            <Link
              to={`/object/${encodeURIComponent(objectId)}`}
              className="truncate text-white/45 transition hover:text-white"
            >
              {displayName}
            </Link>
            <span className="text-white/20">/</span>
            <span className="text-white/70">{shortDate}</span>
          </nav>

          <button
            onClick={() => setShowLocation(true)}
            title="Show where this session's files live on disk"
            className="-m-1 shrink-0 rounded-lg p-1 text-white/40 transition hover:bg-white/10 hover:text-white
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <FolderOpen className="h-4 w-4" />
            <span className="sr-only">File location</span>
          </button>
        </div>

        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:gap-9">
        {/* The frame. Matches ObjectHero's picture deliberately, down to the
            reasoning: the column used to be a fixed 56% regardless of the
            frame's own shape, which on a portrait stack (any Seestar image is
            taller than wide) left a dead band of bare panel on either side of
            the actual picture — and stranded the badge in that gap instead of
            on the picture's own corner, since the badge is positioned against
            this wrapper's box. On `lg` the column now shrinks to whatever
            width the frame actually renders at (capped so a wide mosaic can't
            crowd the identity column out), so the badge, the edit button and
            the reset button all land on the picture's real edge again. Below
            `lg` it stays full width: stacked above the text, there is no
            "beside it" gap to create. */}
        <div className="w-full shrink-0 lg:w-auto lg:max-w-[58%]">
          <div className={`flex ${FRAME_HEIGHT} w-full items-center justify-center lg:w-auto`}>
            {media && media.kind === 'video' ? (
              <div className={`relative flex aspect-video h-full max-w-full items-center justify-center
                overflow-hidden rounded-2xl bg-black ring-1 ring-inset ring-white/10 ${FRAME_MAX_HEIGHT}`}>
                {media.playable ? (
                  <video
                    controls
                    preload="metadata"
                    playsInline
                    src={media.src}
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <button
                    onClick={media.onOpen}
                    className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-white/50
                      transition hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                  >
                    <Film className="h-8 w-8" />
                    <span className="text-xs font-medium">Video capture. Open the Videos tab to play or download.</span>
                  </button>
                )}
                {badge && <Badge badge={badge} />}
              </div>
            ) : media ? (
              <>
                {media.kind === 'image' && !imgLoaded && (
                  <div className={`flex ${FRAME_PLACEHOLDER} items-center justify-center`}>
                    <Loader2 className="h-5 w-5 animate-spin text-white/40" />
                  </div>
                )}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={onOpenMedia}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenMedia(); }
                  }}
                  aria-label={`Open ${displayName} full screen`}
                  // The old ring + dark mat behind the picture was the other
                  // half of the "frame inside a frame" look: it drew a second,
                  // larger rectangle around the picture's own edge. Removed for
                  // the same reason as the hard shadow below — cursor-zoom-in
                  // plus the focus ring is enough to say this is clickable once
                  // there is no dead margin around the picture for the ring to
                  // fill.
                  // overflow-hidden + rounded-2xl stay on this wrapper (not the
                  // picture itself) because FitsPreview's canvas has no
                  // border-radius of its own — without a clipping parent a FITS
                  // frame would render with square corners while the JPG case
                  // (rounded on the <img> directly) had rounded ones.
                  className={`group relative items-center justify-center overflow-hidden rounded-2xl
                    outline-none transition focus-visible:ring-2 focus-visible:ring-white/70 cursor-zoom-in
                    ${media.kind === 'fits' || imgLoaded ? 'flex max-w-full' : 'hidden'}`}
                  style={media.kind === 'fits' ? { height: '100%', aspectRatio: fitsAspect ?? 1 } : undefined}
                >
                  {media.kind === 'fits' ? (
                    // No corner fade here: FitsPreview owns its own canvas, and
                    // a raw sub-frame is a scientific readout rather than a
                    // photograph, so a crisp edge suits it. See FRAME_FADE_MASK.
                    <FitsPreview
                      url={media.url}
                      isDark
                      maxHeightClass={FRAME_MAX_HEIGHT}
                      onNaturalSize={(w, h) => setFitsAspect(w / h)}
                    />
                  ) : (
                    <img
                      src={media.src}
                      alt={media.alt}
                      onLoad={noteLoaded}
                      // A failed load (404, network error) never fires onLoad.
                      // Without this the spinner would turn forever instead of
                      // falling back to the browser's broken-image state.
                      onError={noteLoaded}
                      className={`${FRAME_MAX_HEIGHT} max-w-full rounded-xl object-contain`}
                      // A hard rectangle with a drop shadow read as a photo
                      // pasted onto the panel. This dissolves the picture's own
                      // edges into the ambient blurred copy of itself behind the
                      // whole hero instead, so it reads as one continuous
                      // surface. Matches ObjectHero's picture exactly — see the
                      // comment there for how the 78% was chosen (it barely
                      // touches the actual edges; it is almost entirely the four
                      // corners, so no framing detail is hidden).
                      style={{ maskImage: FRAME_FADE_MASK, WebkitMaskImage: FRAME_FADE_MASK }}
                    />
                  )}

                  {badge && <Badge badge={badge} />}

                  {media.kind === 'image' && (
                    <button
                      onClick={e => { e.stopPropagation(); media.onEdit(); }}
                      className="absolute right-2.5 top-2.5 rounded-lg bg-black/45 p-1.5 text-white opacity-0
                        backdrop-blur-md transition hover:bg-black/70 group-hover:opacity-100
                        focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                      title="Edit image"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}

                  {onResetCrown && (
                    <button
                      onClick={e => { e.stopPropagation(); onResetCrown(); }}
                      className="absolute bottom-2.5 left-2.5 rounded-full bg-black/45 px-2.5 py-1 text-[11px]
                        font-medium text-white/70 opacity-0 backdrop-blur-md transition hover:text-white
                        group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none
                        focus-visible:ring-2 focus-visible:ring-white/70"
                      title="Clear the session image and go back to the stacked frame"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className={`flex ${FRAME_PLACEHOLDER} flex-col items-center justify-center gap-3
                rounded-2xl bg-white/[0.03] ring-1 ring-inset ring-white/10`}>
                <FileImage className="h-8 w-8 text-white/20" />
                <div className="space-y-1 text-center">
                  <p className="text-sm font-medium text-white/50">No stacked image</p>
                  <p className="text-xs text-white/30">{emptyReason}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Identity: what this is, and what you can do to it. Top-anchored
            (lg:self-start) rather than centred against the frame: the parent
            row's lg:items-center exists so a short landscape frame doesn't
            strand this column at the top with a canyon of empty panel below
            the actions, but on a tall portrait frame (any Seestar stack)
            centring instead stranded the eyebrow/title mid-picture. Pinning
            just this column to the top keeps the header where it belongs
            regardless of the frame's aspect ratio. Deliberately not
            width-capped: nothing inside stretches to fill flex-1 (h1 and the
            action row are all natural-width and left-aligned already), so a
            max-w here would only risk truncating a long object name earlier
            than necessary — the `truncate` on the eyebrow needs this
            column's real width to size against. The empty space beside a
            narrow frame is a glow problem, not a column-width problem; see
            the backdrop gradient above. */}
        <div className="flex min-w-0 flex-1 flex-col gap-5 lg:self-start">
            <div className="min-w-0">
            {eyebrow.length > 0 && (
              <div className="truncate text-[11px] font-medium uppercase tracking-[0.18em] text-white/50">
                {eyebrow.join(' · ')}
              </div>
            )}

            <h1 className="font-display mt-1.5 text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-[42px] lg:leading-[1.05]">
              {displayName}
            </h1>

            <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-white/65">
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-white/40" />
                {formattedDate}
              </span>
              {timeRange && (
                <span className="inline-flex items-center gap-1.5 tabular-nums">
                  <Clock className="h-3.5 w-3.5 text-white/40" />
                  {timeRange}
                </span>
              )}
              {telescope && (
                <TelescopeChip
                  objectId={objectId}
                  date={date}
                  telescope={telescope}
                  telescopes={telescopes}
                  isAdmin={isAdmin}
                />
              )}
            </div>
          </div>

          {(onOpenNotes || onCombine || onDelete) && (
            <div className="flex flex-wrap items-center gap-2">
              {onOpenNotes && (
                <HeroAction
                  onClick={onOpenNotes}
                  icon={NotebookPen}
                  label={hasNote ? 'Session notes' : 'Add notes'}
                  title={isAdmin ? (hasNote ? 'Edit session notes' : 'Add session notes') : 'View session notes'}
                  dotColor={hasNote ? accent : undefined}
                />
              )}
              {onCombine && (
                <HeroAction
                  onClick={onCombine}
                  icon={Merge}
                  label="Combine"
                  title="Combine this session with another object's observation"
                />
              )}
              {onDelete && (
                <HeroAction
                  onClick={onDelete}
                  icon={Trash2}
                  label="Delete"
                  title="Delete observation"
                  danger
                />
              )}
            </div>
          )}
        </div>
        </div>
      </div>

      <CaptureRail metrics={captureMetrics} accent={accent} />

      {showLocation && (
        <FileLocationModal
          objectId={objectId}
          date={date}
          displayName={displayName}
          onClose={() => setShowLocation(false)}
        />
      )}
    </section>
  );
}

function Badge({ badge }: { badge: NonNullable<HeroBadge> }) {
  const { icon: Icon, className } = BADGE_TONE[badge.tone];
  return (
    <div
      className={`absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-md px-2 py-1
        text-[11px] font-semibold shadow backdrop-blur-md ${className}`}
    >
      <Icon className="h-3 w-3" />
      {badge.text}
    </div>
  );
}

function HeroAction({ onClick, icon: Icon, label, title, danger, dotColor }: {
  onClick: () => void;
  icon: typeof NotebookPen;
  label: string;
  title: string;
  danger?: boolean;
  /** Small filled dot, used to say a note already exists. */
  dotColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-medium
        ring-1 ring-inset backdrop-blur-md transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
        danger
          ? 'bg-red-500/10 text-red-300 ring-red-400/25 hover:bg-red-500/20 hover:text-red-200'
          : 'bg-white/[0.07] text-white/85 ring-white/15 hover:bg-white/15 hover:text-white'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
      {dotColor && (
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: dotColor }} aria-hidden="true" />
      )}
    </button>
  );
}
