import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Download,
  RotateCw,
  CheckCircle2,
  XCircle,
  X,
  Trash2,
  Package,
  AlertCircle,
} from 'lucide-react';
import type { Settings as SettingsType } from '../../types';
import { Toggle, Sec } from './SettingsUI';
import {
  getCatalogPrefetchStatus,
  startCatalogPrefetch,
  cancelCatalogPrefetch,
  wipeCatalogCache,
  type PackStateRow,
} from '../../lib/api/catalog';
import { getSatelliteCatalogStatus, clearSatelliteCache, refreshSatelliteCatalog } from '../../lib/api/observations';
import { formatDate, formatRelativeDuration } from '../../lib/formatLocale';
import { ConfirmModal } from '../ConfirmModal';
import { Modal } from '../ui/Modal';

export function CatalogSection({
  isDark,
  form,
  setForm,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
}) {
  // Two unrelated caches (object imagery vs. satellite orbital elements) used to
  // share one header that only described the first, so the second rendered
  // under a title that had nothing to do with it. Each gets its own Sec now.
  return (
    <>
      <OfflineCatalogCard isDark={isDark} form={form} setForm={setForm} />
      <TleCatalogCard isDark={isDark} />
    </>
  );
}

function OfflineCatalogCard({
  isDark,
  form,
  setForm,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
}) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const enabled = form.prefetchCatalogAssets ?? false;

  const { data: status } = useQuery({
    queryKey: ['catalog-prefetch-status'],
    queryFn: getCatalogPrefetchStatus,
    refetchInterval: (query) => (query.state.data?.running ? 2000 : 30_000),
    staleTime: 0,
  });

  const startAllMutation = useMutation({
    mutationFn: ({ force, packsOnly, scope }: { force: boolean; packsOnly: boolean; scope?: 'curated' | 'full' }) =>
      startCatalogPrefetch(force, packsOnly, scope ?? 'curated'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['catalog-prefetch-status'] }),
  });
  const cancelMutation = useMutation({
    mutationFn: () => cancelCatalogPrefetch(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['catalog-prefetch-status'] }),
  });
  const wipeMutation = useMutation({
    mutationFn: () => wipeCatalogCache(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['catalog-prefetch-status'] }),
  });

  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const [showFullConfirm, setShowFullConfirm] = useState(false);
  const isBusy = status?.running ?? false;
  const isStarting = startAllMutation.isPending;

  return (
    <Sec
      title={t('offlineCatalog.title')}
      description={t('offlineCatalog.description')}
      isDark={isDark}
      actions={
        <Toggle
          checked={enabled}
          onChange={v => setForm(f => ({ ...f, prefetchCatalogAssets: v }))}
        />
      }
    >
      {!enabled || !status ? (
        <p className={`p-4 sm:p-5 text-xs leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {t('offlineCatalog.turnOnHint')}
        </p>
      ) : (
        <div className="p-4 sm:p-5 space-y-3">

          <PackStatesRow
            isDark={isDark}
            packStates={status.packStates ?? []}
            activePhase={status.running ? status.phase : null}
            processed={status.processed}
            total={status.total}
          />

          {/* ── Download / Cancel / Wipe ── */}
          <div className={`pt-3 border-t flex items-center gap-2 flex-wrap ${isDark ? 'border-slate-800/70' : 'border-slate-100'}`}>
            {isBusy ? (
              <button
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium border transition ${
                  isDark
                    ? 'border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    : 'border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700'
                }`}
              >
                <X className="w-3.5 h-3.5" />
                {t('offlineCatalog.cancelDownload')}
              </button>
            ) : (
              <>
                <button
                  onClick={() => startAllMutation.mutate({ force: false, packsOnly: true })}
                  disabled={isStarting}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition disabled:opacity-50 ${
                    isDark
                      ? 'bg-accent-500/10 text-accent-400 hover:bg-accent-500/20 border border-accent-500/30'
                      : 'bg-accent-300 text-accent-700 hover:bg-accent-400 border border-accent-400'
                  }`}
                >
                  {isStarting ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  {t('offlineCatalog.download')}
                </button>
                <button
                  onClick={() => setShowFullConfirm(true)}
                  disabled={isStarting}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium border transition disabled:opacity-50 ${
                    isDark
                      ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                  title={t('offlineCatalog.downloadEverythingTitle')}
                >
                  <Package className="w-3.5 h-3.5" />
                  {t('offlineCatalog.downloadEverything')}
                </button>
              </>
            )}
            <button
              onClick={() => setShowWipeConfirm(true)}
              disabled={isBusy || wipeMutation.isPending}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed ${
                isDark
                  ? 'border-red-500/30 text-red-400 hover:bg-red-500/10'
                  : 'border-red-200 text-red-600 hover:bg-red-50'
              }`}
            >
              {wipeMutation.isPending ? <RotateCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              {t('offlineCatalog.wipeAndReset')}
            </button>
            {status.errors > 0 && !isBusy && (
              <span className={`text-[0.6875rem] ml-auto ${isDark ? 'text-amber-500/70' : 'text-amber-600/70'}`}>
                {t('offlineCatalog.itemsFailed', { count: status.errors })}
              </span>
            )}
          </div>

          {/* ── Full download confirm dialog ── */}
          {showFullConfirm && (
            <Modal isOpen onClose={() => setShowFullConfirm(false)} title={t('offlineCatalog.downloadEverythingConfirmTitle')}>
              <div className={`relative w-full max-w-sm rounded-2xl shadow-2xl p-6 ${isDark ? 'bg-slate-900 border border-slate-700/60' : 'bg-white border border-slate-200'}`}>
                <h3 className={`text-base font-semibold mb-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  {t('offlineCatalog.downloadEverythingConfirmTitle')}
                </h3>
                <p className={`text-sm mb-5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {t('offlineCatalog.downloadEverythingConfirmBody')}
                </p>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setShowFullConfirm(false)}
                    className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                      isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {t('offlineCatalog.cancel')}
                  </button>
                  <button
                    onClick={() => {
                      startAllMutation.mutate({ force: false, packsOnly: false, scope: 'full' });
                      setShowFullConfirm(false);
                    }}
                    className="px-4 py-2 rounded-xl text-sm font-semibold bg-accent-500 text-white hover:bg-accent-600 transition"
                  >
                    {t('offlineCatalog.downloadEverything')}
                  </button>
                </div>
              </div>
            </Modal>
          )}

          {/* ── Wipe confirm dialog ── */}
          {showWipeConfirm && (
            <ConfirmModal
              title={t('offlineCatalog.wipeConfirmTitle')}
              message={t('offlineCatalog.wipeConfirmBody')}
              confirmLabel={t('offlineCatalog.wipeAndReset')}
              onConfirm={() => { wipeMutation.mutate(); setShowWipeConfirm(false); }}
              onCancel={() => setShowWipeConfirm(false)}
            />
          )}
        </div>
      )}
    </Sec>
  );
}

function PackStatesRow({ isDark, packStates, activePhase, processed, total }: {
  isDark: boolean;
  packStates: PackStateRow[];
  activePhase: string | null;
  processed: number;
  total: number;
}) {
  const { t } = useTranslation('settings');
  // Any active job phase shows the progress bar, not just pack installs —
  // the full download runs through images / wikipedia / caldwell phases after
  // the packs and would otherwise look stuck for its entire remaining runtime.
  const PHASE_LABELS: Record<string, { badge: string; unit: string }> = {
    pack: { badge: t('offlineCatalog.packStates.downloadingPacks'), unit: t('offlineCatalog.packStates.unitPacks') },
    images: { badge: t('offlineCatalog.packStates.downloadingImages'), unit: t('offlineCatalog.packStates.unitObjects') },
    wikipedia: { badge: t('offlineCatalog.packStates.downloadingDescriptions'), unit: t('offlineCatalog.packStates.unitObjects') },
    caldwell: { badge: t('offlineCatalog.packStates.downloadingCaldwell'), unit: t('offlineCatalog.packStates.unitObjects') },
  };
  const phaseInfo = activePhase ? PHASE_LABELS[activePhase] ?? null : null;
  const isInstalling = phaseInfo !== null;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  const TIER_LABELS: Record<string, string> = {
    messier: t('offlineCatalog.packStates.tiers.messier'),
    caldwell: t('offlineCatalog.packStates.tiers.caldwell'),
    popular: t('offlineCatalog.packStates.tiers.popular'),
    extended: t('offlineCatalog.packStates.tiers.extended'),
    sharpless: t('offlineCatalog.packStates.tiers.sharpless'),
  };

  return (
    <div className={`p-3 rounded-xl border transition-all ${
      isInstalling
        ? isDark ? 'border-accent-500/30 bg-accent-500/5' : 'border-accent-300 bg-accent-50/50'
        : isDark ? 'border-slate-800 bg-slate-800/30' : 'border-slate-100 bg-slate-50/50'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 shrink-0 ${
          isInstalling || packStates.length > 0
            ? isDark ? 'text-accent-400' : 'text-accent-500'
            : isDark ? 'text-slate-600' : 'text-slate-400'
        }`}>
          {isInstalling ? <RotateCw className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className={`text-xs font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              {t('offlineCatalog.packStates.assetPacks')}
            </p>
            {isInstalling ? (
              <span className={`inline-flex items-center gap-1 text-[0.625rem] font-medium px-1.5 py-0.5 rounded-full ${
                isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-100 text-accent-600'
              }`}>
                <RotateCw className="w-2.5 h-2.5 animate-spin" />
                {phaseInfo?.badge ?? t('offlineCatalog.packStates.downloading')}
              </span>
            ) : packStates.length > 0 ? (
              <span className={`text-[0.6875rem] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {t('offlineCatalog.packStates.autoUpdated')}
              </span>
            ) : (
              <span className={`inline-flex items-center gap-1 text-[0.625rem] font-medium px-1.5 py-0.5 rounded-full ${
                isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'
              }`}>
                <XCircle className="w-2.5 h-2.5" />
                {t('offlineCatalog.packStates.notInstalled')}
              </span>
            )}
          </div>

          {isInstalling && (
            <div className="mt-2 space-y-1">
              <div className={`h-1 rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                <div
                  className="h-full bg-accent-500 transition-all duration-500 ease-out"
                  style={{ width: total > 0 ? `${pct}%` : '5%' }}
                />
              </div>
              {total > 0 && (
                <span className={`text-[0.625rem] tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {t('offlineCatalog.packStates.progressOf', { processed, total, unit: phaseInfo?.unit ?? t('offlineCatalog.packStates.unitPacks') })}
                </span>
              )}
            </div>
          )}

          {!isInstalling && packStates.length === 0 && (
            <p className={`text-[0.6875rem] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t('offlineCatalog.packStates.prebuiltDescription')}
            </p>
          )}

          {packStates.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {packStates.map(ps => (
                <span
                  key={ps.tier}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[0.6875rem] font-medium ${
                    isDark ? 'bg-slate-700/60 text-slate-300' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  <CheckCircle2 className={`w-3 h-3 ${isDark ? 'text-accent-400' : 'text-accent-500'}`} />
                  {TIER_LABELS[ps.tier] ?? ps.tier} v{ps.version}
                  <span className={`${isDark ? 'text-slate-500' : 'text-slate-400'}`}>· {ps.objectCount}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatShortDate(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return formatRelativeDuration(Math.floor(diff / 60_000), 'minute', 'narrow');
  if (diff < 86_400_000) return formatRelativeDuration(Math.floor(diff / 3_600_000), 'hour', 'narrow');
  if (diff < 7 * 86_400_000) return formatRelativeDuration(Math.floor(diff / 86_400_000), 'day', 'narrow');
  return formatDate(new Date(ms), { month: 'short', day: 'numeric', year: '2-digit' });
}

function formatTleDate(iso: string): string {
  return formatShortDate(Date.parse(iso));
}

function formatArchiveDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  return formatDate(d, { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' });
}

function TleCatalogCard({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ['satellite-catalog-status'],
    queryFn: getSatelliteCatalogStatus,
    staleTime: 60_000,
  });
  const [clearingCache, setClearingCache] = useState(false);
  const [clearResult, setClearResult] = useState<'cleared' | 'error' | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<'refreshed' | 'error' | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  }, []);

  async function handleClearCache() {
    setClearingCache(true);
    setClearResult(null);
    try {
      await clearSatelliteCache();
      setClearResult('cleared');
    } catch {
      setClearResult('error');
    } finally {
      setClearingCache(false);
      clearTimerRef.current = setTimeout(() => setClearResult(null), 4000);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshResult(null);
    try {
      await refreshSatelliteCatalog();
      setRefreshResult('refreshed');
      // Refetch status so the count and "Last download" line reflect the fetch.
      await queryClient.invalidateQueries({ queryKey: ['satellite-catalog-status'] });
    } catch {
      setRefreshResult('error');
      // The status card's error callout (status.lastError) shows the reason
      // once this refetch lands.
      await queryClient.invalidateQueries({ queryKey: ['satellite-catalog-status'] });
    } finally {
      setRefreshing(false);
      refreshTimerRef.current = setTimeout(() => setRefreshResult(null), 4000);
    }
  }

  const statusBadge = status && (
    status.isStale ? (
      <span className={`inline-flex items-center gap-1 text-[0.625rem] font-medium px-1.5 py-0.5 rounded-full ${isDark ? 'bg-amber-500/15 text-amber-400' : 'bg-amber-50 text-amber-600'}`}>
        <AlertCircle className="w-2.5 h-2.5" />
        {t('tleCatalog.stale')}
      </span>
    ) : status.count > 0 ? (
      <span className={`inline-flex items-center gap-1 text-[0.625rem] font-medium px-1.5 py-0.5 rounded-full ${isDark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-50 text-emerald-600'}`}>
        <CheckCircle2 className="w-2.5 h-2.5" />
        {t('tleCatalog.current')}
      </span>
    ) : (
      <span className={`inline-flex items-center gap-1 text-[0.625rem] font-medium px-1.5 py-0.5 rounded-full ${isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
        <XCircle className="w-2.5 h-2.5" />
        {t('tleCatalog.notLoaded')}
      </span>
    )
  );

  return (
    <Sec
      title={t('tleCatalog.title')}
      description={t('tleCatalog.description')}
      isDark={isDark}
      actions={statusBadge}
    >
      <div className="p-4 sm:p-5">
        {status && (
          <div className={`flex flex-col gap-1 text-[0.6875rem] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {status.count > 0 && (
              <span>{t('tleCatalog.satelliteCount', { count: status.count })}</span>
            )}
            {status.lastFetch && (
              <span>{t('tleCatalog.lastDownload', { date: formatTleDate(status.lastFetch) })}</span>
            )}
            {status.archiveRange.count > 0 && (
              <span>
                {t('tleCatalog.archiveRange', {
                  count: status.archiveRange.count,
                  oldest: formatArchiveDate(status.archiveRange.oldest),
                  newest: formatArchiveDate(status.archiveRange.newest),
                })}
              </span>
            )}
            {status.archiveRange.count === 0 && (
              <span>{t('tleCatalog.noArchiveYet')}</span>
            )}
            {status.usingSeed && (
              <span className={isDark ? 'text-amber-400' : 'text-amber-600'}>
                {t('tleCatalog.usingSeed', { date: formatArchiveDate(status.seedEpoch) })}
              </span>
            )}
          </div>
        )}
        {status?.lastError && (
          <div className={`mt-3 flex items-start gap-2 rounded-lg p-2.5 text-[0.6875rem] ${
            isDark ? 'bg-red-500/10 text-red-300' : 'bg-red-50 text-red-700'
          }`}>
            <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />
            <div className="flex flex-col gap-1">
              <span>{t('tleCatalog.downloadFailed', { error: status.lastError })}</span>
              {status.retryInMinutes > 0 && (
                <span className={isDark ? 'text-red-400/80' : 'text-red-600/80'}>
                  {t('tleCatalog.retryInMinutes', {
                    time: status.retryInMinutes < 60
                      ? t('tleCatalog.retryMinutesUnit', { count: status.retryInMinutes })
                      : t('tleCatalog.retryHoursUnit', { count: Math.round(status.retryInMinutes / 60) }),
                  })}
                </span>
              )}
              {status.lastError.includes('HTTP 403') && (
                <span className={isDark ? 'text-red-400/80' : 'text-red-600/80'}>
                  {t('tleCatalog.rateLimitHint')}
                </span>
              )}
            </div>
          </div>
        )}
        <div className={`flex items-center gap-3 flex-wrap ${status ? 'mt-3' : ''}`}>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
              isDark
                ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25'
                : 'bg-accent-50 text-accent-700 hover:bg-accent-100'
            }`}
            title={t('tleCatalog.refreshNowTitle')}
          >
            <RotateCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? t('tleCatalog.refreshing') : t('tleCatalog.refreshNow')}
          </button>
          <button
            onClick={handleClearCache}
            disabled={clearingCache}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              isDark
                ? 'bg-slate-800/60 text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 disabled:opacity-50'
                : 'bg-slate-100 text-slate-500 hover:text-slate-700 hover:bg-slate-200 disabled:opacity-50'
            }`}
          >
            <Trash2 className="w-3 h-3" />
            {clearingCache ? t('tleCatalog.clearing') : t('tleCatalog.clearDetectionCache')}
          </button>
          {refreshResult === 'refreshed' && (
            <span className={`text-xs ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>{t('tleCatalog.catalogRefreshed')}</span>
          )}
          {refreshResult === 'error' && (
            <span className={`text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>{t('tleCatalog.refreshFailed')}</span>
          )}
          {clearResult === 'cleared' && (
            <span className={`text-xs ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>{t('tleCatalog.cacheCleared')}</span>
          )}
          {clearResult === 'error' && (
            <span className={`text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>{t('tleCatalog.clearFailed')}</span>
          )}
        </div>
      </div>
    </Sec>
  );
}
