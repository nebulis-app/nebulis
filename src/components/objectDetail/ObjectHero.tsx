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
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  CalendarDays, ChevronDown, Columns, Download, FolderOpen, Frame, Image as ImageIcon, Layers, Loader2, MoreHorizontal,
  LayoutGrid, PackageCheck, Pencil, PlusCircle, RefreshCw, Shuffle, Star, Telescope, Trash2,
} from 'lucide-react';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useImageFocalPoint } from '../../hooks/useImageFocalPoint';
import { FileLocationModal } from '../ui/FileLocationModal';
import { DownloadConfirmModal } from './DownloadConfirmModal';
import { HeroBackdrop } from '../ui/HeroBackdrop';
import { useTheme } from '../../hooks/useTheme';
import { nightSafeColor } from '../../lib/nightSafeColor';
import { HERO_IMAGES } from '../../lib/heroImagery';
import type { CaptureMetric } from '../../lib/captureMetrics';
import { PROCESSING_STATUS_ORDER, processingStatusLabel } from '../../lib/processingStatus';
import type { ConnectionType } from '../../lib/api/telescopes';
import type { ProcessingStatus } from '../../types';

export interface HeroTelescope {
  id: string;
  name: string;
  color: string;
  /** Drives the "over Wi-Fi" vs "via USB" wording on Sync all sub-frames — a
   *  telescope configured local-only (a USB-mounted drive, no SMB/FTP
   *  transport at all) never reaches out over the network. */
  connectionType: ConnectionType;
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
  /** Scale the picture up to the frame height. A framed crop is cut from a
   *  small region and comes back at its own pixel size, which would otherwise
   *  draw as a thumbnail-sized image. */
  imageFill?: boolean;
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

  /** Catalog numbers worth reading beside the title (magnitude, distance,
   *  angular size), as ready-made label/value pairs. Empty or absent renders
   *  nothing. */
  facts?: { label: string; value: string }[];
  /** Other catalog names for the target, shown as quiet chips under the facts. */
  alsoKnownAs?: string[];
  /** The catalog's description, shown clamped to three lines under the meta
   *  line. Absent for an object with no write-up, in which case the column
   *  keeps its text at the top instead of leaving a gap. */
  description?: string | null;
  /** Opens the full write-up. When set, a "More" link appears under the
   *  description if (and only if) the three-line clamp cut text off. */
  onReadMore?: (() => void) | null;
  /** A panel for the third column on wide screens, stacked under the picture
   *  and text on narrower ones. The page passes tonight's visibility and the
   *  filter guidance, the two planning answers. */
  aside?: ReactNode;

  isFavorite: boolean;
  onToggleFavorite: () => void;

  processingStatus: ProcessingStatus;
  /** Null for a viewer who may not change it — renders a plain, non-interactive
   *  pill instead of a dropdown, same "null means read-only" convention
   *  `onEditImage`/`onEditDetails`/`onDelete` already use on this component. */
  onChangeProcessingStatus: ((status: ProcessingStatus) => void) | null;

  onAddObservation: (() => void) | null;
  /** Null when there are fewer than two observations to compare. Rendered as
   *  a disabled button with an explanatory title, not hidden — see
   *  `hideTargetActions` for the case where it should disappear entirely. */
  onCompare: (() => void) | null;
  onCombine: () => void;
  /** Opens the stacking export (kept lights + matching calibration). Null when the object has no FITS
   *  sub-frames to export. */
  onStackingExport: (() => void) | null;
  /** Opens the Framing & Mosaic planner. Null when the feature flag is off,
   *  in which case the button is omitted rather than shown disabled. */
  onFraming: (() => void) | null;
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
  /** Opens the Reclassify modal: move everything under this object to a
   *  different catalog identity when the designation was wrong or ambiguous.
   *  Null for a viewer, same gating as onEditDetails/onDelete. */
  onReclassify: (() => void) | null;
  /** Library object id, for the "Show file location" panel. */
  objectId: string;
  /** Switches this page between the By-night layout and the All-media layout.
   *  `current` is the layout showing now. Null hides the menu item. */
  layoutSwitch?: { current: 'nights' | 'media'; onToggle: () => void } | null;
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
  displayName, eyebrow, imageSrc, imageFill = false, imageFailed, onImageError, onEditImage,
  telescopes, metrics, accent,
  facts = [], alsoKnownAs = [], description = null, onReadMore = null, aside = null,
  isFavorite, onToggleFavorite,
  processingStatus, onChangeProcessingStatus,
  onAddObservation, onCompare, onCombine, onStackingExport, onFraming, onDownloadAll, downloadPending = false, onSyncAllSubframes,
  onPlan, onEditDetails, onDelete, onReclassify, layoutSwitch = null,
  objectId, hideTargetActions = false,
}: Props) {
  const { t } = useTranslation('library');
  const { t: tObs } = useTranslation('observations');
  const { isNight } = useTheme();
  const [showLocation, setShowLocation] = useState(false);
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);
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
  const focalPoint = useImageFocalPoint(showImage ? imageSrc : null);

  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel"
    >
      {/* Stock artwork only when the object has no picture of its own: one it
          does have is its own sky and always beats a stand-in. */}
      {!showImage && <HeroBackdrop image={HERO_IMAGES.westerlund} intensity={0.5} />}

      {/* Ambient: the picture itself, thrown out of focus, so the panel takes
          its colour from the target and a narrow frame leaves no dead slab
          beside it. Cropped to the image's own brightest region
          (useImageFocalPoint) rather than its geometric center: most library
          pictures are a small bright subject in a mostly-black frame, and a
          center crop often lands on empty sky. Blur is deliberately lighter
          than a first pass at this used (64px): at that radius a starfield's
          own stars, which is most of what a raw/unprocessed frame actually
          is, get smeared into one flat grey wash with nothing left to look
          at. 28px keeps individual stars as soft points and a nebula's real
          structure as a gradient, so the panel still reads as "a photo" and
          not just a tinted rectangle; saturate/contrast/brightness then lift
          that dimmer, more detailed result back up to something visible
          against the panel's own dark scrims. */}
      {showImage && (
        <img
          src={imageSrc}
          alt=""
          aria-hidden="true"
          className={`absolute inset-0 h-full w-full scale-[2] object-cover blur-[28px]
            saturate-[180%] contrast-[120%] brightness-[130%]
            transition-opacity duration-700 ${imgLoaded ? 'opacity-55' : 'opacity-0'}`}
          style={{ objectPosition: `${focalPoint.x}% ${focalPoint.y}%` }}
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
        <div className="flex items-start justify-between gap-3">
          <nav aria-label={t('objectDetail.hero.breadcrumb')} className="flex min-w-0 flex-wrap items-center gap-1.5 text-[0.7812rem]">
            <Link to="/" className="text-white/45 transition hover:text-white">{t('objectDetail.hero.library')}</Link>
            <span className="text-white/20">/</span>
            <span className="truncate text-white/70">{displayName}</span>
          </nav>
          {layoutSwitch && (
            <div
              role="group"
              aria-label={t('objectDetail.hero.layoutSwitch')}
              className="inline-flex shrink-0 rounded-lg border border-white/10 bg-black/30 p-0.5 backdrop-blur-sm"
            >
              {([
                { id: 'nights', icon: CalendarDays, label: t('objectDetail.hero.layoutByNight') },
                { id: 'media', icon: LayoutGrid, label: t('objectDetail.hero.layoutAllPhotos') },
              ] as const).map(({ id, icon: Icon, label }) => {
                const active = layoutSwitch.current === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    title={label}
                    onClick={() => { if (!active) layoutSwitch.onToggle(); }}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[0.75rem] font-medium transition ${
                      active ? 'bg-white/15 text-white shadow-sm' : 'text-white/55 hover:text-white'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Picture | identity, and a third column for the aside from 1440px. Below that
            the aside spans both columns underneath instead of squeezing them. */}
        <div className={`grid gap-6 lg:items-start lg:gap-9 lg:grid-cols-[auto_minmax(0,1fr)] ${
          aside ? 'hero:grid-cols-[auto_minmax(380px,1fr)_minmax(320px,400px)]' : ''
        }`}>
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
        <div className={`w-full shrink-0 lg:w-auto lg:max-w-[45vw] ${aside ? 'hero:max-w-[min(30vw,calc(100vw_-_916px))] 2xl:max-w-[34vw]' : ''}`}>
          {/* Top-anchored on lg: a wide picture capped by width is shorter than
              the frame, and centring it left its top edge halfway down the
              title block beside it. */}
          <div className={`flex ${FRAME_HEIGHT} w-full items-center justify-center lg:w-auto lg:items-start`}>
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
                    className={`${imageFill ? FRAME_HEIGHT : FRAME_MAX_HEIGHT} max-w-full rounded-xl object-contain`}
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
                      title={t('objectDetail.hero.chooseImageTitle')}
                      className="absolute right-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-lg bg-black/45 px-2.5 py-1.5
                        text-[0.6875rem] font-medium text-white opacity-0 backdrop-blur-md transition hover:bg-black/70
                        group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none
                        focus-visible:ring-2 focus-visible:ring-white/70"
                    >
                      <Pencil className="h-3 w-3" />
                      {t('objectDetail.hero.changeImage')}
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
                <p className="text-sm font-medium text-white/50">{t('objectDetail.hero.noImageYet')}</p>
                {onEditImage && (
                  <button
                    onClick={onEditImage}
                    className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5
                      text-[0.6875rem] font-medium text-white/80 ring-1 ring-inset ring-white/15 transition
                      hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2
                      focus-visible:ring-white/70"
                  >
                    <Pencil className="h-3 w-3" />
                    {t('objectDetail.hero.chooseImage')}
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
        {/* Four blocks, one style each: name, a quiet meta line, the numbers,
            then the actions. These were nine stacked rows in as many
            treatments (pill, stat tiles, label-left facts, chips, telescope
            row, filter grid), which read as a pile rather than a header. */}
        {/* As tall as the picture's frame on lg (FRAME_HEIGHT's lg step), with
            the numbers and actions pushed to the bottom: the name sits level
            with the top of the picture and the buttons with its bottom, so the
            column has no dead band under them. */}
        <div className="flex min-w-0 flex-1 flex-col gap-6 lg:min-h-[360px]">
            <div className="min-w-0">
              {eyebrow.length > 0 && (
                <div className="truncate text-[0.6875rem] font-medium uppercase tracking-[0.18em] text-white/50">
                  {eyebrow.join(' · ')}
                </div>
              )}

              <div className="mt-1.5 flex items-start gap-3">
                <h1 className="font-display min-w-0 text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-[2.625rem] lg:leading-[1.05]">
                  {displayName}
                </h1>
                <button
                  onClick={onToggleFavorite}
                  aria-pressed={isFavorite}
                  title={isFavorite ? t('objectDetail.hero.removeFromFavorites') : t('objectDetail.hero.addToFavorites')}
                  className="mt-1 shrink-0 rounded-full p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  <Star
                    className={`h-5 w-5 ${isFavorite ? 'fill-amber-400 text-amber-400' : ''}`}
                  />
                </button>
              </div>

              {/* Status and the telescopes that have shot it on one line of small
                  text; its other names get their own line below, so the block
                  has the same shape on every object. */}
              <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[0.8125rem] text-white/60">
                <ProcessingStatusPill status={processingStatus} onChange={onChangeProcessingStatus} />
                {telescopes.length > 0 && (
                  <>
                    <span aria-hidden="true" className="text-white/25">·</span>
                    {/* Which telescopes have been on this target. A target shot on
                        two rigs is worth knowing about before comparing nights. */}
                    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Telescope className="h-3.5 w-3.5 text-white/40" />
                      {telescopes.map((tel, i) => (
                        <span key={tel.id} className="inline-flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: nightSafeColor(tel.color, isNight, i) }} />
                          {tel.name}
                        </span>
                      ))}
                    </span>
                  </>
                )}
              </div>

              {alsoKnownAs.length > 0 && (
                <p className="mt-1.5 min-w-0 text-[0.8125rem] text-white/60">
                  <span className="text-white/40">{tObs('observationDetail.objectPanel.alsoKnownAs')}</span>{' '}
                  <span className="text-white/75">{alsoKnownAs.slice(0, 4).join(', ')}</span>
                </p>
              )}

              {/* Fills the room the picture's height leaves between the name
                  and the numbers, and answers "what is this" before anything
                  else on the page does. The full text lives in About. */}
              {description && (
                <HeroDescription text={description} onReadMore={onReadMore} />
              )}
            </div>

            {/* Every number in one style: the object's totals (they used to be
                a strip of wide, mostly empty cells along the base of the
                banner) and its catalog figures alike. */}
            {(metrics.length > 0 || facts.length > 0) && (
              <dl className="flex flex-wrap items-start gap-x-6 gap-y-4 lg:mt-auto">
                {[
                  ...metrics.map(m => ({ key: m.key, value: m.value, label: m.label, hint: m.hint })),
                  ...facts.map(f => ({ key: `fact-${f.label}`, value: f.value, label: f.label, hint: undefined })),
                ].map(({ key, value, label, hint }) => (
                  <div key={key} className="flex min-w-0 flex-col-reverse" title={hint ?? undefined}>
                    <dt className="mt-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-white/50">
                      {label}
                    </dt>
                    <dd className="font-display text-xl font-bold leading-none tracking-tight text-white tabular-nums">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

          <div className="flex flex-wrap items-center gap-2">
            {onAddObservation && (
              <button
                onClick={onAddObservation}
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[0.8125rem] font-semibold text-slate-950
                  transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                style={{ background: accent, boxShadow: `0 8px 24px -12px ${accent}` }}
              >
                <PlusCircle className="h-4 w-4" />
                {t('objectDetail.hero.addObservation')}
              </button>
            )}
            <HeroAction onClick={downloadPending ? undefined : () => setShowDownloadConfirm(true)} icon={Download}
              label={downloadPending ? t('objectDetail.hero.preparing') : t('objectDetail.hero.download')}
              title={t('objectDetail.hero.downloadTitle')} />

            {/* Everything else here is either occasional (Plan a night, Compare,
                sub-frames, Framing & Mosaic) or neither frequent nor reversible
                (edit, delete) — none of it earns a permanent slot next to Add
                observation and Download, so it all lives behind one button. */}
            <OverflowMenu
              onPlan={hideTargetActions ? null : onPlan}
              onCompare={hideTargetActions ? null : onCompare}
              onCombine={hideTargetActions ? null : onCombine}
              onStackingExport={hideTargetActions ? null : onStackingExport}
              onFraming={onFraming}
              onSyncAllSubframes={hideTargetActions ? null : onSyncAllSubframes}
              // Explains what the action actually does (reach out to the
              // device) rather than repeating the label as a tooltip — this is
              // the one item here that depends on a device still being
              // reachable, unlike everything else in the menu. Wi-Fi vs USB
              // wording follows the telescope's actual transport rather than
              // assuming Wi-Fi: a USB-only profile never touches the network.
              syncAllSubframesTitle={telescopes.length === 1
                ? t(telescopes[0].connectionType === 'local'
                    ? 'objectDetail.hero.syncAllSubframesTitleForUsb'
                    : 'objectDetail.hero.syncAllSubframesTitleForWifi', { name: telescopes[0].name })
                : t('objectDetail.hero.syncAllSubframesTitle')}
              onEditDetails={onEditDetails}
              onReclassify={onReclassify}
              onDelete={onDelete}
              onShowLocation={() => setShowLocation(true)}
              showCompareDisabled={!hideTargetActions}
            />
          </div>

        </div>

        {aside && <div className="@container min-w-0 lg:col-span-2 hero:col-span-1">{aside}</div>}
        </div>
      </div>

      {showLocation && (
        <FileLocationModal
          objectId={objectId}
          displayName={displayName}
          onClose={() => setShowLocation(false)}
        />
      )}

      {showDownloadConfirm && (
        <DownloadConfirmModal
          objectId={objectId}
          displayName={displayName}
          onClose={() => setShowDownloadConfirm(false)}
          onConfirm={() => { setShowDownloadConfirm(false); onDownloadAll(); }}
        />
      )}
    </section>
  );
}

/** The description, cut to three lines with "More" at the end of the third
 *  when something was hidden: a one-sentence blurb has nothing more to read.
 *  The cut is made at a word boundary, found by measuring a hidden copy, so
 *  "More" sits inline instead of on a row of its own. */
function HeroDescription({ text, onReadMore }: { text: string; onReadMore: (() => void) | null }) {
  const { t } = useTranslation('library');
  const probeRef = useRef<HTMLParagraphElement>(null);
  const [shown, setShown] = useState(text);
  const [truncated, setTruncated] = useState(false);
  const readMore = t('objectDetail.hero.readMore');

  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;
    const fit = () => {
      const lineHeight = parseFloat(getComputedStyle(probe).lineHeight);
      const maxHeight = lineHeight * 3 + 1;
      const fits = (n: number, cut: boolean) => {
        probe.textContent = `${text.slice(0, n).trimEnd()}${cut ? '… ' : ''}${cut && onReadMore ? readMore : ''}`;
        return probe.scrollHeight <= maxHeight;
      };
      if (fits(text.length, false)) { setShown(text); setTruncated(false); return; }
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(mid, true)) lo = mid; else hi = mid - 1;
      }
      const space = text.lastIndexOf(' ', lo);
      setShown(text.slice(0, space > 0 && lo < text.length ? space : lo).trimEnd());
      setTruncated(true);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(probe);
    // The cut depends on glyph widths, so measure again once the fonts land.
    // `ready` can resolve before a face has even been requested, so also listen for loads.
    const fonts = document.fonts;
    fonts?.addEventListener('loadingdone', fit);
    void fonts?.ready.then(fit);
    return () => { ro.disconnect(); fonts?.removeEventListener('loadingdone', fit); };
  }, [text, readMore, onReadMore]);

  return (
    <div className="relative mt-4 max-w-prose">
      <p className="text-[0.8438rem] leading-relaxed text-white/60">
        {shown}
        {truncated && (
          <>
            {'… '}
            {onReadMore && (
              <button
                type="button"
                onClick={onReadMore}
                className="rounded font-medium text-white/80 underline-offset-2 transition hover:text-white hover:underline
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                {readMore}
              </button>
            )}
          </>
        )}
      </p>
      {/* Same box as the visible text, never shown: measures what fits in three lines. */}
      <p ref={probeRef} aria-hidden="true" className="invisible absolute inset-x-0 top-0 -z-10 text-[0.8438rem] leading-relaxed" />
    </div>
  );
}

/** Every action that isn't Add observation or Download: the occasional target
 *  actions (Plan a night, Compare, sub-frames, Framing & Mosaic) grouped above
 *  a divider from the rare, hard-to-undo ones (edit, delete). Drops back onto
 *  a solid surface once open: a translucent menu over a photograph is
 *  unreadable. */
function OverflowMenu({
  onPlan, onCompare, onCombine, onStackingExport, onFraming, onSyncAllSubframes, syncAllSubframesTitle,
  onEditDetails, onReclassify, onDelete, onShowLocation, showCompareDisabled,
}: {
  onPlan: (() => void) | null;
  onCompare: (() => void) | null;
  onCombine: (() => void) | null;
  onStackingExport: (() => void) | null;
  onFraming: (() => void) | null;
  onSyncAllSubframes: (() => void) | null;
  syncAllSubframesTitle: string;
  onEditDetails: (() => void) | null;
  onReclassify: (() => void) | null;
  onDelete: (() => void) | null;
  onShowLocation: () => void;
  /** Compare has fewer than two observations to work with, but stays visible
   *  (disabled, with an explanatory title) rather than disappearing, so a
   *  single-observation object still shows the action exists. */
  showCompareDisabled: boolean;
}) {
  const { t } = useTranslation('library');
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useClickOutside([wrapRef, menuRef], () => setOpen(false), { enabled: open, closeOnEscape: true });

  // Grown from four items to as many as nine, this now routinely runs taller
  // than the hero panel has room for below the trigger. The panel clips its
  // own overflow (for the blurred backdrop), so a menu left inside it gets
  // cut off rather than scrolling into view. Portaled to <body>, same fix and
  // same reason as SitePicker's menu.
  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const hasTargetActions = onPlan || onCompare || showCompareDisabled || onCombine || onStackingExport || onFraming || onSyncAllSubframes;

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('objectDetail.hero.moreActions')}
        className="inline-flex items-center gap-2 rounded-full bg-white/[0.07] px-3 py-2 text-[0.8125rem] font-medium
          text-white/85 ring-1 ring-inset ring-white/15 backdrop-blur-md transition-colors hover:bg-white/15
          hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <MoreHorizontal className="h-4 w-4" />
        <span className="sr-only">{t('objectDetail.hero.moreActions')}</span>
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          // Fixed to the viewport, so a menu taller than the room under the
          // button is cut off and cannot be scrolled to. Cap it to what is
          // left and let it scroll instead.
          style={{
            position: 'fixed', top: menuPos.top, right: menuPos.right,
            maxHeight: Math.max(160, window.innerHeight - menuPos.top - 12),
          }}
          className="z-20 w-56 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-2xl"
        >
          {onPlan && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onPlan(); }}
              title={t('objectDetail.hero.planANightTitle')}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[0.8125rem] text-slate-200 transition hover:bg-slate-800"
            >
              <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
              {t('objectDetail.hero.planANight')}
            </button>
          )}
          {showCompareDisabled && (
            <button
              role="menuitem"
              onClick={onCompare ? () => { setOpen(false); onCompare(); } : undefined}
              aria-disabled={!onCompare}
              title={onCompare ? t('objectDetail.hero.compareTitle') : t('objectDetail.hero.compareDisabledTitle')}
              className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[0.8125rem] transition ${
                onCompare ? 'text-slate-200 hover:bg-slate-800' : 'cursor-not-allowed text-slate-500'
              }`}
            >
              <Columns className={`h-3.5 w-3.5 ${onCompare ? 'text-slate-400' : 'text-slate-600'}`} />
              {t('objectDetail.hero.compare')}
            </button>
          )}
          {onSyncAllSubframes && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onSyncAllSubframes(); }}
              title={syncAllSubframesTitle}
              className="flex w-full items-start gap-2.5 px-3.5 py-2 text-left transition hover:bg-slate-800"
            >
              <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="flex flex-col">
                <span className="text-[0.8125rem] text-slate-200">{t('objectDetail.hero.syncAllSubframes')}</span>
                {/* A visible caption, not just a hover title: this is the one
                    item in the menu that depends on a network device still
                    being reachable, and that's easy to miss on a touch device
                    where nothing ever hovers. */}
                <span className="text-[0.6875rem] text-slate-500">{syncAllSubframesTitle}</span>
              </span>
            </button>
          )}
          {onCombine && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onCombine(); }}
              title={t('objectDetail.hero.combineSubsTitle')}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[0.8125rem] text-slate-200 transition hover:bg-slate-800"
            >
              <Layers className="h-3.5 w-3.5 text-slate-400" />
              {t('objectDetail.hero.combineSubs')}
            </button>
          )}
          {onStackingExport && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onStackingExport(); }}
              title={t('objectDetail.hero.stackingExportTitle')}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[0.8125rem] text-slate-200 transition hover:bg-slate-800"
            >
              <PackageCheck className="h-3.5 w-3.5 text-slate-400" />
              {t('objectDetail.hero.stackingExport')}
            </button>
          )}
          {onFraming && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onFraming(); }}
              title={t('objectDetail.framingMosaicTitle')}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[0.8125rem] text-slate-200 transition hover:bg-slate-800"
            >
              <Frame className="h-3.5 w-3.5 text-slate-400" />
              {t('objectDetail.framingMosaic')}
            </button>
          )}

          {hasTargetActions && <div role="separator" className="my-1 border-t border-slate-800" />}

          <button
            role="menuitem"
            onClick={() => { setOpen(false); onShowLocation(); }}
            className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[0.8125rem] text-slate-200 transition hover:bg-slate-800"
          >
            <FolderOpen className="h-3.5 w-3.5 text-slate-400" />
            {t('objectDetail.hero.showFileLocation')}
          </button>
          {onEditDetails && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onEditDetails(); }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[0.8125rem] text-slate-200 transition hover:bg-slate-800"
            >
              <Pencil className="h-3.5 w-3.5 text-slate-400" />
              {t('objectDetail.hero.editObjectDetails')}
            </button>
          )}
          {onReclassify && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onReclassify(); }}
              title={t('objectDetail.hero.reclassifyObjectTitle')}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[0.8125rem] text-slate-200 transition hover:bg-slate-800"
            >
              <Shuffle className="h-3.5 w-3.5 text-slate-400" />
              {t('objectDetail.hero.reclassifyObject')}
            </button>
          )}
          {onDelete && (
            <>
              <div role="separator" className="my-1 border-t border-slate-800" />
              <button
                role="menuitem"
                onClick={() => { setOpen(false); onDelete(); }}
                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[0.8125rem] text-red-300 transition hover:bg-red-500/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('objectDetail.hero.deleteObject')}
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * Small colored dropdown pill next to the favorite star. Admin (onChange
 * non-null) gets a menu to change status; a viewer sees the same pill,
 * read-only, mirroring OverflowMenu's own dropdown structure above.
 */
function ProcessingStatusPill({ status, onChange, className = '' }: {
  status: ProcessingStatus;
  onChange: ((status: ProcessingStatus) => void) | null;
  className?: string;
}) {
  const { t } = useTranslation('library');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useClickOutside(wrapRef, () => setOpen(false), { enabled: open, closeOnEscape: true });

  const TONE_CLASSES: Record<ProcessingStatus, string> = {
    unprocessed: 'bg-white/[0.07] text-white/60 ring-white/15',
    processing: 'bg-amber-500/15 text-amber-300 ring-amber-400/30',
    processed: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30',
  };

  const pill = (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium
        leading-none ring-1 ring-inset backdrop-blur-sm ${TONE_CLASSES[status]}`}
    >
      {processingStatusLabel(status, t)}
      {onChange && <ChevronDown className="-mr-0.5 h-3 w-3 opacity-70" aria-hidden="true" />}
    </span>
  );

  if (!onChange) {
    return <div className={className}>{pill}</div>;
  }

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('processingStatus.changeStatus')}
        className="rounded-full transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        {pill}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 z-20 mt-1.5 w-40 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-2xl"
        >
          {PROCESSING_STATUS_ORDER.map(s => (
            <button
              key={s}
              role="menuitem"
              onClick={() => { setOpen(false); onChange(s); }}
              className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-[0.8125rem] transition hover:bg-slate-800 ${
                s === status ? 'text-white' : 'text-slate-300'
              }`}
            >
              {processingStatusLabel(s, t)}
            </button>
          ))}
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
  const className = `inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[0.8125rem] font-medium
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
