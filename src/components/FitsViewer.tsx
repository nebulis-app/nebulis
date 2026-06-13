import { useEffect, useRef, useState, useCallback } from 'react';
import { ZoomIn, ZoomOut, RotateCw, Contrast, Satellite, Loader2, Clock, Zap, AlertCircle, X, Info, MapPin } from 'lucide-react';
import { identifySatellites, type SatelliteTrailResult } from '../lib/api/observations';
import { fetchBinary } from '../lib/api/client';
import { parseFits, renderFitsToCanvas, type FitsHeader } from '../lib/fits';

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
  initialZoom,
}: FitsViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Internal stretch — only used when hideControls=false
  const [internalStretch, setInternalStretch] = useState(0.5);
  const stretch = hideControls && externalStretch !== undefined ? externalStretch : internalStretch;

  const [satDetecting, setSatDetecting] = useState(false);
  const [satResult, setSatResult] = useState<SatelliteTrailResult | null>(initialSatResult ?? null);
  const [satError, setSatError] = useState<string | null>(null);
  const [satModalOpen, setSatModalOpen] = useState(false);
  const [satHelpOpen, setSatHelpOpen] = useState(false);
  const [showLocationPrompt, setShowLocationPrompt] = useState(false);
  const [locationGeoError, setLocationGeoError] = useState<string | null>(null);
  const initialSatResultRef = useRef(initialSatResult ?? null);

  const [fitsData, setFitsData] = useState<{
    imageData: Float64Array;
    width: number;
    height: number;
    header: FitsHeader;
  } | null>(null);

  // Internal zoom state — only used when hideControls=false
  const [fitZoom, setFitZoom] = useState<number | null>(null);
  const [userZoom, setUserZoom] = useState<number | null>(initialZoom ?? null);
  const internalZoom = userZoom ?? fitZoom ?? 1;

  // Effective zoom: external when controlled, internal otherwise
  const zoom = hideControls
    ? (externalZoom !== undefined && externalZoom !== null ? externalZoom : fitZoom ?? 1)
    : internalZoom;

  const handleIdentify = useCallback(async () => {
    if (satResult) { setSatModalOpen(true); return; }
    setSatDetecting(true);
    setSatError(null);
    try {
      const result = await identifySatellites(filePath!);
      if (result.locationRequired) {
        setShowLocationPrompt(true);
        setLocationGeoError(null);
      } else {
        setSatResult(result);
        setSatModalOpen(true);
      }
    } catch (err) {
      setSatError(err instanceof Error ? err.message : 'Detection failed');
    } finally {
      setSatDetecting(false);
    }
  }, [satResult, filePath]);

  const handleShareLocation = useCallback(async () => {
    setLocationGeoError(null);
    setSatDetecting(true);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 })
      );
      const { latitude, longitude } = position.coords;
      setShowLocationPrompt(false);
      const result = await identifySatellites(filePath!, latitude, longitude);
      setSatResult(result);
      setSatModalOpen(true);
    } catch (err) {
      setLocationGeoError(
        err instanceof GeolocationPositionError
          ? 'Location access was denied. Set your location in Settings instead.'
          : 'Could not get your location. Set it in Settings instead.'
      );
    } finally {
      setSatDetecting(false);
    }
  }, [filePath]);

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

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setSatResult(initialSatResultRef.current);
    setSatError(null);
    setSatModalOpen(false);

    fetchBinary(url, controller.signal)
      .then(buffer => {
        const parsed = parseFits(buffer);
        setFitsData(parsed);
        setLoading(false);
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err.message);
        setLoading(false);
      });

    return () => { controller.abort(); };
  }, [url]);

  useEffect(() => {
    if (!fitsData || !canvasRef.current) return;
    renderFitsToCanvas(canvasRef.current, fitsData.imageData, fitsData.width, fitsData.height, stretch, 'gray', window.devicePixelRatio || 1);
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
              <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Loading FITS data...</span>
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
              Fit
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
            <span className="text-xs text-slate-500 w-10">Stretch</span>
          </div>

          <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {fitsData.width} × {fitsData.height} px
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
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Identifying...</>
              ) : satResult ? (
                <><Satellite className="w-3.5 h-3.5" /> View Results</>
              ) : (
                <><Satellite className="w-3.5 h-3.5" /> Identify Satellite</>
              )}
            </button>
          )}

          <button
            onClick={() => setSatHelpOpen(true)}
            title="How does this work?"
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
        className={`relative overflow-auto rounded-xl border flex items-center justify-center ${
          hideControls
            ? 'flex-1 min-h-0'
            : 'min-h-[300px] max-h-[65vh]'
        } ${isDark ? 'border-slate-800 bg-black' : 'border-slate-200 bg-slate-950'}`}
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
                <><Loader2 className="w-3 h-3 animate-spin" /> Scanning...</>
              ) : satResult ? (
                <><Satellite className="w-3 h-3" /> {satResult.trailDetected ? 'Identify Satellite' : 'No trail'}</>
              ) : (
                <><Satellite className="w-3 h-3" /> Identify Satellite</>
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
                  {satResult.nearMissFallback ? 'Potential Candidates' : 'Satellites Crossing This FOV'}
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
                    Exposure window:{' '}
                    <strong className={isDark ? 'text-slate-200' : 'text-slate-700'}>
                      {new Date(satResult.exposureStart).toLocaleTimeString()}
                    </strong>
                    {' → '}
                    <strong className={isDark ? 'text-slate-200' : 'text-slate-700'}>
                      {new Date(new Date(satResult.exposureStart).getTime() + satResult.exposureSeconds * 1000).toLocaleTimeString()}
                    </strong>
                    {' '}({satResult.exposureSeconds}s)
                  </span>
                </div>
              )}

              {satResult.nearMissFallback && (
                <p className={`text-sm rounded-lg px-3 py-2 ${isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-50 text-amber-700'}`}>
                  No cataloged satellite was confirmed inside the FOV during this exposure. These satellites passed nearby and may be the source - TLE accuracy degrades over time, so a close pass could still be a match. The trail may also be classified debris or an uncataloged object.
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
                        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${
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
                              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                                isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-100 text-amber-700'
                              }`}>
                                during exposure
                              </span>
                            )}
                          </div>
                          <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                            NORAD {sat.noradId}
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
                          {sat.velocityDegPerSec.toFixed(2)}°/s
                        </span>
                        {satResult.nearMissFallback && sat.angularDistanceFromCenter != null && (
                          <span className={`flex items-center gap-1 ${isDark ? 'text-amber-400/70' : 'text-amber-600'}`}>
                            {sat.angularDistanceFromCenter.toFixed(1)}° from FOV
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {satResult.missingHeaders && satResult.missingHeaders.length > 0
                    ? `Cannot identify - missing FITS headers: ${satResult.missingHeaders.join(', ')}`
                    : 'No cataloged satellites found passing this FOV during the exposure.'}
                </p>
              )}
            </div>

            <div className={`px-5 py-3 border-t flex justify-end ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
              <button
                onClick={() => setSatModalOpen(false)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                Close
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
                  Location needed to identify satellites
                </h3>
                <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  This frame doesn't include observer coordinates, and no location is saved in Settings.
                  Share your location to identify which satellite made this trail.
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
                  {satDetecting ? <><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />Getting location...</> : 'Share location'}
                </button>
                <button
                  onClick={() => { setShowLocationPrompt(false); setLocationGeoError(null); }}
                  disabled={satDetecting}
                  className={`flex-1 px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 ${isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  Cancel
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
                  How satellite detection works
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
                <p className={`font-semibold text-xs uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Step 1: Trail detection</p>
                <p>The FITS image is scanned for straight bright streaks using projection analysis across 180 angles. Background gradients and nebulosity are subtracted first, and stars are masked so only linear features remain as candidates.</p>
              </div>
              <div className="space-y-1.5">
                <p className={`font-semibold text-xs uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Step 2: Satellite identification</p>
                <p>If a trail is found, the FITS header is read for the exposure start time and sky coordinates (RA/Dec). Those are used to query an orbital catalog (TLE data) and compute which satellites were crossing that patch of sky during the exposure window.</p>
              </div>
              <div className="space-y-1.5">
                <p className={`font-semibold text-xs uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>About the results</p>
                <p>Satellites confirmed inside the field of view during the exposure are listed first. When no exact match is found, nearby candidates are shown — TLE orbital data degrades over time, so a satellite that passed close to the edge may still be the source. The trail could also be uncataloged debris.</p>
              </div>
            </div>

            <div className={`px-5 py-3 border-t flex justify-end ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
              <button
                onClick={() => setSatHelpOpen(false)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
