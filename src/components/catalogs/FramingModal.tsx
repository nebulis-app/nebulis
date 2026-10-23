/**
 * Framing & mosaic planner.
 *
 * Draws the telescope's sensor rectangle (and an optional mosaic grid) over the
 * object's catalog sky image so the user can answer "will this fit, and how
 * should I rotate it" before going out. The image is a DSS2 cutout centered on
 * the object; its angular width equals the requested `fov` (degrees), which
 * gives an exact degrees-per-unit scale for the SVG overlay.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, RotateCw, Plus, Minus, Crosshair, Check, Save, BookmarkPlus, Bookmark, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listTelescopes } from '../../lib/api/telescopes';
import { getCatalogEntry } from '../../lib/api/catalog';
import { FitBadge } from '../FitBadge';
import {
  FOV_PROFILES,
  objectExtentArcmin,
  mosaicCoverageDeg,
  autoMosaicForObject,
  classifyFit,
  fitDisplayStrings,
  formatFovDeg,
  readFovSetup,
  writeFovSetup,
  resolveFov,
  telescopeProfileOptionId,
  CUSTOM_FOV_PROFILE_ID,
  TELESCOPE_PROFILE_PREFIX,
  readSavedCustomRigs,
  saveCustomRig,
  updateCustomRig,
  deleteCustomRig,
  customRigOptionId,
  CUSTOM_RIG_PREFIX,
  type CustomOptics,
  type FovSetup,
  type SavedCustomRig,
} from '../../lib/telescopeFov';

interface FramingModalProps {
  catalogId: string;
  objectName: string;
  isDark: boolean;
  onClose: () => void;
  /** When set, the modal offers a "save framing" action that hands the
   *  serialized mosaic back via `onSaveFraming` so the caller can attach it
   *  to that specific scheduled planner block. Omitted (or no `onSaveFraming`)
   *  means "just previewing" — e.g. from Object/Observation Detail, where
   *  there is no planner session to save into. */
  savedFraming?: string | null;
  onSaveFraming?: (framingSetupJson: string) => void;
}

/** The subset of the modal's state that gets saved to a planner session:
 *  the mosaic grid + rotation the user built, not the telescope pick (which
 *  is already a global preference persisted separately, see FovSetup). */
interface SavedMosaicFraming {
  cols: number;
  rows: number;
  overlap: number;
  rotationDeg: number;
}

function parseSavedFraming(json: string | null | undefined): SavedMosaicFraming | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === 'object' && parsed !== null
      && 'cols' in parsed && 'rows' in parsed && 'overlap' in parsed && 'rotationDeg' in parsed
      && typeof parsed.cols === 'number' && typeof parsed.rows === 'number'
      && typeof parsed.overlap === 'number' && typeof parsed.rotationDeg === 'number'
    ) {
      return { cols: parsed.cols, rows: parsed.rows, overlap: parsed.overlap, rotationDeg: parsed.rotationDeg };
    }
  } catch {
    /* malformed/legacy data — fall back to defaults */
  }
  return null;
}

/**
 * Feature flag for the Framing & Mosaic planner. Kept around in case a future
 * change needs to hide it again quickly (e.g. while the DSS cutout source is
 * unavailable); flip to `false` to pull the entry-point buttons on the object,
 * observation detail, planner and catalogs pages. The planner spans this
 * modal, `src/lib/telescopeFov.ts`, `src/hooks/useResolvedFov.ts` (the
 * Planner list's and Catalogs board's fit badges), and
 * `GET /api/catalog/:id/sky`.
 */
export const FRAMING_MOSAIC_ENABLED: boolean = true;

const CUSTOM_ID = CUSTOM_FOV_PROFILE_ID;
const OVERLAP_OPTIONS = [0, 0.1, 0.15, 0.2];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Coarse FOV buckets, matching the server's bucketCutoutFov so a given zoom
// level reuses one cached cutout and the overlay scale stays in lock-step with
// the image the server actually returns.
function bucketFov(fovDeg: number): number {
  const f = clamp(fovDeg, 0.1, 20);
  if (f < 2) return Math.round(f * 10) / 10;
  if (f < 6) return Math.round(f * 2) / 2;
  return Math.round(f);
}

export function FramingModal({ catalogId, objectName, isDark, onClose, savedFraming, onSaveFraming }: FramingModalProps) {
  const { t } = useTranslation('catalogs');
  // Parsed once on open; a later save doesn't need to re-derive this.
  const [initialSaved] = useState(() => parseSavedFraming(savedFraming));
  // Fetch the object's angular size ourselves so both the object page and the
  // observation page only have to hand us a catalog id.
  const { data: catalogEntry } = useQuery({
    queryKey: ['catalog', catalogId],
    queryFn: () => getCatalogEntry(catalogId),
    enabled: !!catalogId,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const majorAxisArcmin = catalogEntry?.majorAxisArcmin ?? null;
  const sizeStr = catalogEntry?.size ?? null;

  // Saved framing setup (telescope pick + custom optics), persisted to
  // localStorage on every change so it sticks across sessions and is what
  // the Planner list's and Catalogs board's fit badges read too — see
  // useResolvedFov.ts. A null `profileId` means "follow whichever telescope
  // is configured under Settings → Telescopes" until the user picks one here.
  const [setup, setSetup] = useState<FovSetup>(readFovSetup);
  const [rotationDeg, setRotationDeg] = useState(initialSaved?.rotationDeg ?? 0);
  const [cols, setCols] = useState(initialSaved?.cols ?? 1);
  const [rows, setRows] = useState(initialSaved?.rows ?? 1);
  const [overlap, setOverlap] = useState(initialSaved?.overlap ?? 0.1);
  const [erroredSrc, setErroredSrc] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current); }, []);

  const handleSaveFraming = () => {
    if (!onSaveFraming) return;
    onSaveFraming(JSON.stringify({ cols, rows, overlap, rotationDeg } satisfies SavedMosaicFraming));
    setJustSaved(true);
    if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
    savedFlashTimer.current = setTimeout(() => setJustSaved(false), 2000);
  };

  // Default the model to the user's active telescope until they change it.
  const { data: telescopes } = useQuery({ queryKey: ['telescopes'], queryFn: listTelescopes });

  // Named custom-optics presets ("save this rig and reuse it later"),
  // localStorage-backed like the rest of FovSetup — see telescopeFov.ts.
  const [savedRigs, setSavedRigs] = useState<SavedCustomRig[]>(readSavedCustomRigs);
  const [namingRig, setNamingRig] = useState(false);
  const [rigNameDraft, setRigNameDraft] = useState('');
  const [rigFlash, setRigFlash] = useState<'saved' | 'updated' | null>(null);
  const rigFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (rigFlashTimer.current) clearTimeout(rigFlashTimer.current); }, []);

  const flashRig = (kind: 'saved' | 'updated') => {
    setRigFlash(kind);
    if (rigFlashTimer.current) clearTimeout(rigFlashTimer.current);
    rigFlashTimer.current = setTimeout(() => setRigFlash(null), 2000);
  };

  const setProfileId = (id: string) => {
    setSetup(prev => {
      // Picking a saved rig also loads its stored optics, so the custom
      // fields (and the FOV math, which always reads setup.custom for both
      // the ad-hoc Custom entry and any named preset) reflect it immediately.
      const rig = id.startsWith(CUSTOM_RIG_PREFIX) ? savedRigs.find(r => r.id === id.slice(CUSTOM_RIG_PREFIX.length)) : undefined;
      const next = { ...prev, profileId: id, custom: rig ? rig.optics : prev.custom };
      writeFovSetup(next);
      return next;
    });
  };
  const updateCustom = (patch: Partial<CustomOptics>) => {
    setSetup(prev => {
      const next = { ...prev, custom: { ...prev.custom, ...patch } };
      writeFovSetup(next);
      return next;
    });
  };

  const currentRigId = setup.profileId?.startsWith(CUSTOM_RIG_PREFIX) ? setup.profileId.slice(CUSTOM_RIG_PREFIX.length) : null;
  const currentRig = currentRigId ? savedRigs.find(r => r.id === currentRigId) ?? null : null;

  const startNamingRig = () => {
    setRigNameDraft('');
    setNamingRig(true);
  };
  const cancelNamingRig = () => {
    setNamingRig(false);
    setRigNameDraft('');
  };
  const confirmSaveRigAs = () => {
    const name = rigNameDraft.trim();
    if (!name) return;
    const rig = saveCustomRig(name, setup.custom);
    setSavedRigs(prev => [...prev, rig]);
    setProfileId(customRigOptionId(rig.id));
    setNamingRig(false);
    setRigNameDraft('');
    flashRig('saved');
  };
  const handleUpdateCurrentRig = () => {
    if (!currentRig) return;
    updateCustomRig(currentRig.id, setup.custom);
    setSavedRigs(prev => prev.map(r => (r.id === currentRig.id ? { ...r, optics: setup.custom } : r)));
    flashRig('updated');
  };
  const handleDeleteCurrentRig = () => {
    if (!currentRig) return;
    if (!window.confirm(t('framingModal.deleteRigConfirm', { name: currentRig.name }))) return;
    deleteCustomRig(currentRig.id);
    setSavedRigs(prev => prev.filter(r => r.id !== currentRig.id));
    setProfileId(CUSTOM_FOV_PROFILE_ID);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fov = useMemo(() => resolveFov(setup, telescopes), [setup, telescopes]);
  const profileId = fov.profileId;
  const activeTelescopes = useMemo(() => (telescopes ?? []).filter(tel => !tel.archivedAt), [telescopes]);

  // When the current pick is a registered telescope with no known FOV and no
  // optical configuration saved for it, the frame shown is a generic
  // stand-in, not this rig's actual field — flag that so the user knows to
  // go fill it in rather than assuming the rectangle on screen is accurate.
  const selectedTelescope = useMemo(() => {
    if (!profileId.startsWith(TELESCOPE_PROFILE_PREFIX)) return null;
    const rest = profileId.slice(TELESCOPE_PROFILE_PREFIX.length);
    const telescopeId = rest.includes(':') ? rest.slice(0, rest.indexOf(':')) : rest;
    return activeTelescopes.find(tel => tel.id === telescopeId) ?? null;
  }, [profileId, activeTelescopes]);
  const selectedTelescopeNeedsOptics = !!selectedTelescope
    && (selectedTelescope.kind === 'other' || selectedTelescope.kind === 'asiair')
    && selectedTelescope.opticalConfigs.length === 0;

  const object = useMemo(() => objectExtentArcmin(sizeStr, majorAxisArcmin), [sizeStr, majorAxisArcmin]);
  const coverage = useMemo(() => mosaicCoverageDeg(fov, cols, rows, overlap), [fov, cols, rows, overlap]);
  const fit = useMemo(() => classifyFit(fov, object), [fov, object]);
  const fitStrings = useMemo(() => (fit ? fitDisplayStrings(fit, t) : null), [fit, t]);

  // Atlas view: fetch a SQUARE DSS cutout spanning exactly viewDeg° centered on
  // the object (the /sky endpoint), so the sky fills the background. The view is
  // AUTO-FRAMED to the footprint (mosaic coverage or object, whichever is
  // larger) plus a fixed margin — no free zoom. A telescope FOV is a fixed
  // angular size, so zooming would only resize the box against the sky, which
  // reads as wrong. The box now changes size only when the scope or mosaic does.
  const viewDeg = useMemo(() => {
    const objMaxDeg = object ? Math.max(object.widthArcmin, object.heightArcmin) / 60 : 0;
    const footprint = Math.max(coverage.coverageWidthDeg, coverage.coverageHeightDeg, objMaxDeg, 0.2);
    return bucketFov(footprint * 1.3);
  }, [coverage, object]);

  const imgSrc = `/api/catalog/${encodeURIComponent(catalogId)}/sky?fov=${viewDeg}&size=800`;
  const imgError = erroredSrc === imgSrc;

  // Tile centers in degrees, relative to the object at frame center.
  const tiles = useMemo(() => {
    const stepXDeg = fov.widthDeg * (1 - overlap);
    const stepYDeg = fov.heightDeg * (1 - overlap);
    const out: { cxDeg: number; cyDeg: number }[] = [];
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        out.push({
          cxDeg: (i - (cols - 1) / 2) * stepXDeg,
          cyDeg: (j - (rows - 1) / 2) * stepYDeg,
        });
      }
    }
    return out;
  }, [fov, cols, rows, overlap]);

  // Convert degrees → SVG view units (viewBox is 0..100, spanning viewDeg°).
  const toU = (deg: number) => (deg / viewDeg) * 100;
  const tileWU = toU(fov.widthDeg);
  const tileHU = toU(fov.heightDeg);
  const objWU = object ? toU(object.widthArcmin / 60) : 0;
  const objHU = object ? toU(object.heightArcmin / 60) : 0;

  const accent = '#f59e0b';
  const tileCount = cols * rows;

  const autoFit = () => {
    if (!object) return;
    const { cols: c, rows: r } = autoMosaicForObject(fov, object, overlap);
    setCols(c); setRows(r);
  };

  const stepper = (value: number, set: (n: number) => void, min: number, max: number, label: string) => (
    <div className="flex items-center justify-between gap-2">
      <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</span>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => set(clamp(value - 1, min, max))}
          disabled={value <= min}
          className={`p-1 rounded-md border transition disabled:opacity-40 ${isDark ? 'border-slate-700 hover:bg-slate-800 text-slate-300' : 'border-slate-200 hover:bg-slate-100 text-slate-600'}`}
          aria-label={t('framingModal.decreaseLabel', { label })}
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <span className={`w-6 text-center text-sm font-medium tabular-nums ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{value}</span>
        <button
          onClick={() => set(clamp(value + 1, min, max))}
          disabled={value >= max}
          className={`p-1 rounded-md border transition disabled:opacity-40 ${isDark ? 'border-slate-700 hover:bg-slate-800 text-slate-300' : 'border-slate-200 hover:bg-slate-100 text-slate-600'}`}
          aria-label={t('framingModal.increaseLabel', { label })}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );

  const panelText = isDark ? 'text-slate-300' : 'text-slate-600';
  const inputCls = `w-full text-sm px-2 py-1.5 rounded-lg border ${isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-700'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className={`relative rounded-2xl shadow-2xl max-w-4xl w-full max-h-[92vh] overflow-hidden flex flex-col ${isDark ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900'}`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`flex items-center justify-between p-5 border-b ${isDark ? 'border-slate-700/40' : 'border-slate-200'}`}>
          <div>
            <h2 className="text-lg font-semibold">{t('framingModal.title')}</h2>
            <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{objectName}</p>
          </div>
          <button onClick={onClose} className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-white/10' : 'hover:bg-slate-100'}`} aria-label={t('framingModal.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-auto p-5 grid grid-cols-1 md:grid-cols-[1fr_260px] gap-5">
          {/* Preview */}
          <div>
            <div className={`relative aspect-square w-full rounded-xl overflow-hidden ${isDark ? 'bg-slate-950' : 'bg-slate-100'}`}>
              {/* DSS sky cutout spanning viewDeg°, centered on the object, so
                  the sky fills the whole preview like an atlas. */}
              {!imgError ? (
                <img
                  src={imgSrc}
                  alt={t('framingModal.skyFieldAlt', { objectName })}
                  className="absolute inset-0 w-full h-full object-cover"
                  onError={() => setErroredSrc(imgSrc)}
                />
              ) : (
                <div className={`absolute inset-0 flex items-center justify-center text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  {t('framingModal.skyImageUnavailable')}
                </div>
              )}

              <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
                {/* Object footprint */}
                {object && (
                  <ellipse
                    cx={50}
                    cy={50}
                    rx={Math.max(0.5, objWU / 2)}
                    ry={Math.max(0.5, objHU / 2)}
                    fill="none"
                    stroke="#38bdf8"
                    strokeOpacity={0.9}
                    strokeWidth={0.4}
                    strokeDasharray="1.5 1.2"
                  />
                )}
                {/* Sensor rectangle(s), rotated as a group about the center */}
                <g transform={`rotate(${rotationDeg} 50 50)`}>
                  {tiles.map((tile, idx) => {
                    const cx = 50 + toU(tile.cxDeg);
                    const cy = 50 - toU(tile.cyDeg);
                    return (
                      <rect
                        key={idx}
                        x={cx - tileWU / 2}
                        y={cy - tileHU / 2}
                        width={tileWU}
                        height={tileHU}
                        fill="none"
                        stroke={accent}
                        strokeOpacity={0.9}
                        strokeWidth={0.5}
                        rx={0.6}
                      />
                    );
                  })}
                </g>
              </svg>
            </div>

            {/* Rotation under the image */}
            <div className="mt-3 flex items-center gap-3">
              <div className="flex items-center gap-2 flex-1">
                <RotateCw className={`w-4 h-4 shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                <input
                  type="range"
                  min={0}
                  max={180}
                  value={rotationDeg}
                  onChange={e => setRotationDeg(Number(e.target.value))}
                  className="flex-1 accent-accent-500"
                  aria-label={t('framingModal.frameRotation')}
                />
                <span className={`w-10 text-right text-xs tabular-nums ${panelText}`}>{rotationDeg}°</span>
                {rotationDeg !== 0 && (
                  <button onClick={() => setRotationDeg(0)} className={`text-xs px-1.5 py-0.5 rounded ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}>{t('framingModal.reset')}</button>
                )}
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="space-y-4">
            <div>
              <label className={`text-xs font-medium block mb-1.5 ${panelText}`}>{t('framingModal.telescope')}</label>
              <select value={profileId} onChange={e => setProfileId(e.target.value)} className={inputCls}>
                {activeTelescopes.length > 0 && (
                  <optgroup label={t('framingModal.yourTelescopes')}>
                    {activeTelescopes.flatMap(tel => {
                      // A telescope with saved optical configs ("Native",
                      // "0.8x Reducer", ...) gets one option per config, so
                      // switching optical trains is a plain dropdown pick —
                      // a telescope with no configs at all just gets one
                      // option (falls back to a generic frame).
                      if ((tel.kind === 'other' || tel.kind === 'asiair') && tel.opticalConfigs.length > 0) {
                        return tel.opticalConfigs.map(cfg => (
                          <option key={cfg.id} value={telescopeProfileOptionId(tel.id, cfg.id)}>
                            {tel.name} — {cfg.name}
                          </option>
                        ));
                      }
                      return [
                        <option key={tel.id} value={telescopeProfileOptionId(tel.id)}>{tel.name}</option>,
                      ];
                    })}
                  </optgroup>
                )}
                <optgroup label={t('framingModal.builtInModels')}>
                  {FOV_PROFILES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </optgroup>
                {savedRigs.length > 0 && (
                  <optgroup label={t('framingModal.savedRigs')}>
                    {savedRigs.map(rig => (
                      <option key={rig.id} value={customRigOptionId(rig.id)}>{rig.name}</option>
                    ))}
                  </optgroup>
                )}
                <option value={CUSTOM_ID}>{t('framingModal.customOption')}</option>
              </select>
              {selectedTelescopeNeedsOptics && (
                <p className={`mt-1.5 text-[0.6875rem] ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                  {t('framingModal.noOpticsWarning', { name: selectedTelescope.name })}
                </p>
              )}
            </div>

            {(profileId === CUSTOM_ID || profileId.startsWith(CUSTOM_RIG_PREFIX)) && (
              <div className="grid grid-cols-2 gap-2">
                <label className="col-span-2 text-[0.6875rem] uppercase tracking-wide font-semibold text-slate-500">{t('framingModal.opticsMm')}</label>
                <div>
                  <span className={`text-[0.6875rem] ${panelText}`}>{t('framingModal.focal')}</span>
                  <input type="number" min={1} value={setup.custom.focalMm} onChange={e => updateCustom({ focalMm: Number(e.target.value) })} className={inputCls} />
                </div>
                <div>
                  <span className={`text-[0.6875rem] ${panelText}`}>{t('framingModal.pixelSize')}</span>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    placeholder={t('framingModal.optionalPlaceholder')}
                    value={setup.custom.pixelSizeUm ?? ''}
                    onChange={e => updateCustom({ pixelSizeUm: e.target.value === '' ? null : Number(e.target.value) })}
                    className={inputCls}
                  />
                </div>
                <div>
                  <span className={`text-[0.6875rem] ${panelText}`}>{t('framingModal.sensorW')}</span>
                  <input type="number" min={0.1} step={0.1} value={setup.custom.sensorWMm} onChange={e => updateCustom({ sensorWMm: Number(e.target.value) })} className={inputCls} />
                </div>
                <div>
                  <span className={`text-[0.6875rem] ${panelText}`}>{t('framingModal.sensorH')}</span>
                  <input type="number" min={0.1} step={0.1} value={setup.custom.sensorHMm} onChange={e => updateCustom({ sensorHMm: Number(e.target.value) })} className={inputCls} />
                </div>

                {/* Named-preset actions: save the current fields under a name
                    for reuse later, or manage the preset currently loaded. */}
                <div className="col-span-2">
                  {namingRig ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        autoFocus
                        type="text"
                        value={rigNameDraft}
                        onChange={e => setRigNameDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') confirmSaveRigAs();
                          // Stop this from also reaching the modal's own
                          // window-level Escape handler below, which would
                          // otherwise close the whole Framing modal in
                          // addition to just cancelling the rename.
                          if (e.key === 'Escape') { e.stopPropagation(); cancelNamingRig(); }
                        }}
                        placeholder={t('framingModal.rigNamePlaceholder')}
                        className={inputCls}
                      />
                      <button
                        onClick={confirmSaveRigAs}
                        disabled={!rigNameDraft.trim()}
                        className={`shrink-0 p-1.5 rounded-lg border transition disabled:opacity-40 ${isDark ? 'border-slate-700 hover:bg-slate-800 text-emerald-400' : 'border-slate-200 hover:bg-slate-100 text-emerald-600'}`}
                        aria-label={t('framingModal.confirmSaveRig')}
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={cancelNamingRig}
                        className={`shrink-0 p-1.5 rounded-lg border transition ${isDark ? 'border-slate-700 hover:bg-slate-800 text-slate-400' : 'border-slate-200 hover:bg-slate-100 text-slate-500'}`}
                        aria-label={t('framingModal.cancel')}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      {currentRig && (
                        <button
                          onClick={handleUpdateCurrentRig}
                          className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg border transition ${isDark ? 'border-slate-700 hover:bg-slate-800 text-accent-400' : 'border-slate-200 hover:bg-slate-100 text-accent-600'}`}
                        >
                          <Bookmark className="w-3.5 h-3.5" />
                          {t('framingModal.updateRig', { name: currentRig.name })}
                        </button>
                      )}
                      <button
                        onClick={startNamingRig}
                        className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg border transition ${isDark ? 'border-slate-700 hover:bg-slate-800 text-slate-300' : 'border-slate-200 hover:bg-slate-100 text-slate-600'}`}
                      >
                        <BookmarkPlus className="w-3.5 h-3.5" />
                        {currentRig ? t('framingModal.saveRigAsNew') : t('framingModal.saveRigAs')}
                      </button>
                      {currentRig && (
                        <button
                          onClick={handleDeleteCurrentRig}
                          className={`shrink-0 p-1.5 rounded-lg border transition ${isDark ? 'border-slate-700 hover:bg-slate-800 text-red-400' : 'border-slate-200 hover:bg-slate-100 text-red-500'}`}
                          aria-label={t('framingModal.deleteRig')}
                          title={t('framingModal.deleteRig')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {rigFlash && (
                        <span className={`inline-flex items-center gap-1 text-xs ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                          <Check className="w-3.5 h-3.5" />
                          {rigFlash === 'saved' ? t('framingModal.rigSaved') : t('framingModal.rigUpdated')}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <p className={`col-span-2 text-[0.625rem] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {t('framingModal.customOpticsHint')}
                </p>
              </div>
            )}

            <div className={`rounded-xl border p-3 space-y-2.5 ${isDark ? 'border-slate-800 bg-slate-800/30' : 'border-slate-200 bg-slate-50'}`}>
              <div className="flex items-center justify-between">
                <span className={`text-xs font-medium ${panelText}`}>{t('framingModal.mosaic')}</span>
                <button
                  onClick={autoFit}
                  disabled={!object}
                  className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md border transition disabled:opacity-40 ${isDark ? 'border-slate-700 hover:bg-slate-800 text-accent-400' : 'border-slate-200 hover:bg-slate-100 text-accent-600'}`}
                  title={object ? t('framingModal.autoFitTitle') : t('framingModal.angularSizeUnknown')}
                >
                  <Crosshair className="w-3 h-3" /> {t('framingModal.autoFit')}
                </button>
              </div>
              {stepper(cols, setCols, 1, 8, t('framingModal.columns'))}
              {stepper(rows, setRows, 1, 8, t('framingModal.rows'))}
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{t('framingModal.overlap')}</span>
                <select value={overlap} onChange={e => setOverlap(Number(e.target.value))} className={`text-sm px-2 py-1 rounded-lg border ${isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-700'}`}>
                  {OVERLAP_OPTIONS.map(o => <option key={o} value={o}>{Math.round(o * 100)}%</option>)}
                </select>
              </div>
            </div>

            {/* Readout */}
            <div className={`space-y-1.5 text-xs ${panelText}`}>
              <Row label={t('framingModal.frameFov')} value={`${formatFovDeg(fov.widthDeg)} × ${formatFovDeg(fov.heightDeg)}`} isDark={isDark} />
              {fov.arcsecPerPixel != null && (
                <Row label={t('framingModal.plateScale')} value={t('framingModal.plateScaleValue', { value: fov.arcsecPerPixel.toFixed(2) })} isDark={isDark} />
              )}
              {tileCount > 1 && (
                <Row label={t('framingModal.coverage')} value={`${formatFovDeg(coverage.coverageWidthDeg)} × ${formatFovDeg(coverage.coverageHeightDeg)}`} isDark={isDark} />
              )}
              <Row label={t('framingModal.tiles')} value={String(tileCount)} isDark={isDark} />
              {object && <Row label={t('framingModal.objectSize')} value={`${object.widthArcmin.toFixed(1)}′ × ${object.heightArcmin.toFixed(1)}′`} isDark={isDark} />}
              <div className="flex items-center justify-between pt-1.5">
                <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>{t('framingModal.verdict')}</span>
                {fit && fitStrings ? (
                  <FitBadge tag={fit.tag} label={fitStrings.short} title={fitStrings.label} isDark={isDark} />
                ) : (
                  <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>{t('framingModal.angularSizeUnknown')}</span>
                )}
              </div>
              {fit && fitStrings && (
                <p className={isDark ? 'text-slate-500' : 'text-slate-400'}>{fitStrings.label}</p>
              )}
            </div>

            {onSaveFraming && (
              <button
                onClick={handleSaveFraming}
                className={`w-full inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  justSaved
                    ? isDark ? 'border-emerald-800 bg-emerald-900/30 text-emerald-400' : 'border-emerald-200 bg-emerald-50 text-emerald-600'
                    : isDark ? 'border-slate-700 hover:bg-slate-800 text-accent-400' : 'border-slate-200 hover:bg-slate-100 text-accent-600'
                }`}
              >
                {justSaved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                {justSaved ? t('framingModal.framingSaved') : t('framingModal.saveFraming')}
              </button>
            )}
          </div>
        </div>

        <div className={`px-5 py-3 border-t text-[0.6875rem] ${isDark ? 'border-slate-700/40 text-slate-500' : 'border-slate-200 text-slate-400'}`}>
          {t('framingModal.fovDisclaimer')}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, isDark }: { label: string; value: string; isDark: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>{label}</span>
      <span className={`font-medium tabular-nums ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{value}</span>
    </div>
  );
}
