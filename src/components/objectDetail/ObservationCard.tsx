/**
 * One night on this target.
 *
 * The card used to carry a thumbnail, a date, and file counts. That is enough
 * to find a night but not to choose between two of them: which rig shot it,
 * how much integration it holds, what the sky was doing, and whether you left
 * yourself a note were all a page-load away. All four are on the card now, in a
 * single wrapped line of facts under the date, so the grid stays scannable
 * rather than turning into a stack of labelled rows.
 *
 * The counts it shows are the ones that describe the night's yield (frames,
 * subs, processed versions). Raw `fileCount` is deliberately not among them: it
 * counts thumbnails and sidecars too, so it always read higher than anything a
 * person could point at in the file list.
 */
import { Link } from 'react-router-dom';
import { useState } from 'react';
import {
  Cloud, Film, Image as ImageIcon, Layers, NotebookPen, RotateCw, Sparkles, Thermometer, Timer, Trash2,
} from 'lucide-react';
import { formatTemp } from '../../lib/forecastScore';
import { formatIntegration } from './objectStats';
import type { SessionCaptureSummary, SessionWeather } from '../../types';

export interface ObservationCardModel {
  /** The variant this night belongs to, which is what the link must point at.
   *  Not always the base object: a mosaic's night lives under its own id. */
  objectId: string;
  id: string;
  date: string;
  stackedCount: number;
  subFrameCount: number;
  processedCount: number;
  /** Non-thumbnail stills and video captures for the night. Used to tell a
   *  video-only session (lunar/planetary timelapse) apart from one with a real
   *  frame, so the card can stop borrowing the object thumbnail for it. */
  imageCount?: number;
  videoCount?: number;
  thumbnailUrl: string;
  weather: SessionWeather | null;
  /** "Mosaic", "Hα" and so on. Null for the base object's own nights. */
  variantLabel: string | null;
  /** From the device sidecar. Null when this night recorded none. */
  capture: SessionCaptureSummary | null;
  telescope: { name: string; color: string } | null;
  hasNote: boolean;
}

interface Props {
  observation: ObservationCardModel;
  isDark: boolean;
  tempUnit: 'celsius' | 'fahrenheit';
  onDelete: (() => void) | null;
}

/** `YYYY-MM-DD` as "Fri, Mar 15", with the year kept separate so the eye lands
 *  on the night rather than on four digits that are usually the same. */
function splitDate(date: string): { day: string; year: string } | null {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return null;
  // Constructed local, never parsed from the ISO string, which is UTC midnight
  // and renders as the previous day west of Greenwich.
  const dt = new Date(y, m - 1, d);
  return {
    day: dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    year: String(y),
  };
}

function variantBadgeClass(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('mosaic')) return 'bg-amber-500/90 text-white';
  if (l === 'hα' || l === 'ha') return 'bg-red-500/90 text-white';
  if (l === 'oiii') return 'bg-cyan-500/90 text-white';
  if (l === 'sii') return 'bg-blue-500/90 text-white';
  return 'bg-violet-500/90 text-white';
}

export function ObservationCard({ observation: o, isDark, tempUnit, onDelete }: Props) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);

  const parts = splitDate(o.date);
  const videoCount = o.videoCount ?? 0;
  // A night that produced only video has no still of its own; the thumbnail URL
  // would fall back to the object's overall image, which reads as a captured
  // frame that isn't there. Show a video placeholder instead.
  const videoOnly = videoCount > 0
    && o.stackedCount === 0 && o.processedCount === 0 && o.subFrameCount === 0 && (o.imageCount ?? 0) === 0;
  const facts: { key: string; icon: typeof Layers; text: string }[] = [];

  if (o.capture?.integrationSec != null) {
    facts.push({ key: 'integration', icon: Timer, text: formatIntegration(o.capture.integrationSec) });
  }
  if (o.capture?.framesStacked != null) {
    facts.push({ key: 'frames', icon: Layers, text: `${o.capture.framesStacked.toLocaleString()} frames` });
  } else if (o.stackedCount > 0) {
    facts.push({ key: 'stacked', icon: Layers, text: `${o.stackedCount} stacked` });
  }
  if (o.subFrameCount > 0) {
    facts.push({ key: 'subs', icon: ImageIcon, text: `${o.subFrameCount.toLocaleString()} subs` });
  }
  if (o.processedCount > 0) {
    facts.push({ key: 'processed', icon: Sparkles, text: `${o.processedCount} processed` });
  }
  if (videoCount > 0) {
    facts.push({ key: 'video', icon: Film, text: `${videoCount} video${videoCount !== 1 ? 's' : ''}` });
  }
  if (o.weather?.cloudCover != null) {
    facts.push({ key: 'cloud', icon: Cloud, text: `${Math.round(o.weather.cloudCover)}% cloud` });
  }
  if (o.weather?.temperature != null) {
    facts.push({ key: 'temp', icon: Thermometer, text: formatTemp(o.weather.temperature, tempUnit) });
  }

  return (
    <div className={`group relative overflow-hidden rounded-2xl border transition-all ${
      isDark
        ? 'border-slate-800 bg-slate-900 hover:border-slate-700'
        : 'border-slate-200 bg-white shadow-sm hover:border-slate-300 hover:shadow-md'
    }`}>
      <Link to={`/observations/${encodeURIComponent(o.objectId)}/${encodeURIComponent(o.date)}`} className="block">
        <div className={`relative h-44 overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
          {o.variantLabel && (
            <span className={`absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5
              text-[11px] font-semibold ${variantBadgeClass(o.variantLabel)}`}>
              {o.variantLabel.toLowerCase().includes('mosaic') && <Layers className="h-3 w-3" />}
              {o.variantLabel}
            </span>
          )}
          {videoOnly ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <Film className={`h-8 w-8 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
              <span className={`text-xs font-medium ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {videoCount > 1 ? `${videoCount} videos` : 'Video'}
              </span>
            </div>
          ) : !imgError ? (
            <>
              {!imgLoaded && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <RotateCw className="h-6 w-6 animate-spin text-accent-500/40" />
                </div>
              )}
              <img
                src={o.thumbnailUrl}
                alt=""
                loading="lazy"
                onLoad={() => setImgLoaded(true)}
                onError={() => setImgError(true)}
                className={`h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]
                  ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
              />
            </>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <ImageIcon className={`h-8 w-8 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
              <span className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>No preview</span>
            </div>
          )}
        </div>

        <div className="space-y-2.5 p-4">
          <div className="flex items-baseline gap-2">
            <span className={`font-display text-[15px] font-semibold tracking-tight ${
              isDark ? 'text-slate-100' : 'text-slate-800'
            }`}>
              {parts ? parts.day : 'Unknown date'}
            </span>
            {parts && (
              <span className={`text-xs tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {parts.year}
              </span>
            )}
            {o.hasNote && (
              <NotebookPen
                className={`ml-auto h-3.5 w-3.5 shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}
                aria-label="Has notes"
              />
            )}
          </div>

          {o.telescope && (
            <div className={`flex items-center gap-1.5 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: o.telescope.color }} />
              <span className="truncate">{o.telescope.name}</span>
            </div>
          )}

          <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs ${
            isDark ? 'text-slate-500' : 'text-slate-400'
          }`}>
            {facts.length > 0
              ? facts.map(({ key, icon: Icon, text }) => (
                  <span key={key} className="inline-flex items-center gap-1 tabular-nums">
                    <Icon className="h-3 w-3 shrink-0" />
                    {text}
                  </span>
                ))
              : <span>No files</span>}
          </div>
        </div>
      </Link>

      {onDelete && (
        <button
          onClick={e => { e.preventDefault(); onDelete(); }}
          className="absolute right-2 top-2 rounded-lg bg-red-600/80 p-1.5 text-white opacity-0 transition
            hover:bg-red-600 focus-visible:opacity-100 group-hover:opacity-100"
          title="Delete observation"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
