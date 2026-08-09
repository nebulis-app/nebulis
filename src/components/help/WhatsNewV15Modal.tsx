import { useState } from 'react';
import {
  X,
  Sparkles,
  Wifi,
  MapPin,
  Map as MapIcon,
  LayoutGrid,
  RefreshCw,
  Archive,
  FolderTree,
  Maximize2,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useTheme } from '../../hooks/useTheme';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAcknowledge: () => void;
  acknowledging?: boolean;
  onViewAll: () => void;
}

interface Feature {
  icon: React.ElementType;
  title: string;
  description: string;
  /** Filename under /whatsnew/v1-5/ in `public/`. Missing files fall back
   *  to an icon tile, so screenshots can be dropped in after the fact. */
  screenshot: string;
}

const FEATURES: Feature[] = [
  {
    icon: Wifi,
    title: 'Wi-Fi import for DWARF telescopes',
    description: "Dwarf II, Dwarf 3, and Dwarf Mini now import over their built-in FTP server, no USB cable needed. USB still works and takes priority when it's plugged in.",
    screenshot: 'dwarf-wifi.png',
  },
  {
    icon: MapPin,
    title: 'Observing Sites',
    description: 'Save multiple locations, each with its own coordinates, minimum altitude, and sky mask. Switch sites from the Planner or Forecast, and retag past observations.',
    screenshot: 'observing-sites.png',
  },
  {
    icon: MapIcon,
    title: 'Map view for observations',
    description: 'See where every observation was taken, pulled from FITS GPS data or manual site tags.',
    screenshot: 'map-view.png',
  },
  {
    icon: LayoutGrid,
    title: 'Observation page, redesigned',
    description: 'Images, Subframes, Processed, and Details now live under tabs at full page width, instead of stacked stat tiles and split panels.',
    screenshot: 'observation-tabs.png',
  },
  {
    icon: RefreshCw,
    title: 'Sync tells you what it skipped',
    description: 'Telescope sync now shows what it left behind and why: import settings, rejected frames, deleted sessions, unreadable folders. Live during sync, and saved to Sync History.',
    screenshot: 'sync-history.png',
  },
  {
    icon: Archive,
    title: '"Archive everything" import option',
    description: "Copies every file on the device as-is, folder structure and all, including sub-frames, rejected frames, logs, and unrecognized types. Files Nebulis can't display are still stored and downloadable.",
    screenshot: 'telescope-archive.png',
  },
  {
    icon: FolderTree,
    title: 'Library, reorganized per session',
    description: 'New imports give each session its own folder and keep the file names your telescope gave them. A "Reorganize library" button in Settings converts existing objects to the new layout; files are moved, never deleted.',
    screenshot: 'library-reorganize.png',
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
              src={`/whatsnew/v1-5/${feature.screenshot}`}
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
        <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{feature.description}</p>
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
        src={`/whatsnew/v1-5/${feature.screenshot}`}
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
 * Enhanced first-login popup for the 1.5 release. Larger than the standard
 * ChangelogModal, with a screenshot card per headline feature and a callout
 * pointing at Settings -> Storage, since the new upload limit and formats
 * mean libraries can grow faster than before.
 *
 * Wired in from WhatsNewAutoPopup the first time a user acknowledges any
 * 1.5.x version — whether they arrive at exactly 1.5.0 or jump straight from
 * 1.4 to a later patch. Once acknowledged, later 1.5.x patches fall back to
 * the plain ChangelogModal instead of repeating this. "View full release
 * notes" hands off to that same ChangelogModal in full-history mode via
 * onViewAll.
 */
export function WhatsNewV15Modal({ isOpen, onClose, onAcknowledge, acknowledging, onViewAll }: Props) {
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
      title="What's New in Nebulis 1.5"
      className="w-full max-w-3xl max-h-[85vh] flex flex-col"
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
            v1.5
          </div>
          <h2 className={`text-xl font-bold pr-8 ${heading}`}>What's new in Nebulis</h2>
          <p className={`text-sm mt-1 ${muted}`}>
            Wi-Fi imports for DWARF telescopes, multi-site planning, and room for bigger, higher-fidelity images.
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {FEATURES.map(f => (
              <FeatureCard key={f.title} feature={f} isDark={isDark} onExpand={() => setLightboxFeature(f)} />
            ))}
          </div>

        </div>

        {/* Footer */}
        <div className={`flex items-center justify-between gap-2 px-6 py-3 border-t ${divider}`}>
          <button
            onClick={onViewAll}
            className={`text-xs font-medium transition ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}
          >
            View full release notes
          </button>
          <div className="flex items-center gap-2">
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
          </div>
        </div>
      </div>
      {lightboxFeature && (
        <Lightbox feature={lightboxFeature} onClose={() => setLightboxFeature(null)} />
      )}
    </Modal>
  );
}
