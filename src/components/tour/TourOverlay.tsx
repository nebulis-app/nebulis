import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ClipboardList,
  Compass,
  Crosshair,
  Images,
  LayoutGrid,
  Library,
  Rocket,
  Sparkles,
  Telescope,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { useTour } from './TourProvider';
import type { TourIconName, TourPlacement, TourStep } from './steps';

/**
 * Renders the spotlight + tooltip card for each step. Portal'd to <body> so it
 * sits above every other layer (nav is z-50, modals are z-90).
 *
 * Anchors are measured live: the card repositions on scroll and resize, and
 * during the route transition (when the target element does not exist yet) it
 * hides behind a short "taking you there" card instead of flashing a corner.
 */
// Deliberately above every other z-[100] layer in the app (PlanetariumMode,
// VisibleSkyEditor) rather than tied with them: two of the tour's own steps
// point at features that open one of those (the Gallery step's body text
// literally invites the user to open Planetarium Mode). Sharing a z-index
// makes "who wins" depend on incidental DOM/portal insertion order instead
// of an actual guarantee — the tour must always be able to win that fight.
const OVERLAY_Z = 200;
const PADDING = 10;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface SpotlightRect extends Rect {
  radius: number;
}

const ICONS: Record<TourIconName, LucideIcon> = {
  sparkles: Sparkles,
  library: Library,
  telescope: Telescope,
  crosshair: Crosshair,
  catalogs: BookOpen,
  gallery: Images,
  observations: ClipboardList,
  settings: LayoutGrid,
  compass: Compass,
};

export function TourOverlay() {
  const { active, step, stepIndex, stepCount, transitioning, next, back, stop } =
    useTour();  const { isDark, isNight, isSpace } = useTheme();
  const [spot, setSpot] = useState<SpotlightRect | null>(null);
  // `detached` marks a card parked in a corner because its anchor filled the
  // viewport, so it is not pointing at anything and must not draw an arrow.
  const [card, setCard] = useState<{ style: Rect; placement: TourPlacement; detached?: boolean } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState({ width: 0, height: 0 });
  // Only center the anchor once per step; subsequent scroll/resize re-measures
  // must not yank the viewport away from wherever the user is.
  const scrolledStepRef = useRef<string | null>(null);

  const accent =
    isNight ? '#f87171'
    : isSpace ? '#a78bfa'
    : isDark ? '#f59e0b'
    : '#b45309';

  const measure = useCallback(() => {
    if (!active) {
      setSpot(null);
      setCard(null);
      return;
    }

    // The welcome card has no anchor: center it as a modal-style intro.
    if (!step.route && step.id === 'welcome') {
      setSpot(null);
      setCard(null);
      return;
    }

    // A given anchorKey can match more than one element at once — e.g. the
    // settings nav renders both a desktop sidebar and a mobile tab strip,
    // one hidden via CSS (display:none, so a 0x0 rect) depending on
    // viewport width. querySelector would always return whichever comes
    // first in DOM order even if it is the hidden one, so pick the first
    // match that actually has a size instead.
    const candidates = document.querySelectorAll<HTMLElement>(`[data-tour-anchor="${step.anchorKey}"]`);
    let el: HTMLElement | null = null;
    for (const candidate of candidates) {
      const r = candidate.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) { el = candidate; break; }
    }
    // Fall through to the first match even if nothing has a size yet (e.g.
    // a lazy chunk that hasn't laid out on this frame) so the "still
    // looking" fallback below has a real reason to keep polling.
    if (!el) el = candidates[0] ?? null;
    if (!el) {
      setSpot(null);
      setCard(null);
      return;
    }

    // Lazy route chunks mount their content a frame or two after navigation,
    // so the anchor can appear while the overlay is already looking for it.
    // Centering it once both reveals the element and gives the spotlight a real
    // on-screen position instead of an off-screen rectangle. Later re-measures
    // (scroll/resize) leave the user's scrolling alone.
    if (scrolledStepRef.current !== step.id) {
      scrolledStepRef.current = step.id;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
    }

    const r = el.getBoundingClientRect();
    // Off-screen (still scrolling into view, or an empty page) → hide.
    if (r.width === 0 && r.height === 0) {
      setSpot(null);
      setCard(null);
      return;
    }

    const rect: Rect = { top: r.top, left: r.left, width: r.width, height: r.height };
    const radius = Math.min(20, Math.min(r.width, r.height) / 2, 12);
    setSpot({
      top: rect.top - PADDING,
      left: rect.left - PADDING,
      width: rect.width + PADDING * 2,
      height: rect.height + PADDING * 2,
      radius,
    });

    const cw = cardSize.width || 360;
    const ch = cardSize.height || 200;

    // Compute the card position from the anchor + placement. Keep it on
    // screen with a 12px gutter.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 14;
    const gutter = 12;

    // A step can anchor a whole page rather than one control (the planner
    // wraps its entire pane). There is no "beside" for an anchor that fills
    // the viewport: every placement below clamps back to roughly the middle,
    // dropping the card right on top of the thing it is describing. Park it
    // in a bottom corner instead, which keeps the spotlight readable and
    // leaves the content visible.
    const coverage = (rect.width * rect.height) / (vw * vh);
    if (coverage > 0.55) {
      // Prefer whichever bottom corner has more of the anchor's own content
      // clear of it — for a full-bleed anchor that is simply the right.
      setCard({
        style: {
          top: Math.max(gutter, vh - ch - gutter * 2),
          left: Math.max(gutter, vw - cw - gutter * 2),
          width: Math.min(cw, vw - gutter * 2),
          height: ch,
        },
        placement: step.placement,
        detached: true,
      });
      return;
    }

    let left = 0;
    let top = 0;

    switch (step.placement.side) {
      case 'bottom': {
        const y = rect.top + rect.height + gap;
        top = y + ch + gutter > vh
          ? Math.max(gutter, rect.top - gap - ch)
          : y;
        break;
      }
      case 'top': {
        const y = rect.top - gap - ch;
        top = y < gutter
          ? Math.min(vh - ch - gutter, rect.top + rect.height + gap)
          : y;
        break;
      }
      case 'right': {
        const x = rect.left + rect.width + gap;
        left = x + cw + gutter > vw
          ? Math.max(gutter, rect.left - gap - cw)
          : x;
        break;
      }
      case 'left': {
        const x = rect.left - gap - cw;
        left = x < gutter
          ? rect.left + rect.width + gap
          : x;
        break;
      }
    }

    if (step.placement.side === 'top' || step.placement.side === 'bottom') {
      left = clamp(rect.left + rect.width / 2 - cw / 2, gutter, vw - cw - gutter);
      top = clamp(top, gutter, vh - ch - gutter);
    } else {
      top = clamp(rect.top + rect.height / 2 - ch / 2, gutter, vh - ch - gutter);
      left = clamp(left, gutter, vw - cw - gutter);
    }

    setCard({
      style: { top, left, width: Math.min(cw, vw - gutter * 2), height: ch },
      placement: step.placement,
    });
  }, [active, step, cardSize.width, cardSize.height]);

  // Measure on mount, every placement/step change, and on scroll/resize.
  // rAF defers the synchronous setState out of the effect body (React Compiler
  // rule), and also catches the post-layout frame after an anchor mounts.
  useEffect(() => {
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
    };
  }, [measure]);

  // Lazy chunks mount their anchor after the first measure. While the tour is
  // open but the anchor hasn't been found yet, poll briefly so the spotlight
  // appears the moment it lands instead of waiting for a scroll. Stops as soon
  // as we have a position (or the tour closes).
  useEffect(() => {
    if (!active || spot) return;
    const id = window.setInterval(measure, 150);
    return () => window.clearInterval(id);
  }, [active, spot, measure]);

  // Track the card's real size for placement math.
  useEffect(() => {
    if (!cardRef.current) return;
    const obs = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      setCardSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    obs.observe(cardRef.current);
    return () => obs.disconnect();
  }, [card?.style.width, step.id]);

  // Recompute after the card size lands.
  useEffect(() => {
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [cardSize, measure]);

  if (!active) return null;

  const isWelcome = step.id === 'welcome';
  // Dim the page whenever there is nothing to spotlight — either still
  // navigating, or genuinely stuck with no anchor.
  const showShadow = !isWelcome && !spot;
  // The real dialog (title/body/hint/controls) is hidden only for the brief,
  // self-resolving window of an actual route transition. Once that settles,
  // it shows regardless of whether an anchor was ever found: a step whose
  // anchor cannot resolve (no telescope configured yet for the "sync" step,
  // "Help" hidden from the nav for the "done" step, or any future gap) must
  // still tell the user what the step is about and give them working
  // controls — never just a content-free "keep going" placeholder, and never
  // an invisible card silently blocking clicks underneath it.
  const showRealCard = !!card || !transitioning;

  const bodyBubble = isDark
    ? 'bg-slate-900 border-slate-700 text-slate-200'
    : 'bg-white border-slate-200 text-slate-800';
  const hint = isDark ? 'text-slate-500' : 'text-slate-500';

  const Icon = step.icon ? ICONS[step.icon] : Rocket;
  const placement = card?.placement ?? step.placement;

  return createPortal(
    <div className="nbl-tour fixed inset-0" style={{ zIndex: OVERLAY_Z }}>
      {/* Spotlight mask: one overlay cut out by four shadow panels. */}
      {spot && (
        <>
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            aria-hidden="true"
          >
            <defs>
              <mask id="nbl-tour-cutout">
                <rect x="0" y="0" width="100%" height="100%" fill="white" />
                <rect
                  x={spot.left}
                  y={spot.top}
                  width={spot.width}
                  height={spot.height}
                  rx={spot.radius}
                  fill="black"
                />
              </mask>
            </defs>
            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              fill="rgba(2, 6, 23, 0.72)"
              mask="url(#nbl-tour-cutout)"
            />
          </svg>
          {/* Accent ring hugging the anchored element. */}
          <div
            className="pointer-events-none absolute transition-all duration-300 ease-out"
            style={{
              top: spot.top - 2,
              left: spot.left - 2,
              width: spot.width + 4,
              height: spot.height + 4,
              borderRadius: spot.radius + 2,
              boxShadow: `0 0 0 2px ${accent}, 0 0 34px 0 ${accent}66`,
            }}
          />
        </>
      )}

      {/* Dim the page whenever nothing is spotlit. During the brief transition
          window this pairs with the small "taking you there" loading pill;
          once that settles it pairs with the real, centered dialog below
          (showRealCard), which is what actually carries the step's content. */}
      {showShadow && (
        <>
          <div className="pointer-events-none absolute inset-0 bg-slate-950/60" />
          {transitioning && <FallbackCard accent={accent} isDark={isDark} />}
        </>
      )}

      {/* Welcome / tooltip card. */}
      {isWelcome ? (
        <WelcomeCard
          accent={accent}
          isDark={isDark}
          onPrimary={next}
          onSkip={stop}
          total={stepCount}
          step={step}
        />
      ) : (
        <div
          ref={cardRef}
          role="dialog"
          aria-label={step.title}
          className={`nbl-tour-card absolute z-10 w-[min(380px,calc(100vw-24px))] rounded-2xl border shadow-2xl transition-all duration-200 ${
            isDark
              ? 'bg-slate-900/95 border-slate-700 backdrop-blur-xl'
              : 'bg-white/98 border-slate-200'
          } ${showRealCard ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          style={{
            top: card?.style.top ?? window.innerHeight / 2 - 120,
            left: card?.style.left ?? Math.max(12, window.innerWidth / 2 - 190),
            boxShadow: `0 24px 80px rgba(2,6,23,.5), 0 0 0 1px ${accent}22, 0 0 60px -12px ${accent}55`,
          }}
        >
          {/* Arrow pointing at the anchor, aligned on the placement side. */}
          {card && spot && !card.detached && (
            <ArrowPointer
              placement={placement}
              anchor={spot}
              cardRect={card.style}
              accent={accent}
              isDark={isDark}
            />
          )}

          <div className="p-6">
            <div className="flex items-start gap-4">
              <div
                className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                style={{
                  color: accent,
                  backgroundColor: `${accent}18`,
                  boxShadow: `inset 0 0 0 1px ${accent}33`,
                }}
              >
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: accent }}>
                  Step {stepIndex + 1} of {stepCount}
                </p>
                <h3 className={`mt-1 font-display text-lg font-bold tracking-tight ${bodyBubble}`}>
                  {step.title}
                </h3>
              </div>
            </div>

            <p className={`mt-4 text-[13.5px] leading-relaxed ${bodyBubble}`}>
              {step.body}
            </p>
            {step.hint && (
              <p className={`mt-3 text-xs leading-relaxed ${hint}`}>{step.hint}</p>
            )}

            <div className="mt-6 flex items-center justify-between">
              <button
                onClick={stop}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  isDark
                    ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
                    : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                }`}
              >
                Skip tour
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={back}
                  disabled={stepIndex === 0}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-40 ${
                    isDark
                      ? 'text-slate-300 hover:bg-slate-800'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <button
                  onClick={next}
                  className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white transition-transform hover:scale-[1.02] active:scale-[0.99]"
                  style={{ backgroundColor: accent, boxShadow: `0 8px 24px -8px ${accent}aa` }}
                >
                  {stepIndex === stepCount - 1 ? 'Finish' : 'Next'}
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Progress dots. */}
            <Dots count={stepCount} index={stepIndex} accent={accent} />
          </div>
        </div>
      )}

      {/* Close affordance in the corner, above the dim. */}
      <button
        onClick={stop}
        aria-label="Close tour"
        className={`absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 hover:text-white ${
          isWelcome ? 'hidden' : ''
        }`}
      >
        <X className="h-4 w-4" />
      </button>
    </div>,
    document.body,
  );
}

/** Card for the centered intro. */
function WelcomeCard({
  accent,
  isDark,
  onPrimary,
  onSkip,
  total,
  step,
}: {
  accent: string;
  isDark: boolean;
  onPrimary: () => void;
  onSkip: () => void;
  total: number;
  step: TourStep;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-label={step.title}
        className={`nbl-tour-card w-[min(440px,100vw)] overflow-hidden rounded-3xl border shadow-2xl ${
          isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
        }`}
        style={{ boxShadow: `0 30px 100px rgba(2,6,23,.6), 0 0 0 1px ${accent}22, 0 0 90px -20px ${accent}66` }}
      >
        <div
          className="flex h-28 items-center justify-center"
          style={{
            background: `radial-gradient(circle at 50% 80%, ${accent}40, transparent 70%)`,
          }}
        >
          <div
            className="flex h-14 w-14 items-center justify-center rounded-2xl overflow-hidden"
            style={{ boxShadow: `0 16px 40px -8px ${accent}cc` }}
          >
            <img src="/favicon.svg" alt="Nebulis" className="h-full w-full" />
          </div>
        </div>
        <div className="p-7">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: accent }}>
            Welcome
          </p>
          <h2 className={`mt-1.5 font-display text-2xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {step.title}
          </h2>
          <p className={`mt-3 text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            {step.body}
          </p>
          {step.hint && (
            <p className={`mt-2.5 text-xs leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {step.hint}
            </p>
          )}
          <div className="mt-7 flex items-center justify-between">
            <button
              onClick={onSkip}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isDark
                  ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
                  : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
              }`}
            >
              Not now
            </button>
            <button
              onClick={onPrimary}
              className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.02] active:scale-[0.99]"
              style={{ backgroundColor: accent, boxShadow: `0 10px 30px -10px ${accent}cc` }}
            >
              {step.id === 'welcome' ? 'Start the tour' : 'Next'}
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
          <p className={`mt-4 text-center text-[10px] uppercase tracking-[0.14em] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
            {total} steps · under a minute
          </p>
        </div>
      </div>
    </div>
  );
}

/** Small loading pill shown only during the brief window a route transition
 *  is in flight. Once that settles, the real dialog (with the step's actual
 *  content and controls) takes over — see `showRealCard` above — so this
 *  never needs its own message for a "stuck" state or its own Skip/Next
 *  controls; there is always exactly one place those live. */
function FallbackCard({ accent, isDark }: { accent: string; isDark: boolean }) {
  return (
    <div className="absolute inset-x-0 bottom-10 flex justify-center px-4">
      <div
        className={`flex items-center gap-3 rounded-2xl border px-5 py-4 shadow-2xl ${
          isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
        }`}
      >
        <div
          className="flex h-9 w-9 items-center justify-center rounded-full"
          style={{ color: accent, backgroundColor: `${accent}18` }}
        >
          <Rocket className="h-4 w-4" />
        </div>
        <div className={isDark ? 'text-slate-300' : 'text-slate-600'}>
          <p className="text-sm font-semibold">Taking you there</p>
          <p className="text-xs opacity-70">One moment, we are opening that page.</p>
        </div>
      </div>
    </div>
  );
}

/** Small triangle connecting the tooltip to the spotlight cutout. */
function ArrowPointer({
  placement,
  anchor,
  cardRect,
  accent,
  isDark,
}: {
  placement: TourPlacement;
  anchor: Rect;
  cardRect: Rect;
  accent: string;
  isDark: boolean;
}) {
  const cx = clamp(anchor.left + anchor.width / 2, cardRect.left + 24, cardRect.left + cardRect.width - 24);
  const cy = clamp(anchor.top + anchor.height / 2, cardRect.top + 24, cardRect.top + cardRect.height - 24);
  const isAbove = placement.side === 'top';
  const isBelow = placement.side === 'bottom';
  const isRight = placement.side === 'right';

  if (placement.side === 'bottom' || placement.side === 'top') {
    const top = isBelow ? -7 : cardRect.height - 1;
    const rotate = isBelow ? 0 : 180;
    const left = clamp(cx - cardRect.left, 26, cardRect.width - 26);
    return (
      <div
        className="pointer-events-none absolute h-3.5 w-3.5"
        style={{
          left,
          top,
          transform: `translateX(-50%) rotate(${rotate}deg)`,
        }}
      >
        <ArrowSvg accent={accent} isDark={isDark} above={isAbove} />
      </div>
    );
  }

  const left = isRight ? -7 : cardRect.width - 1;
  const rotate = isRight ? -90 : 90;
  const top = clamp(cy - cardRect.top, 26, cardRect.height - 26);
  return (
    <div
      className="pointer-events-none absolute h-3.5 w-3.5"
      style={{
        left,
        top,
        transform: `translateY(-50%) rotate(${rotate}deg)`,
      }}
    >
      <ArrowSvg accent={accent} isDark={isDark} above={false} />
    </div>
  );
}

function ArrowSvg({ accent, isDark, above }: { accent: string; isDark: boolean; above: boolean }) {
  return (
    <svg viewBox="0 0 14 14" className="block h-full w-full" aria-hidden="true">
      <path
        d="M0 0 L14 0 L7 14 Z"
        fill={isDark ? '#0f172a' : '#ffffff'}
        stroke={isDark ? '#334155' : '#e2e8f0'}
        strokeWidth="1"
      />
      {!above && <line x1="0" y1="0" x2="14" y2="0" stroke={accent} strokeWidth="1.5" strokeOpacity="0.45" />}
    </svg>
  );
}

function Dots({ count, index, accent }: { count: number; index: number; accent: string }) {
  return (
    <div className="mt-4 flex items-center justify-center gap-1.5">
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className="rounded-full transition-all duration-300"
          style={
            i === index
              ? { width: 18, height: 6, backgroundColor: accent }
              : { width: 6, height: 6, backgroundColor: 'rgba(148,163,184,.4)' }
          }
        />
      ))}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
