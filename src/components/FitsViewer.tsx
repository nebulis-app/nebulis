import { useEffect, useRef, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ZoomIn, ZoomOut, RotateCw, Contrast, Satellite, Loader2, Clock, Zap, AlertCircle, X, Info, MapPin } from 'lucide-react';
import { identifySatellites, type SatelliteTrailResult } from '../lib/api/observations';
import { fetchBinary } from '../lib/api/client';
import { parseFits, renderFitsToCanvas } from '../lib/fits';
import { FITS_GC_MS } from './lightbox/prefetchFits';

interface FitsViewerProps {
  url: string;
  isDark: boolean;
  filePath?: string;
  fileType?: 'stacked' | 'sub' | 'thumbnail' | 'video' | 'other';
  initialSatResult?: SatelliteTrailResult;
  /** When true, the controls toolbar is hidden — caller manages zoom/stretch in a header. */
  hideControls?: boolean;
  /** Controlled zoom; null means fit-to-container. Ignored when hideControls is false. */
  externalZoom?: number | null;
  /** Controlled stretch (0–1). Ignored when hideControls is false. */
  externalStretch?: number;
  /** Called whenever the fit-to-container zoom is (re)computed. */
  onFitZoomComputed?: (fz: number) => void;
  /** Pixel dimensions of the decoded frame, once they are known. Lets a caller
   *  size its own layout to the frame's shape (the lightbox sizes its panel). */
  onNaturalSize?: (width: number, height: number) => void;
  /** Initial uncontrolled zoom (e.g. 0.32 for 32%). Overridden once the user zooms. */
  initialZoom?: number;
}

export function FitsViewer({
  url,
  isDark,
  filePath,
  fileType,
  initialSatResult,
  hideControls = false,
  externalZoom,
  externalStretch,
  onFitZoomComputed,
  onNaturalSize,
  initialZoom,
}: FitsViewerProps) {
  const { t } = useTranslation('library');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Internal stretch — only used when hideControls=false
  const [internalStretch, setInternalStretch] = useState(0.5);
  const stretch = hideControls && externalStretch !== undefined ? externalStretch : internalStretch;

  const [satDetecting, setSatDetecting] = useState(false);
  const [satResult, setSatResult] = useState<SatelliteTrailResult | null>(initialSatResult ?? null);
  const [satIdentifyDone, setSatIdentifyDone] = useState(false);
  const [satError, setSatError] = useState<string | null>(null);
  const [satModalOpen, setSatModalOpen] = useState(false);
  const [satHelpOpen, setSatHelpOpen] = useState(false);
  const [showLocationPrompt, setShowLocationPrompt] = useState(false);
  const [locationGeoError, setLocationGeoError] = useState<string | null>(null);

  useEffect(() => {
    if (!satModalOpen && !satHelpOpen && !showLocationPrompt) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (satModalOpen) setSatModalOpen(false);
      else if (satHelpOpen) setSatHelpOpen(false);
      else if (showLocationPrompt) { setShowLocationPrompt(false); setLocationGeoError(null); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [satModalOpen, satHelpOpen, showLocationPrompt]);

  // Cached by url (same key namespace as FitsThumbnail/FitsPreview) so
  // navigating away and back to this file — or reopening it in the lightbox
  // after already having viewed it in the grid — doesn't re-download it.
  // staleTime: Infinity because the bytes at a given library URL never change.
  const fitsQuery = useQuery({
    queryKey: ['fits-binary', url],
    queryFn: async ({ signal }) => parseFits(await fetchBinary(url, signal, t), t),
    staleTime: Infinity,
    gcTime: FITS_GC_MS,
    retry: false,
  });
  const fitsData = fitsQuery.data ?? null;
  const loading = fitsQuery.isPending;
  const error = fitsQuery.error instanceof Error ? fitsQuery.error.message : null;

  // Internal zoom state — only used when hideControls=false
  const [fitZoom, setFitZoom] = useState<number | null>(null);
  const [userZoom, setUserZoom] = useState<number | null>(initialZoom ?? null);
  const internalZoom = userZoom ?? fitZoom ?? 1;

  // Effective zoom: external when controlled, internal otherwise
  const zoom = hideControls
    ? (externalZoom !== undefined && externalZoom !== null ? externalZoom : fitZoom ?? 1)
    : internalZoom;

  const handleIdentify = useCallback(async () => {
    // Short-circuit only when we've already run a fresh identifyOnly call for this file,
    // or when the scan found no trail (nothing to identify).
    if (satResult && (satIdentifyDone || !satResult.trailDetected)) { setSatModalOpen(true); return; }
    // The Identify buttons only render with a filePath; this narrows it.
    if (!filePath) return;
    setSatDetecting(true);
    setSatError(null);
    try {
      const result = await identifySatellites(filePath);
      if (result.locationRequired) {
        setShowLocationPrompt(true);
        setLocationGeoError(null);
      } else {
        setSatIdentifyDone(true);
        setSatResult(result);
        setSatModalOpen(true);
      }
    } catch (err) {
      setSatError(err instanceof Error ? err.message : t('fitsViewer.detectionFailed'));
    } finally {
      setSatDetecting(false);
    }
  }, [satResult, satIdentifyDone, filePath, t]);

  const handleShareLocation = useCallback(async () => {
    // Only reachable after an identify call, which needs a filePath.
    if (!filePath) return;
    setLocationGeoError(null);
    setSatDetecting(true);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 })
      );
      const { latitude, longitude } = position.coords;
      setShowLocationPrompt(false);
      const result = await identifySatellites(filePath, latitude, longitude);
      setSatIdentifyDone(true);
      setSatResult(result);
      setSatModalOpen(true);
    } catch (err) {
      setLocationGeoError(
        err instanceof GeolocationPositionError
          ? t('fitsViewer.locationAccessDenied')
          : t('fitsViewer.locationUnavailable')
      );
    } finally {
      setSatDetecting(false);
    }
  }, [filePath, t]);

  useEffect(() => {
    if (fitsData) onNaturalSize?.(fitsData.width, fitsData.height);
  }, [fitsData, onNaturalSize]);

  const computeFit = useCallback(() => {
    const el = containerRef.current;
    if (!el || !fitsData) return;
    const cw = el.clientWidth || el.offsetWidth;
    const ch = el.clientHeight || el.offsetHeight;
    if (cw > 10 && ch > 10) {
      const fz = Math.min(cw / fitsData.width, ch / fitsData.height, 1);
      setFitZoom(fz);
      onFitZoomComputed?.(fz);
    }
  }, [fitsData, onFitZoomComputed]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !fitsData) return;
    computeFit();
    const observer = new ResizeObserver(computeFit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitsData, computeFit]);

  // The satellite-detection UI is per-file, so it resets whenever the
  // displayed file changes. Render-phase reset (not an effect) so the previous
  // file's result never shows for a frame after navigating.
  const [satForUrl, setSatForUrl] = useState(url);
  if (satForUrl !== url) {
    setSatForUrl(url);
    setSatResult(initialSatResult ?? null);
    setSatIdentifyDone(false);
    setSatError(null);
    setSatModalOpen(false);
  }

  useEffect(() => {
    if (!fitsData || !canvasRef.current) return;
    renderFitsToCanvas(canvasRef.current, fitsData, stretch, 'gray', window.devicePixelRatio || 1);
  }, [fitsData, stretch]);

  return (
    <div className={hideControls ? 'w-full h-full flex flex-col' : 'space-y-4'}>
      {/* Loading / error */}
      {(loading || error) && !fitsData && (
        <div className={`flex items-center justify-center h-64 rounded-xl ${
          error
            ? isDark ? 'bg-slate-900 text-danger-500' : 'bg-red-50 text-danger-600'
            : isDark ? 'bg-slate-900' : 'bg-slate-100'
        }`}>
          {error ? error : (
            <div className="flex items-center gap-3">
              <RotateCw className="w-5 h-5 animate-spin text-accent-500" />
              <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>{t('fitsViewer.loadingFitsData')}</span>
            </div>
          )}
        </div>
      )}

      {fitsData && (<>

      {/* Standalone controls — only rendered when not controlled by a parent */}
      {!hideControls && (
        <div className={`flex flex-wrap items-center gap-4 p-3 rounded-xl ${isDark ? 'bg-slate-900' : 'bg-slate-100'}`}>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setUserZoom(Math.max(0.05, internalZoom - 0.1))}
              className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-200'}`}
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-sm font-medium w-14 text-center">{Math.round(internalZoom * 100)}%</span>
            <button
              onClick={() => setUserZoom(Math.min(4, internalZoom + 0.1))}
              className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-200'}`}
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={() => setUserZoom(null)}
              className={`px-2 py-1 rounded-lg text-xs font-medium transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-200 text-slate-500'}`}
            >
              {t('fitsViewer.fit')}
            </button>
            <button
              onClick={() => setUserZoom(1)}
              className={`px-2 py-1 rounded-lg text-xs font-medium transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-200 text-slate-500'}`}
            >
              1:1
            </button>
          </div>

          <div className="flex items-center gap-2">
            <Contrast className="w-4 h-4 text-slate-500" />
            <input
              type="range" min="0" max="1" step="0.01" value={internalStretch}
              onChange={e => setInternalStretch(parseFloat(e.target.value))}
              className="w-32 accent-accent-500"
            />
            <span className="text-xs text-slate-500 w-10">{t('fitsViewer.stretch')}</span>
          </div>

          <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {t('fitsViewer.dimensions', { width: fitsData.width, height: fitsData.height })}
          </span>

          {fitsData?.header?.['DATE-OBS'] && (() => {
            const raw = String(fitsData.header['DATE-OBS']);
            const utc = raw.endsWith('Z') ? raw : raw + 'Z';
            return (
              <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {new Date(utc).toLocaleString()}
              </span>
            );
          })()}

          {filePath && fileType === 'sub' && (
            <button
              onClick={handleIdentify}
              disabled={satDetecting}
              className={`ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                satDetecting
                  ? isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-200 text-slate-400'
                  : satResult
                    ? satResult.trailDetected
                      ? 'bg-amber-500/15 text-amber-500 hover:bg-amber-500/25'
                      : isDark ? 'bg-accent-500/10 text-accent-400 hover:bg-accent-500/20' : 'bg-accent-300 text-accent-700 hover:bg-accent-400'
                    : isDark ? 'bg-accent-500/10 text-accent-400 hover:bg-accent-500/20' : 'bg-accent-300 text-accent-700 hover:bg-accent-400'
              }`}
            >
              {satDetecting ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('fitsViewer.identifying')}</>
              ) : satResult ? (
                <><Satellite className="w-3.5 h-3.5" /> {t('fitsViewer.viewResults')}</>
              ) : (
                <><Satellite className="w-3.5 h-3.5" /> {t('fitsViewer.identifySatellite')}</>
              )}
            </button>
          )}

          <button
            onClick={() => setSatHelpOpen(true)}
            title={t('fitsViewer.howDoesThisWork')}
            className={`p-1.5 rounded-lg transition ${isDark ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-800' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}
          >
            <Info className="w-3.5 h-3.5" />
          </button>

          {satError && (
            <div className={`flex items-center gap-1.5 text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {satError}
            </div>
          )}
        </div>
      )}

      {/* Canvas */}
      <div
        ref={containerRef}
        // Bordered black card on its own; nothing at all when the caller owns
        // the surround. In the lightbox the stage is already a black mat, so
        // the border and fill drew a second rectangle inside it: a wide box
        // with a hairline edge around a narrow portrait frame, which is not
        // what the JPG next to it in the same session looks like.
        className={`relative flex items-center justify-center overflow-auto ${
          hideControls
            ? 'flex-1 min-h-0'
            : `min-h-[300px] max-h-[65vh] rounded-xl border ${
                isDark ? 'border-slate-800 bg-black' : 'border-slate-200 bg-slate-950'
              }`
        }`}
      >
        <canvas
          ref={canvasRef}
          style={{
            display: 'block',
            width: fitsData ? Math.round(fitsData.width * zoom) : undefined,
            height: fitsData ? Math.round(fitsData.height * zoom) : undefined,
          }}
        />

        {/* Satellite button overlay — shown when controls are hidden */}
        {hideControls && filePath && fileType === 'sub' && (
          <div className="absolute top-3 right-3 flex flex-col items-end gap-1.5">
            <button
              onClick={handleIdentify}
              disabled={satDetecting}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow-lg transition ${
                satDetecting
                  ? 'bg-slate-800/80 text-slate-400'
                  : satResult
                    ? satResult.trailDetected
                      ? 'bg-amber-500/80 text-white hover:bg-amber-500'
                      : 'bg-slate-800/80 text-accent-400 hover:bg-slate-700/80'
                    : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700/80'
              }`}
            >
              {satDetecting ? (
                <><Loader2 className="w-3 h-3 animate-spin" /> {t('fitsViewer.scanning')}</>
              ) : satResult ? (
                <><Satellite className="w-3 h-3" /> {satResult.trailDetected ? (satIdentifyDone ? t('fitsViewer.viewResults') : t('fitsViewer.identifySatellite')) : t('fitsViewer.noTrail')}</>
              ) : (
                <><Satellite className="w-3 h-3" /> {t('fitsViewer.identifySatellite')}</>
              )}
            </button>
            {satError && (
              <span className="bg-red-900/80 text-red-300 text-xs px-2 py-1 rounded-lg shadow-lg">
                {satError}
              </span>
            )}
          </div>
        )}
      </div>

      </>)}

      {/* Satellite results modal */}
      {satModalOpen && satResult && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden ${isDark ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'}`}>
            <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
              <div className="flex items-center gap-2">
                <Satellite className="w-5 h-5 text-amber-500" />
                <h3 className={`font-semibold text-base ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  {satResult.nearMissFallback ? t('fitsViewer.potentialCandidates') : t('fitsViewer.satellitesCrossingFov')}
                </h3>
              </div>
              <button
                onClick={() => setSatModalOpen(false)}
                className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {satResult.exposureStart && satResult.exposureSeconds && (
                <div className={`flex items-center gap-2 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  <Clock className="w-4 h-4 flex-shrink-0" />
                  <span>
                    {t('fitsViewer.exposureWindowLabel')}{' '}
                    <strong className={isDark ? 'text-slate-200' : 'text-slate-700'}>
                      {new Date(satResult.exposureStart).toLocaleTimeString()}
                    </strong>
                    {' → '}
                    <strong className={isDark ? 'text-slate-200' : 'text-slate-700'}>
                      {new Date(new Date(satResult.exposureStart).getTime() + satResult.exposureSeconds * 1000).toLocaleTimeString()}
                    </strong>
                    {' '}{t('fitsViewer.exposureSecondsSuffix', { seconds: satResult.exposureSeconds })}
                  </span>
                </div>
              )}

              {satResult.nearMissFallback && (
                <p className={`text-sm rounded-lg px-3 py-2 ${isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-50 text-amber-700'}`}>
                  {t('fitsViewer.nearMissExplanation')}
                </p>
              )}

              {satResult.candidates && satResult.candidates.length > 0 ? (
                <div className="space-y-2">
                  {satResult.candidates.slice(0, 5).map((sat, idx) => (
                    <div
                      key={sat.noradId}
                      className={`flex items-center justify-between p-3 rounded-xl border ${
                        sat.duringExposure
                          ? isDark ? 'bg-amber-500/10 border-amber-500/30' : 'bg-amber-50 border-amber-200'
                          : isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[0.6875rem] font-bold flex-shrink-0 ${
                          sat.duringExposure
                            ? isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-200 text-amber-800'
                            : isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-200 text-slate-500'
                        }`}>
                          {idx + 1}
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className={`font-semibold text-sm ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                              {sat.satellite}
                            </span>
                            {sat.duringExposure && (
                              <span className={`text-[0.625rem] font-medium px-1.5 py-0.5 rounded-full ${
                                isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-100 text-amber-700'
                              }`}>
                                {t('fitsViewer.duringExposure')}
                              </span>
                            )}
                          </div>
                          <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                            {t('fitsViewer.noradId', { id: sat.noradId })}
                          </span>
                        </div>
                      </div>
                      <div className={`flex flex-col items-end gap-0.5 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(sat.crossingTimeUTC).toLocaleTimeString()}
                        </span>
                        <span className="flex items-center gap-1">
                          <Zap className="w-3 h-3" />
                          {t('fitsViewer.velocityDegPerSec', { value: sat.velocityDegPerSec.toFixed(2) })}
                        </span>
                        {satResult.nearMissFallback && sat.angularDistanceFromCenter != null && (
                          <span className={`flex items-center gap-1 ${isDark ? 'text-amber-400/70' : 'text-amber-600'}`}>
                            {t('fitsViewer.awayFromFov', { deg: sat.angularDistanceFromCenter.toFixed(1) })}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {satResult.missingHeaders && satResult.missingHeaders.length > 0
                    ? t('fitsViewer.missingHeaders', { headers: satResult.missingHeaders.join(', ') })
                    : t('fitsViewer.noCatalogedSatellites')}
                </p>
              )}
            </div>

            <div className={`px-5 py-3 border-t flex justify-end ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
              <button
                onClick={() => setSatModalOpen(false)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                {t('fitsViewer.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Location prompt */}
      {showLocationPrompt && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden ${isDark ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'}`}>
            <div className="flex flex-col items-center gap-4 px-6 py-8">
              <div className={`flex items-center justify-center w-12 h-12 rounded-full ${isDark ? 'bg-amber-500/15' : 'bg-amber-50'}`}>
                <MapPin className="w-6 h-6 text-amber-500" />
              </div>
              <div className="text-center space-y-1.5">
                <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {t('fitsViewer.locationNeededTitle')}
                </h3>
                <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {t('fitsViewer.locationNeededBody')}
                </p>
                {locationGeoError && (
                  <p className="text-xs text-red-500">{locationGeoError}</p>
                )}
              </div>
              <div className="flex items-center gap-3 w-full">
                <button
                  onClick={handleShareLocation}
                  disabled={satDetecting}
                  className="flex-1 px-4 py-2 rounded-xl text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 transition"
                >
                  {satDetecting ? <><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />{t('fitsViewer.gettingLocation')}</> : t('fitsViewer.shareLocation')}
                </button>
                <button
                  onClick={() => { setShowLocationPrompt(false); setLocationGeoError(null); }}
                  disabled={satDetecting}
                  className={`flex-1 px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 ${isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  {t('fitsViewer.cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* How satellite detection works */}
      {satHelpOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-2xl shadow-2xl overflow-hidden ${isDark ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'}`}>
            <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4 text-accent-400" />
                <h3 className={`font-semibold text-base ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  {t('fitsViewer.howDetectionWorksTitle')}
                </h3>
              </div>
              <button
                onClick={() => setSatHelpOpen(false)}
                className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className={`p-5 space-y-4 text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              <div className="space-y-1.5">
                <p className={`font-semibold text-xs uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('fitsViewer.step1Title')}</p>
                <p>{t('fitsViewer.step1Body')}</p>
              </div>
              <div className="space-y-1.5">
                <p className={`font-semibold text-xs uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('fitsViewer.step2Title')}</p>
                <p>{t('fitsViewer.step2Body')}</p>
              </div>
              <div className="space-y-1.5">
                <p className={`font-semibold text-xs uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('fitsViewer.aboutResultsTitle')}</p>
                <p>{t('fitsViewer.aboutResultsBody')}</p>
              </div>
            </div>

            <div className={`px-5 py-3 border-t flex justify-end ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
              <button
                onClick={() => setSatHelpOpen(false)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                {t('fitsViewer.gotIt')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
