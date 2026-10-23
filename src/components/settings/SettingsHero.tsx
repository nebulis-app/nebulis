/**
 * Banner for Settings. Same dark shell as Library/Gallery/Backup — rounded
 * card, two radial accent washes, inset ring, white `font-display` title —
 * plus a `HeroBackdrop` photo layer like every other page banner. It used to
 * skip the photo (Settings has no natural artwork of its own, and each page
 * was meant to have its own picture), so it borrows Westerlund 2: freed up
 * once Observations moved to carina-landscape, see heroImagery.ts.
 *
 * Stats describe the system, not a collection: users, telescopes online,
 * storage used, free space, last sync. All come from queries already running
 * elsewhere in the app (Layout's nav polls telescope status and import
 * status), so this adds no new network traffic — TanStack Query dedupes on
 * the shared query key.
 *
 * Version sits apart from the stat row, far right: it isn't a fact about
 * *this* system the way the others are (every install on the same release
 * shows the same value), so grouping it with Users/Storage/etc. as one more
 * same-size figure undersold it as a stat and, at the smaller `prose` size
 * used for word-like values ("37m ago"), it read as an afterthought next to
 * them. It reuses WhatsNewAutoPopup's 'app-version' query (also mounted at
 * the Layout level), so still no new request.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Settings as SettingsIcon, FileText } from 'lucide-react';
import { getUsers } from '../../lib/api/auth';
import { getAllTelescopeStatus } from '../../lib/api/telescopes';
import { getSystemStorage } from '../../lib/api/storage';
import { getImportStatus } from '../../lib/api/library';
import { fetchJSON } from '../../lib/api/client';
import { formatRelativeShort } from '../../lib/timeFormat';
import { formatNumber } from '../../lib/formatLocale';
import { formatBytesCompact } from '../../lib/utils';
import { CollapsibleHero, HeroSummary } from '../ui/CollapsibleHero';
import { PAGE_HERO } from '../../lib/heroImagery';
import { ChangelogModal } from '../ChangelogModal';

interface Props {
  accent: string;
  subtitle: string;
  isAdmin: boolean;
}

interface VersionInfo {
  version: string;
  shortVersion: string;
  build: number;
}

export function SettingsHero({ accent, subtitle, isAdmin }: Props) {
  const { t } = useTranslation('settings');
  const [showChangelog, setShowChangelog] = useState(false);
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: getUsers, enabled: isAdmin });
  const { data: telescopes } = useQuery({
    queryKey: ['telescope-status-all'],
    queryFn: getAllTelescopeStatus,
    refetchInterval: 30_000,
    staleTime: 25_000,
    enabled: isAdmin,
  });
  const { data: systemStorage } = useQuery({
    queryKey: ['system-storage'],
    queryFn: getSystemStorage,
    staleTime: 60 * 1000,
    enabled: isAdmin,
  });
  const { data: importStatus } = useQuery({
    queryKey: ['import-status'],
    queryFn: getImportStatus,
    refetchInterval: (query) => query.state.data?.running ? 2000 : 15_000,
    enabled: isAdmin,
  });
  const { data: versionInfo } = useQuery({
    queryKey: ['app-version'],
    queryFn: () => fetchJSON<VersionInfo>('/meta/version'),
    staleTime: 60 * 60 * 1000,
    enabled: isAdmin,
  });

  // `prose` marks a value that is words rather than a figure, same convention
  // as LibraryHero/BackupHero.
  const stats: { value: string; label: string; prose?: boolean }[] = [];
  if (isAdmin && users) {
    stats.push({ value: formatNumber(users.length), label: t('hero.users', { count: users.length }) });
  }
  if (isAdmin && telescopes) {
    const online = telescopes.filter(scope => scope.online).length;
    stats.push({ value: `${online} / ${telescopes.length}`, label: t('hero.telescopesOnline') });
  }
  if (isAdmin && systemStorage) {
    // `disk.used` is the whole system drive, most of which has nothing to do
    // with Nebulis. `dataDir.size` is an actual walk of DATA_DIR (which
    // includes the library at its default location) — the same figure
    // StorageDashboard's "App Data" tile shows. `disk.free` stays disk-level
    // on purpose: "how much room is left to grow" is a different, still
    // useful question from "how much have I used so far".
    stats.push({ value: formatBytesCompact(systemStorage.dataDir.size), label: t('hero.librarySize') });
    if (systemStorage.disk) {
      stats.push({ value: formatBytesCompact(systemStorage.disk.free), label: t('hero.diskFree') });
    }
  }
  if (isAdmin && importStatus?.lastRun) {
    stats.push({ value: formatRelativeShort(importStatus.lastRun), label: t('hero.lastSync') });
  }

  const releaseNotesButton = isAdmin && versionInfo ? (
        <button
          type="button"
          onClick={() => setShowChangelog(true)}
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-white/60 transition hover:border-white/20 hover:text-white/80 hover:bg-white/5"
        >
          <FileText className="h-3.5 w-3.5" />
          {t('hero.releaseNotes')}
        </button>
  ) : null;

  // The slim bar has no room for the big version figure the expanded banner shows, so it carries the number beside the button instead.
  const collapsedActions = isAdmin && versionInfo ? (
    <>
      <span className="text-xs font-medium tabular-nums text-white/45" title={t('hero.build', { number: versionInfo.build })}>
        v{versionInfo.version}
      </span>
      {releaseNotesButton}
    </>
  ) : null;

  return (
    <>
    <CollapsibleHero
      page="settings"
      image={PAGE_HERO.settings}
      accent={accent}
      icon={<SettingsIcon className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />}
      title={t('hero.title')}
      summary={stats.length > 0 ? <HeroSummary stats={stats} /> : subtitle}
      actions={collapsedActions}
      contentClassName="flex hero-min-h flex-col justify-center gap-6 p-4 sm:p-6"
    >
        {/* Release notes rides in the title row, same spot Backup's Sync
            button and Gallery's Planetarium button live: it's the one action
            that belongs to the whole hero, not another stat. Keeping it out
            of the stat row is what keeps this banner's height in line with
            its siblings instead of growing a third row underneath. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="font-display flex items-center gap-2.5 text-xl font-bold tracking-tight text-white sm:text-4xl">
              <SettingsIcon className="h-5 w-5 sm:h-7 sm:w-7" style={{ color: accent }} />
              {t('hero.title')}
            </h1>
            <p className="mt-2 text-[0.8125rem] text-white/55">{subtitle}</p>
          </div>

          {releaseNotesButton}
        </div>

        {/* System stats (users, telescopes online, storage, last sync, build)
            repeat what the settings tabs below already say in detail, so on a
            phone they cost more scroll than they're worth: the title, status
            line and release-notes button are what's left there. */}
        {(stats.length > 0 || (isAdmin && versionInfo)) && (
          <div className="hidden flex-wrap items-end justify-between gap-x-12 gap-y-4 sm:flex">
            {stats.length > 0 && (
              <div className="flex flex-wrap items-end gap-x-12 gap-y-4 sm:gap-x-16">
                {stats.map(({ value, label, prose }) => (
                  <div key={label} className="min-w-0">
                    <div className={`font-display font-bold leading-none tracking-tight text-white ${
                      prose ? 'text-xl' : 'text-2xl tabular-nums'
                    }`}>
                      {value}
                    </div>
                    <div className="mt-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-white/45">
                      {label}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Version sits apart, right-aligned: not a stat about this
                install, so it's a separate group rather than one more entry
                in the row above. `items-end` on the shared row still lines
                its value up with the other values exactly, since both are the
                same leading-none value + mt-1.5 label shape. */}
            {isAdmin && versionInfo && (
              <div className="shrink-0 text-left sm:text-right">
                <div className="font-display text-2xl font-bold leading-none tracking-tight text-white tabular-nums">
                  v{versionInfo.version}
                </div>
                <div className="mt-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-white/45">
                  {t('hero.build', { number: versionInfo.build })}
                </div>
              </div>
            )}
          </div>
        )}
    </CollapsibleHero>

      <ChangelogModal isOpen={showChangelog} onClose={() => setShowChangelog(false)} />
    </>
  );
}
