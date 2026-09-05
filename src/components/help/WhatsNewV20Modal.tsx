import { useState } from 'react';
import {
  X,
  Sparkles,
  Library,
  CalendarRange,
  CloudMoon,
  Compass,
  BookOpen,
  ScrollText,
  Telescope,
  RefreshCw,
  DatabaseBackup,
  Maximize2,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useTheme } from '../../hooks/useTheme';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** First-login flow only: persists the dismissal. Omitted for the "see it
   *  again from Settings" entry point, which then shows a plain "Done" footer. */
  onAcknowledge?: () => void;
  acknowledging?: boolean;
  /** Hands off to the full ChangelogModal. Omit to hide the link. */
  onViewAll?: () => void;
}

interface Feature {
  icon: React.ElementType;
  title: string;
  /** Short benefit lead (~40 chars), bolded in card. */
  lead: string;
  description: string;
  /** Filename under /whatsnew/v2-0/ in `public/`. Missing files fall back
   *  to an icon tile, so screenshots can be dropped in after the fact. */
  screenshot: string;
}

const FEATURES: Feature[] = [
  {
    icon: CalendarRange,
    title: 'Planner, redesigned around picking a night',
    lead: 'See two weeks at a glance.',
    description: "A two-week strip shows each night's forecast rating, Moon phase, and whether you already have a plan. The schedule reads the weather forecast hour by hour, with a twilight gradient and a line marking the current time.",
    screenshot: 'planner.webp',
  },
  {
    icon: CloudMoon,
    title: 'Sky Forecast, redesigned around tonight',
    lead: 'One score, one night.',
    description: 'A single rating, the Moon at its real phase, and a night ribbon covering twilight, clouds, Moon-up hours, and visibility on one timeline, plus a best-window readout for the nights ahead.',
    screenshot: 'forecast.webp',
  },
  {
    icon: Library,
    title: 'Sharpless joins the catalogs',
    lead: 'A new catalog to work through.',
    description: "The Sharpless catalog of emission nebulae is now part of the set, alongside Messier, Caldwell, and Herschel 400. Each has a progress board showing what you've captured and what's still up, and search matches any of an object's catalog names.",
    screenshot: 'catalogs.webp',
  },
  {
    icon: Telescope,
    title: 'Observations, redesigned',
    lead: 'Three ways to look back.',
    description: "See your observations as a month-by-month chart, on a map, or as a list. The page opens on your nights out and your objects, and the calendar lands on your most recent night with each day showing its photo.",
    screenshot: 'observations.webp',
  },
  {
    icon: Compass,
    title: 'Guided Tour',
    lead: 'New to Nebulis? Start here.',
    description: 'A guided tour launches automatically on a new install and walks you through the app. Restart it anytime from Help -> Start the Guided Tour.',
    screenshot: 'guided-tour.webp',
  },
  {
    icon: BookOpen,
    title: 'New Help page',
    lead: 'Guides for every feature.',
    description: 'Screenshots and walkthroughs for importing, syncing, planning, and more, all in one place.',
    screenshot: 'help-page.webp',
  },
  {
    icon: ScrollText,
    title: 'System Log for admins',
    lead: 'See who did what.',
    description: 'A searchable history of sign-ins, user changes, telescope and device changes, syncs, and settings changes. Settings -> System Log.',
    screenshot: 'system-log.webp',
  },
  {
    icon: RefreshCw,
    title: 'Backup Status, redesigned',
    lead: 'Know your library is current.',
    description: 'A live progress banner shows transfer rate and time left while syncing, and a backup history records every past sync. Each telescope card shows when it last synced, and a failed sync gets its own panel with the full error text.',
    screenshot: 'backup-status.webp',
  },
  {
    icon: DatabaseBackup,
    title: 'Automatic database backups',
    lead: 'Roll back a release safely.',
    description: 'Nebulis snapshots its database automatically just before it applies a new version, so you can return to an earlier release without losing data. Make one yourself, or manage the rest, at Settings -> Storage -> Backups.',
    screenshot: 'database-backup.webp',
  },
];

function FeatureCard({ feature, isDark, onExpand }: { feature: Feature; isDark: boolean; onExpand: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  const Icon = feature.icon;
  const cardBg = isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50 border-slate-200';
  const shotBg = isDark ? 'bg-slate-900' : 'bg-slate-100';

  return (
    <div className={`rounded-xl border overflow-hidden ${cardBg}`}>
      <div className={`relative aspect-video flex items-center justify-center ${shotBg}`}>
        {!imgFailed ? (
          <button
            type="button"
            onClick={onExpand}
            className="group relative w-full h-full cursor-zoom-in"
            aria-label={`View full size: ${feature.title}`}
          >
            <img
              src={`/whatsnew/v2-0/${feature.screenshot}`}
              alt={feature.title}
              className="w-full h-full object-cover"
              loading="lazy"
              onError={() => setImgFailed(true)}
            />
            <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors">
              <Maximize2 className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </span>
          </button>
        ) : (
          <Icon className={`w-8 h-8 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
        )}
      </div>
      <div className="p-3.5">
        <div className="flex items-center gap-2 mb-1.5">
          <Icon className={`w-4 h-4 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
          <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{feature.title}</h3>
        </div>
        <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          <strong className={`font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{feature.lead}</strong>{' '}
          {feature.description}
        </p>
      </div>
    </div>
  );
}

/** Full-screen view of a single feature screenshot. Nests inside the main
 *  modal's Modal (supported: see Modal.tsx's nested-dialog handling), so
 *  Escape/Tab trapping and backdrop click work the same as any other dialog. */
function Lightbox({ feature, onClose }: { feature: Feature; onClose: () => void }) {
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${feature.title} screenshot`}
      backdropClassName="bg-black/90"
      className="w-full h-full max-w-[95vw] max-h-[95vh] flex items-center justify-center"
      focusOnOpen="dialog"
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
        aria-label="Close"
      >
        <X className="w-5 h-5" />
      </button>
      <img
        src={`/whatsnew/v2-0/${feature.screenshot}`}
        alt={feature.title}
        onClick={onClose}
        className="max-w-full max-h-full object-contain rounded-lg shadow-2xl cursor-zoom-out"
      />
      <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-sm font-medium text-white/90 bg-black/50 px-3 py-1.5 rounded-full whitespace-nowrap">
        {feature.title}
      </p>
    </Modal>
  );
}

/**
 * Enhanced first-login popup for the 2.0 release. Larger than the standard
 * ChangelogModal, with a screenshot card per headline feature. See
 * ENHANCED_SERIES in WhatsNewAutoPopup for how a release series gets one of
 * these instead of the plain changelog.
 */
export function WhatsNewV20Modal({ isOpen, onClose, onAcknowledge, acknowledging, onViewAll }: Props) {
  const { isDark } = useTheme();
  const [lightboxFeature, setLightboxFeature] = useState<Feature | null>(null);

  const bg = isDark ? 'bg-slate-900' : 'bg-white';
  const border = isDark ? 'border-slate-800' : 'border-slate-200';
  const heading = isDark ? 'text-slate-100' : 'text-slate-900';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const divider = isDark ? 'border-slate-800' : 'border-slate-100';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="What's New in Nebulis 2.0"
      className="w-full max-w-6xl max-h-[85vh] flex flex-col"
    >
      <div className={`flex flex-col rounded-2xl border shadow-xl overflow-hidden ${bg} ${border}`}>
        {/* Header */}
        <div
          className={`relative px-6 py-5 border-b ${divider} ${
            isDark
              ? 'bg-gradient-to-br from-accent-500/15 via-slate-900 to-slate-900'
              : 'bg-gradient-to-br from-accent-50 via-white to-white'
          }`}
        >
          <button
            onClick={onClose}
            className={`absolute top-4 right-4 p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
          <div className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full mb-2 ${isDark ? 'bg-accent-500/15 text-accent-300' : 'bg-accent-100 text-accent-700'}`}>
            <Sparkles className="w-3 h-3" />
            v2.0
          </div>
          <h2 className={`text-xl font-bold pr-8 ${heading}`}>What's new in Nebulis 2.0</h2>
          <p className={`text-sm mt-1 ${muted}`}>
            A full UI redesign, a night-first Planner and Sky Forecast, and a guided tour to get new users started.
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {FEATURES.map(f => (
              <FeatureCard key={f.title} feature={f} isDark={isDark} onExpand={() => setLightboxFeature(f)} />
            ))}
          </div>

        </div>

        {/* Footer */}
        <div className={`flex items-center justify-between gap-2 px-6 py-3 border-t ${divider}`}>
          {onViewAll ? (
            <button
              onClick={onViewAll}
              className={`text-xs font-medium transition ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}
            >
              View full release notes
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            {onAcknowledge ? (
              <>
                <button
                  onClick={onClose}
                  disabled={acknowledging}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50 ${isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}
                >
                  Remind me later
                </button>
                <button
                  onClick={onAcknowledge}
                  disabled={acknowledging}
                  className="px-3 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
                >
                  {acknowledging ? 'Saving…' : 'Got it'}
                </button>
              </>
            ) : (
              <button
                onClick={onClose}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition"
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>
      {lightboxFeature && (
        <Lightbox feature={lightboxFeature} onClose={() => setLightboxFeature(null)} />
      )}
    </Modal>
  );
}
