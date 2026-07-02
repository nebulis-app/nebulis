import { useEffect, useRef, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { X, ExternalLink, Telescope, CalendarDays, MapPin, ChevronLeft, ChevronRight, ZoomIn, EyeOff } from 'lucide-react';
import type { CatalogProgressObject } from '../../lib/api/catalogs';
import { getCatalogObjectInfo } from '../../lib/api/catalog';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { computeBestImagingWindow, isUpTonight } from '../../lib/bestImagingWindow';

interface Props {
  object: CatalogProgressObject;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  observerLat: number | null;
  observerLon: number | null;
  minAlt?: number;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
  onClose: () => void;
}


function BestImagingChart({
  months,
  windowStart,
  windowEnd,
  minAlt,
  isDark,
  isNight,
  isSpace,
}: {
  months: ReturnType<typeof computeBestImagingWindow>['months'];
  windowStart: string | null;
  windowEnd: string | null;
  minAlt: number;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const accentColor = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';

  const maxAlt = Math.max(...months.map(m => m.maxAlt), minAlt + 10, 30);
  const W = 420;
  const H = 100;
  const PAD = { top: 10, bottom: 20, left: 28, right: 8 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const barW = Math.floor(chartW / months.length) - 2;

  function yFor(alt: number) {
    return PAD.top + chartH - (Math.max(0, alt) / maxAlt) * chartH;
  }

  const minAltY = yFor(minAlt);

  return (
    <div>
      <div className={`text-xs font-medium mb-2 flex items-center gap-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        <CalendarDays className="w-3.5 h-3.5" />
        Max altitude during darkness — next 12 months
        {windowStart && windowEnd && (
          <span className="ml-auto font-semibold" style={{ color: accentColor }}>
            Best: {windowStart === windowEnd ? windowStart : `${windowStart} – ${windowEnd}`}
          </span>
        )}
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          style={{ maxHeight: 100 }}
          onMouseLeave={() => setHovered(null)}
        >
          {/* Altitude gridlines */}
          {[0, 30, 60, 90].map(alt => {
            if (alt > maxAlt + 5) return null;
            const y = yFor(alt);
            return (
              <g key={alt}>
                <line
                  x1={PAD.left} y1={y} x2={W - PAD.right} y2={y}
                  stroke={isDark ? '#334155' : '#e2e8f0'}
                  strokeWidth="0.5"
                  strokeDasharray="3,3"
                />
                <text x={PAD.left - 4} y={y + 3.5} textAnchor="end" fontSize="7" fill={isDark ? '#64748b' : '#94a3b8'}>
                  {alt}°
                </text>
              </g>
            );
          })}

          {/* Min-alt threshold line */}
          <line
            x1={PAD.left} y1={minAltY} x2={W - PAD.right} y2={minAltY}
            stroke={isDark ? '#ef4444' : '#f87171'}
            strokeWidth="1"
            strokeDasharray="4,2"
            opacity="0.6"
          />

          {/* Bars */}
          {months.map((m, i) => {
            const x = PAD.left + i * (chartW / months.length) + 1;
            const barH = Math.max(0, (Math.max(0, m.maxAlt) / maxAlt) * chartH);
            const barY = PAD.top + chartH - barH;
            const isHovered = hovered === i;
            const fillColor = m.aboveMinAlt ? accentColor : isDark ? '#334155' : '#cbd5e1';
            const opacity = m.aboveMinAlt ? (isHovered ? 1 : 0.8) : (isHovered ? 0.5 : 0.3);

            return (
              <g key={i} onMouseEnter={() => setHovered(i)}>
                <rect
                  x={x}
                  y={barY}
                  width={barW}
                  height={barH}
                  rx="1"
                  fill={fillColor}
                  opacity={opacity}
                  style={{ transition: 'opacity 0.1s' }}
                />
                {/* Month label */}
                <text
                  x={x + barW / 2}
                  y={H - 5}
                  textAnchor="middle"
                  fontSize="7"
                  fill={isDark ? '#64748b' : '#94a3b8'}
                >
                  {m.label}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Tooltip */}
        {hovered !== null && (
          <div className={`absolute -top-8 pointer-events-none text-[11px] px-2 py-0.5 rounded shadow-lg ${isDark ? 'bg-slate-800 text-white' : 'bg-white text-slate-900 border border-slate-200'}`}
            style={{ left: `${(hovered / months.length) * 100}%`, transform: 'translateX(-40%)' }}
          >
            {months[hovered].label}: {months[hovered].maxAlt > 0 ? `${months[hovered].maxAlt}°` : 'below horizon'}
          </div>
        )}
      </div>
    </div>
  );
}

export function CatalogObjectModal({
  object,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  observerLat,
  observerLon,
  minAlt = 20,
  isDark,
  isNight,
  isSpace,
  onClose,
}: Props) {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasLocation = observerLat != null && observerLon != null;
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setLightboxOpen(false);
  }, [object.id]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); if (hasPrev) onPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (hasNext) onNext(); }
      else if (e.key === 'Escape') {
        if (lightboxOpen) setLightboxOpen(false);
        else onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasPrev, hasNext, onPrev, onNext, onClose, lightboxOpen]);

  const { data: info } = useQuery({
    queryKey: ['catalog-info', object.id],
    queryFn: () => getCatalogObjectInfo(object.id),
    staleTime: Infinity,
  });

  const imgUrl = getCatalogThumbnailUrl(object.id, object.majorAxisArcmin);
  const lightboxImgUrl = getCatalogThumbnailUrl(object.id, object.majorAxisArcmin, 800, 800);

  const bestWindow = useMemo(() => {
    if (!hasLocation || object.ra == null || object.dec == null) return null;
    return computeBestImagingWindow(
      object.ra,
      object.dec,
      observerLat!,
      observerLon!,
      minAlt,
    );
  }, [object.ra, object.dec, observerLat, observerLon, minAlt, hasLocation]);

  // Does the object ever clear the horizon during tonight's dark window from
  // this location? null = can't tell (no location / no coords / no dark window),
  // in which case we don't warn or disable anything.
  const upTonight = useMemo(
    () => isUpTonight(object.ra, object.dec, observerLat, observerLon),
    [object.ra, object.dec, observerLat, observerLon],
  );
  const notVisibleTonight = upTonight === false;

  const description = info?.description?.trim() || '';
  const wikiUrl = info?.wikiUrl || null;

  const accentBg = isNight ? 'bg-red-500' : isSpace ? 'bg-violet-500' : 'bg-amber-500';
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-amber-400';
  const borderColor = isDark ? 'border-slate-700/40' : 'border-slate-200';

  function handleGoToObservations() {
    if (object.libraryObjectId) {
      navigate(`/object/${encodeURIComponent(object.libraryObjectId)}`);
      onClose();
    }
  }

  function handlePlannerClick() {
    if (notVisibleTonight) return; // not above the horizon tonight — nothing to plan
    // Use the canonical NGC/IC ID so the planner's search finds it.
    // Caldwell IDs like 'C61' don't appear in the planner — 'NGC4039' does.
    const searchQuery = object.ngcName || object.id;
    navigate('/planner', { state: { searchQuery } });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      {/* Wrapper: flex row so arrows flank the card */}
      <div className="flex items-center gap-3 w-full max-w-[820px]" onClick={(e) => e.stopPropagation()}>

        {/* Left arrow */}
        <button
          onClick={onPrev}
          className={`shrink-0 p-2.5 rounded-full text-white border border-white/20 transition-all ${
            hasPrev ? 'bg-black/50 hover:bg-black/70' : 'invisible pointer-events-none'
          }`}
          aria-label="Previous object"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

      <div
        ref={scrollRef}
        className={`flex-1 min-w-0 rounded-2xl shadow-2xl max-h-[92vh] overflow-y-auto ${
          isDark ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900'
        }`}
      >
        {/* Header */}
        <div className={`flex items-start justify-between p-5 border-b ${borderColor} gap-4`}>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-display font-bold tracking-tight">
                {object.id}
              </h2>
              {object.name !== object.id && (
                <span className={`text-base font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                  {object.name}
                </span>
              )}
              {object.isImaged && (
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-white ${accentBg}`}>
                  Imaged ({object.sessionCount} session{object.sessionCount !== 1 ? 's' : ''})
                </span>
              )}
            </div>
            <div className={`flex items-center flex-wrap gap-3 mt-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              <span>{object.type}</span>
              {object.constellation && <span>· {object.constellation}</span>}
              {object.magnitude != null && <span>· Mag {object.magnitude.toFixed(1)}</span>}
              {object.ra != null && object.dec != null && (
                <span className="flex items-center gap-1">
                  · RA {object.ra.toFixed(2)}h · Dec {object.dec.toFixed(2)}°
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className={`shrink-0 p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5">
          {/* Image + description row */}
          <div className="flex gap-4 items-start">
            <button
              onClick={() => setLightboxOpen(true)}
              className={`w-36 h-36 shrink-0 rounded-xl overflow-hidden border group relative cursor-pointer ${
                isDark ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-slate-100'
              }`}
              aria-label="View larger image"
            >
              <img
                src={imgUrl}
                alt={`Reference image of ${object.id}`}
                loading="lazy"
                className="w-full h-full object-cover transition-opacity group-hover:opacity-75"
              />
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="bg-black/50 rounded-full p-1.5">
                  <ZoomIn className="w-4 h-4 text-white" />
                </div>
              </div>
            </button>
            <div className="min-w-0">
              {description ? (
                <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                  {description}
                </p>
              ) : (
                <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  No description available.
                </p>
              )}
              {wikiUrl && (
                <a
                  href={wikiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex items-center gap-1 text-xs mt-2 ${accentText} hover:opacity-80`}
                >
                  <ExternalLink className="w-3 h-3" />
                  Wikipedia
                </a>
              )}
            </div>
          </div>

          {/* Best imaging window chart */}
          {hasLocation && bestWindow ? (
            <div className={`rounded-xl p-4 ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
              <BestImagingChart
                months={bestWindow.months}
                windowStart={bestWindow.windowStart}
                windowEnd={bestWindow.windowEnd}
                minAlt={minAlt}
                isDark={isDark}
                isNight={isNight}
                isSpace={isSpace}
              />
              {!bestWindow.everVisible && (
                <p className={`text-xs mt-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  This object stays below your minimum altitude ({minAlt}°) during darkness year-round from your location.
                </p>
              )}
            </div>
          ) : !hasLocation ? (
            <div className={`rounded-xl p-4 flex items-center gap-2 text-sm ${isDark ? 'bg-slate-800/60 text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
              <MapPin className="w-4 h-4 shrink-0" />
              Set your location in Settings to see the best imaging window for your sky.
            </div>
          ) : null}

          {/* Not-visible-tonight warning */}
          {notVisibleTonight && (
            <div className="rounded-xl p-3 flex items-start gap-2 text-sm bg-red-500/10 text-red-400 border border-red-500/30">
              <EyeOff className="w-4 h-4 shrink-0 mt-0.5" />
              <span>This object stays below the horizon all night from your location, so you can't see it tonight.</span>
            </div>
          )}

          {/* Actions */}
          <div className={`flex flex-wrap gap-2 pt-1 border-t ${borderColor}`}>
            {object.isImaged ? (
              <button
                onClick={handleGoToObservations}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition text-white ${
                  isNight ? 'bg-red-600 hover:bg-red-500' : isSpace ? 'bg-violet-600 hover:bg-violet-500' : 'bg-amber-600 hover:bg-amber-500'
                }`}
              >
                <Telescope className="w-4 h-4" />
                View observations
              </button>
            ) : null}
            <button
              onClick={handlePlannerClick}
              disabled={notVisibleTonight}
              title={notVisibleTonight ? "This object isn't visible from your location tonight." : undefined}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition border ${
                notVisibleTonight
                  ? isDark
                    ? 'bg-slate-800 text-slate-500 border-slate-700 cursor-not-allowed'
                    : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                  : isNight
                    ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border-red-500/30'
                    : isSpace
                      ? 'bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 border-violet-500/30'
                      : isDark
                        ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border-accent-500/30'
                        : 'bg-accent-300 text-accent-700 hover:bg-accent-400 border-accent-400'
              }`}
            >
              <CalendarDays className="w-4 h-4" />
              Open in Planner
            </button>
          </div>
        </div>
      </div>

        {/* Right arrow */}
        <button
          onClick={onNext}
          className={`shrink-0 p-2.5 rounded-full text-white border border-white/20 transition-all ${
            hasNext ? 'bg-black/50 hover:bg-black/70' : 'invisible pointer-events-none'
          }`}
          aria-label="Next object"
        >
          <ChevronRight className="w-5 h-5" />
        </button>

      </div>

      {lightboxOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 backdrop-blur-sm"
          onClick={() => setLightboxOpen(false)}
        >
          <div
            className="relative"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={lightboxImgUrl}
              alt={`Reference image of ${object.id}`}
              className="max-w-[85vw] max-h-[85vh] rounded-2xl object-contain shadow-2xl"
            />
            <button
              onClick={() => setLightboxOpen(false)}
              className="absolute -top-3 -right-3 p-1.5 bg-black/80 hover:bg-black rounded-full text-white transition"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
