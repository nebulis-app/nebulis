/**
 * Calibration Library — browses every bias/dark/flat/flat-dark frame Nebulis
 * has archived from a telescope or a folder-import run (see
 * server/lib/library/calibrationScan.ts). These frames are never library
 * objects (a dark frame is not an observation of anything in the sky — see
 * archiveFolders.ts), so unlike every other nav section this one reads
 * straight off disk rather than the library database, and there is nothing
 * to import/edit here: it is a browser, not an editor.
 *
 * Frames are organized by capture settings (exposure, binning, gain, TEC/
 * sensor temperature) rather than by raw folder name — that is the grouping
 * that actually matters for matching calibration frames to lights in Siril/
 * PixInsight, and it works even when the source folder gives no hint at all
 * (a live ASIAIR sync's flat `Plan/Dark/` has no per-setting subfolders).
 * Each settings group downloads as one ZIP bundle, ready to hand to a
 * stacking app.
 *
 * Route: /calibrations
 */
import { Fragment, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, Aperture, Check, ChevronDown, ChevronRight, Download, File, Link2, Loader2, Telescope, Trash2, X } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import {
  getCalibrationLibrary,
  requestCalibrationBundleUrl,
  detachCalibrationBundle,
  deleteCalibrationBundle,
  type CalibrationFrameInfo,
  type CalibrationFrameType,
  type CalibrationGroup,
  type CalibrationSettingsGroup,
} from '../lib/api/library';
import { listTelescopes } from '../lib/api/telescopes';
import {
  ALL_SCOPES,
  buildScopeOptions,
  filterByScope,
  resolveScope,
  scopeValueOf,
} from '../lib/calibrationScope';
import { formatBytes } from '../lib/utils';
import { formatDate } from '../lib/formatLocale';
import { Sec } from '../components/settings/SettingsUI';
import { CalibrationHero } from '../components/library/CalibrationHero';
import { AttachCalibrationModal } from '../components/AttachCalibrationModal';
import { ConfirmModal } from '../components/ConfirmModal';

/** Only flats and their matching flat-darks are session-specific enough to
 *  need attaching to an object at all — bias/darks stay valid across
 *  sessions on a cooled camera and stay in the shared calibration pool. See
 *  server/lib/library/calibrationAttachments.ts. */
function isAttachableType(type: CalibrationFrameType): boolean {
  return type === 'flat' || type === 'flatDark';
}

/** Only bias/darks age out (Settings → Library → "Dark/bias validity") and
 *  can be permanently deleted from here — flats/flat-darks are managed by
 *  attaching them to an object instead. See calibrationScan.ts's
 *  isExpiredCalibration and deleteCalibrationBundle. */
function isDeletableType(type: CalibrationFrameType): boolean {
  return type === 'bias' || type === 'dark';
}

/** A bundle's real type for attach/delete purposes — its own resolved
 *  `frameType` (only ever set within a `mixed` CALI_FRAME group, one of its
 *  bias/dark/flat subfolders) falling back to the group's own type
 *  everywhere else. Mirrors server/lib/library/calibrationScan.ts's
 *  `resolveFrameType` exactly — a `mixed` group's own bundles can each be a
 *  different real type, so attach/delete eligibility (and the Status column)
 *  must be checked per row, not once for the whole group. */
function resolveRowType(group: CalibrationGroup, set: CalibrationSettingsGroup): CalibrationFrameType {
  return group.type === 'mixed' ? (set.frameType ?? 'mixed') : group.type;
}

/** Rendered top-to-bottom, mirroring a real calibration workflow: bias first
 *  (used to derive the others' noise floor), then darks, then flats and their
 *  matching flat-darks, with Dwarf's blended folder last since it isn't one
 *  type. */
const TYPE_ORDER: CalibrationFrameType[] = ['bias', 'dark', 'flat', 'flatDark', 'mixed'];

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return formatDate(new Date(iso), {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatExposure(v: number | null): string {
  if (v === null) return '—';
  return v < 1 ? `${Math.round(v * 1000)}ms` : `${v}s`;
}

function formatBinning(v: number | null): string {
  return v === null ? '—' : `${v}×${v}`;
}

function formatGain(v: number | null): string {
  return v === null ? '—' : String(v);
}

/** Rounded to the nearest whole degree for display: `set.sensorTempC` is a
 *  bundle's own mean (see calibrationScan.ts's TEC clustering), not
 *  necessarily any single frame's exact reading, so showing it to a decimal
 *  place reads as more precise than it is. A per-file reading in the
 *  expanded row below stays exact — see frameInfoSummary. */
function formatTemp(v: number | null): string {
  return v === null ? '—' : `${Math.round(v)}°C`;
}

/** `cam_0` -> `Cam 0` — Dwarf 3 only, see CalibrationSettingsGroup.camera. */
function formatCamera(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^cam_(\d+)$/i.exec(v);
  return m ? `Cam ${m[1]}` : v;
}

/** A short "5.0s · Bin1 · gain100 · -8.0°C" line from parsed filename
 *  metadata, omitting whichever fields weren't recognized rather than
 *  showing a placeholder for each. These are camera-setting tokens, not
 *  prose, so they are not run through t() — "Bin1"/"gain100" read the same
 *  in every language. */
function frameInfoSummary(info: CalibrationFrameInfo | null): string | null {
  if (!info) return null;
  const parts: string[] = [];
  const camera = formatCamera(info.camera);
  if (camera) parts.push(camera);
  if (info.exposureSec !== undefined) parts.push(formatExposure(info.exposureSec));
  if (info.binning !== undefined) parts.push(`Bin${info.binning}`);
  if (info.gain !== undefined) parts.push(`gain${info.gain}`);
  if (info.sensorTempC !== undefined) parts.push(`${info.sensorTempC}°C`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function rowKeyFor(group: CalibrationGroup, set: CalibrationSettingsGroup): string {
  return `${group.scope ?? 'unscoped'}:${group.folderName}:${set.key}`;
}

function SettingsGroupTable({
  group,
  isDark,
  expanded,
  onToggle,
  onDownload,
  downloadingKey,
  onAttach,
  onDetach,
  detachingId,
  onDeleteRequest,
  deletingKey,
}: {
  group: CalibrationGroup;
  isDark: boolean;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onDownload: (group: CalibrationGroup, set: CalibrationSettingsGroup) => void;
  downloadingKey: string | null;
  onAttach: (group: CalibrationGroup, set: CalibrationSettingsGroup) => void;
  onDetach: (attachmentId: string) => void;
  detachingId: string | null;
  onDeleteRequest: (group: CalibrationGroup, set: CalibrationSettingsGroup) => void;
  deletingKey: string | null;
}) {
  const { t } = useTranslation('library');
  const borderClass = isDark ? 'border-slate-800' : 'border-slate-100';
  const headClass = `text-left font-medium px-4 py-2.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`;
  // A non-mixed group is uniformly one type, so every row agrees — but a
  // Dwarf `mixed` (CALI_FRAME) group blends bias/dark/flat rows together, so
  // whether to show these columns AT ALL depends on whether ANY row in the
  // group qualifies; which row actually gets content in them is decided
  // per-row below via resolveRowType.
  const showAttachedToColumn = group.settingsGroups.some(set => isAttachableType(resolveRowType(group, set)));
  const showStatusColumn = group.settingsGroups.some(set => isDeletableType(resolveRowType(group, set)));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={isDark ? 'bg-slate-800/60' : 'bg-slate-50'}>
            <th className={headClass}>{t('calibrations.table.exposure')}</th>
            <th className={headClass}>{t('calibrations.table.bin')}</th>
            <th className={headClass}>{t('calibrations.table.gain')}</th>
            <th className={headClass}>{t('calibrations.table.tec')}</th>
            <th className={headClass}>{t('calibrations.table.frames')}</th>
            <th className={headClass}>{t('calibrations.table.size')}</th>
            <th className={headClass}>{t('calibrations.table.modified')}</th>
            {showAttachedToColumn && <th className={headClass}>{t('calibrations.table.attachedTo')}</th>}
            {showStatusColumn && <th className={headClass}>{t('calibrations.table.status')}</th>}
            <th className={headClass} aria-label={t('calibrations.table.actionsLabel')} />
          </tr>
        </thead>
        <tbody>
          {group.settingsGroups.map(set => {
            const key = rowKeyFor(group, set);
            const isOpen = expanded.has(key);
            const isDownloading = downloadingKey === key;
            const isDeleting = deletingKey === key;
            const rowType = resolveRowType(group, set);
            const rowAttachable = isAttachableType(rowType);
            const rowDeletable = isDeletableType(rowType);
            return (
              <Fragment key={key}>
                <tr
                  onClick={() => onToggle(key)}
                  className={`cursor-pointer transition-colors border-t ${borderClass} ${
                    isDark ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'
                  }`}
                >
                  <td className={`px-4 py-3 font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                    <div className="flex items-center gap-2">
                      <ChevronRight className={`w-3.5 h-3.5 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''} ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                      {formatExposure(set.exposureSec)}
                      {set.frameType !== null && (
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[0.625rem] font-semibold uppercase tracking-wide ${
                            isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {t(`calibrations.frameType.${set.frameType}`)}
                        </span>
                      )}
                      {set.camera !== null && (
                        <span
                          title={t('calibrations.table.cameraTitle')}
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] font-semibold uppercase tracking-wide ${
                            isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          <Aperture className="w-2.5 h-2.5" />
                          {formatCamera(set.camera)}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={`px-4 py-3 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatBinning(set.binning)}</td>
                  <td className={`px-4 py-3 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatGain(set.gain)}</td>
                  <td className={`px-4 py-3 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatTemp(set.sensorTempC)}</td>
                  <td className={`px-4 py-3 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{set.fileCount}</td>
                  <td className={`px-4 py-3 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatBytes(set.bytes)}</td>
                  <td className={`px-4 py-3 whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{formatDateTime(set.modifiedAt)}</td>
                  {showAttachedToColumn && (
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      {rowAttachable ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {(set.attachments ?? []).map(a => (
                            <span
                              key={a.id}
                              title={a.date ? t('calibrations.attachment.sessionTitle', { date: a.date }) : t('calibrations.attachment.everySessionTitle')}
                              className={`inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-full text-xs font-medium ${
                                isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
                              }`}
                            >
                              <span className="truncate max-w-[9rem]">{a.objectName}{a.date ? ` · ${a.date}` : ''}</span>
                              <button
                                type="button"
                                onClick={() => onDetach(a.id)}
                                disabled={detachingId === a.id}
                                title={t('calibrations.attachment.detach')}
                                className={`p-0.5 rounded-full transition disabled:opacity-40 ${isDark ? 'hover:bg-emerald-500/20' : 'hover:bg-emerald-100'}`}
                              >
                                {detachingId === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                              </button>
                            </span>
                          ))}
                          <button
                            type="button"
                            onClick={() => onAttach(group, set)}
                            title={t('calibrations.attachment.attachToObject')}
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium transition ${
                              isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
                            }`}
                          >
                            <Link2 className="w-3 h-3" />
                            {(set.attachments ?? []).length === 0 ? t('calibrations.attachment.attach') : ''}
                          </button>
                        </div>
                      ) : null}
                    </td>
                  )}
                  {showStatusColumn && (
                    <td className="px-4 py-3">
                      {!rowDeletable ? null : set.isExpired ? (
                        <span
                          title={t('calibrations.status.expiredTitle')}
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                            isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          <AlertTriangle className="w-3 h-3" />
                          {t('calibrations.status.expired')}
                        </span>
                      ) : set.capturedAt ? (
                        <span
                          title={t('calibrations.status.validTitle')}
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                            isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
                          }`}
                        >
                          <Check className="w-3 h-3" />
                          {t('calibrations.status.valid')}
                        </span>
                      ) : (
                        <span
                          title={t('calibrations.status.unknownTitle')}
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                            isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'
                          }`}
                        >
                          {t('calibrations.status.unknown')}
                        </span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); onDownload(group, set); }}
                        disabled={isDownloading}
                        title={t('calibrations.actions.downloadZip')}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition disabled:opacity-50 ${
                          isDark ? 'bg-accent-500/10 text-accent-400 hover:bg-accent-500/20' : 'bg-accent-50 text-accent-700 hover:bg-accent-100'
                        }`}
                      >
                        {isDownloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                        <span className="hidden sm:inline">{t('calibrations.actions.zip')}</span>
                      </button>
                      {rowDeletable && (
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); onDeleteRequest(group, set); }}
                          disabled={isDeleting}
                          title={t('calibrations.actions.delete')}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition disabled:opacity-50 ${
                            isDark ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'bg-red-50 text-red-700 hover:bg-red-100'
                          }`}
                        >
                          {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {isOpen && set.files.map(file => (
                  <tr key={`${key}/${file.name}`} className={`border-t ${borderClass} ${isDark ? 'bg-slate-900/40' : 'bg-slate-50/60'}`}>
                    <td colSpan={4} className={`px-4 py-2 pl-11 font-mono text-xs truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      <div className="flex items-center gap-2">
                        <File className="w-3.5 h-3.5 shrink-0 opacity-60" />
                        <span className="truncate" title={file.path}>{file.name}</span>
                      </div>
                    </td>
                    <td className={`px-4 py-2 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {frameInfoSummary(file.info) ?? '—'}
                    </td>
                    <td className={`px-4 py-2 text-xs tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{formatBytes(file.size)}</td>
                    <td className={`px-4 py-2 text-xs whitespace-nowrap ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{formatDateTime(file.modifiedAt)}</td>
                    {showAttachedToColumn && <td />}
                    {showStatusColumn && <td />}
                    <td />
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CalibrationLibrary() {
  const { t } = useTranslation('library');
  const { isDark, isNight, isSpace } = useTheme();
  // The hero sits on dark sky imagery in every theme, so it takes the bright
  // accent hex directly rather than the light-mode-darkened token, matching
  // the Library, Backup and Catalogs banners.
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['calibration-library'],
    queryFn: getCalibrationLibrary,
    staleTime: 60_000,
  });
  const groups = useMemo(() => data?.groups ?? [], [data]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [attachTarget, setAttachTarget] = useState<{ group: CalibrationGroup; set: CalibrationSettingsGroup } | null>(null);
  const [detachingId, setDetachingId] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ group: CalibrationGroup; set: CalibrationSettingsGroup } | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Frames are stored per telescope, so the page offers a scope filter once
  // there is more than one scope to choose from. The selection lives in
  // `?scope=` so Settings → Telescopes can link straight at one telescope's
  // frames, and an unknown id (deleted telescope, hand-edited URL) falls back to
  // every scope rather than an empty page. The profiles are fetched rather than
  // taken from the API's own `scopeLabel`, which is English-only.
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: telescopes = [] } = useQuery({
    queryKey: ['telescopes'],
    queryFn: listTelescopes,
    staleTime: 60_000,
  });
  const telescopeNames = useMemo(
    () => new Map(telescopes.map(profile => [profile.id, profile.name])),
    [telescopes],
  );
  const activeScope = resolveScope(searchParams.get('scope'), groups);

  function selectScope(value: string) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (value === ALL_SCOPES) next.delete('scope');
      else next.set('scope', value);
      return next;
    }, { replace: true });
  }

  function scopeName(scope: string | null): string {
    if (scope === null) return t('calibrations.scope.unassigned');
    return telescopeNames.get(scope) ?? t('calibrations.scope.deleted');
  }

  function toggle(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // The "Download" button can't be a plain <a href>: the ZIP route needs a
  // credential, and a browser download navigation can't send the auth
  // header. Mint a short-lived signed URL, then click a synthetic <a> at it
  // — same pattern ObjectDetail.tsx's "Download All" uses.
  async function handleDownload(group: CalibrationGroup, set: CalibrationSettingsGroup) {
    const key = rowKeyFor(group, set);
    setDownloadError(null);
    setDownloadingKey(key);
    try {
      const { url } = await requestCalibrationBundleUrl(group.scope, group.folderName, set.key);
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : t('calibrations.errors.download'));
    } finally {
      setDownloadingKey(null);
    }
  }

  function handleAttached() {
    queryClient.invalidateQueries({ queryKey: ['calibration-library'] });
  }

  async function handleDetach(attachmentId: string) {
    setAttachError(null);
    setDetachingId(attachmentId);
    try {
      await detachCalibrationBundle(attachmentId);
      queryClient.invalidateQueries({ queryKey: ['calibration-library'] });
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : t('calibrations.errors.detach'));
    } finally {
      setDetachingId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const { group, set } = deleteTarget;
    const key = rowKeyFor(group, set);
    setDeleteError(null);
    setDeletingKey(key);
    try {
      await deleteCalibrationBundle(group.scope, group.folderName, set.key);
      queryClient.invalidateQueries({ queryKey: ['calibration-library'] });
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('calibrations.errors.delete'));
    } finally {
      setDeletingKey(null);
    }
  }

  const visibleGroups = useMemo(() => filterByScope(groups, activeScope), [groups, activeScope]);

  const groupsByType = useMemo(() => {
    const map = new Map<CalibrationFrameType, CalibrationGroup[]>();
    for (const g of visibleGroups) {
      const list = map.get(g.type) ?? [];
      list.push(g);
      map.set(g.type, list);
    }
    return map;
  }, [visibleGroups]);

  // Folder-per-scope badges and the filter row are only useful once more than
  // one scope is actually present — a single-telescope household (the common
  // case) would otherwise see a redundant "Unassigned"/telescope-name tag on
  // every row. Built from every group, not the filtered set, so the filter row
  // does not disappear once a scope is selected.
  const multiScope = useMemo(
    () => new Set(groups.map(g => scopeValueOf(g.scope))).size > 1,
    [groups],
  );
  const scopeOptions = useMemo(
    () => buildScopeOptions(groups, telescopeNames, t),
    [groups, telescopeNames, t],
  );

  const totalFiles = visibleGroups.reduce((sum, g) => sum + g.fileCount, 0);
  const totalBytes = visibleGroups.reduce((sum, g) => sum + g.bytes, 0);

  // The scope picker rides in the hero banner. A native select rather than a row
  // of pills, so a household with several telescopes stays one control wide; the
  // markup mirrors the Observations toolbar's telescope filter. Hidden entirely
  // when there is only one scope, where it could not change anything.
  const scopeFilter = multiScope ? (
    <div className="relative inline-flex items-center">
      <Telescope className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-white/50" />
      <select
        value={activeScope}
        onChange={e => selectScope(e.target.value)}
        aria-label={t('calibrations.scope.filterLabel')}
        className="cursor-pointer appearance-none rounded-full bg-white/10 py-2 pl-9 pr-8 text-xs text-white ring-1 ring-inset ring-white/15 transition hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-white/40 [&>option]:bg-slate-900 [&>option]:text-white"
      >
        {scopeOptions.map(option => (
          <option key={option.value} value={option.value}>
            {option.label} ({option.fileCount})
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 h-3.5 w-3.5 text-white/50" />
    </div>
  ) : undefined;

  return (
    <div className="space-y-8">
      <CalibrationHero
        accent={accent}
        empty={!isLoading && !error && groups.length === 0}
        totalFiles={totalFiles}
        totalBytes={totalBytes}
        frameTypeCount={groupsByType.size}
        filter={scopeFilter}
      />

      {(downloadError || attachError || deleteError) && (
        <div className={`max-w-2xl mx-auto flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm ${
          isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-700'
        }`}>
          <AlertCircle className="w-4 h-4 shrink-0" />
          {downloadError ?? attachError ?? deleteError}
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 py-16 justify-center">
          <Loader2 className={`w-5 h-5 animate-spin ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
          <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>{t('calibrations.loading')}</span>
        </div>
      )}

      {!isLoading && error && (
        <div className={`flex flex-col items-center gap-2 py-16 text-center ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <AlertCircle className="w-6 h-6 text-red-500" />
          <p>{t('calibrations.loadError')}</p>
        </div>
      )}

      {!isLoading && !error && groups.length === 0 && (
        <div className={`flex flex-col items-center gap-3 py-16 text-center ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          <Aperture className="w-10 h-10 opacity-30" />
          <p className="max-w-sm">{t('calibrations.empty')}</p>
        </div>
      )}

      {!isLoading && !error && groups.length > 0 && (
        <>
          {TYPE_ORDER.map(type => {
            const typeGroups = groupsByType.get(type);
            if (!typeGroups) return null;
            return (
              <Sec key={type} title={typeGroups[0].typeLabel} description={t(`calibrations.typeDescription.${type}`)} isDark={isDark}>
                <div className="divide-y divide-slate-800/50">
                  {typeGroups.map(group => (
                    <div key={`${group.scope ?? 'unscoped'}:${group.folderName}`}>
                      {(typeGroups.length > 1 || multiScope) && (
                        <div className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider ${
                          isDark ? 'text-slate-500 bg-slate-800/30' : 'text-slate-400 bg-slate-50'
                        }`}>
                          {group.folderName}
                          {multiScope && (
                            <>
                              <span aria-hidden="true">{' · '}</span>
                              {/* The scope in the row header doubles as a
                                  shortcut to that telescope's frames. */}
                              <button
                                type="button"
                                onClick={() => selectScope(scopeValueOf(group.scope))}
                                title={t('calibrations.scope.filterBy', { name: scopeName(group.scope) })}
                                className="hover:underline focus-visible:underline"
                              >
                                {scopeName(group.scope)}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                      <SettingsGroupTable
                        group={group}
                        isDark={isDark}
                        expanded={expanded}
                        onToggle={toggle}
                        onDownload={handleDownload}
                        downloadingKey={downloadingKey}
                        onAttach={(g, s) => setAttachTarget({ group: g, set: s })}
                        onDetach={handleDetach}
                        detachingId={detachingId}
                        onDeleteRequest={(g, s) => setDeleteTarget({ group: g, set: s })}
                        deletingKey={deletingKey}
                      />
                    </div>
                  ))}
                </div>
              </Sec>
            );
          })}
        </>
      )}

      {attachTarget && (
        <AttachCalibrationModal
          isDark={isDark}
          scope={attachTarget.group.scope}
          folderName={attachTarget.group.folderName}
          settingsKey={attachTarget.set.key}
          bundleLabel={`${attachTarget.group.typeLabel} · ${formatExposure(attachTarget.set.exposureSec)} · ${formatBinning(attachTarget.set.binning)} · gain ${formatGain(attachTarget.set.gain)} · ${formatTemp(attachTarget.set.sensorTempC)}`}
          onClose={() => setAttachTarget(null)}
          onAttached={handleAttached}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title={t('calibrations.delete.confirmTitle')}
          message={t('calibrations.delete.confirmMessage', {
            count: deleteTarget.set.fileCount,
            size: formatBytes(deleteTarget.set.bytes),
            bundle: `${deleteTarget.group.typeLabel} · ${formatExposure(deleteTarget.set.exposureSec)} · ${formatBinning(deleteTarget.set.binning)} · gain ${formatGain(deleteTarget.set.gain)} · ${formatTemp(deleteTarget.set.sensorTempC)}`,
          })}
          confirmLabel={t('calibrations.delete.confirmButton')}
          pending={deletingKey === rowKeyFor(deleteTarget.group, deleteTarget.set)}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
