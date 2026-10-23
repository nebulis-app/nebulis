import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Sparkles, Wrench, ArrowRight, AlertCircle } from 'lucide-react';
import { Modal } from './ui/Modal';
import { useTheme } from '../hooks/useTheme';
import { fetchJSON } from '../lib/api/client';

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

interface ChangelogEntry {
  version: string;
  build: number;
  date: string;
  sections: Record<string, string[]>;
}

// The parsed CHANGELOG.md section names are a fixed, known set (Keep a
// Changelog convention), so each gets its own translated label key. The
// bullet text underneath each section is the changelog's own editorial
// content and stays in English (same deferred-scope decision as the
// server-side error message prose).
const SECTION_META: Record<string, { labelKey: string; Icon: React.ElementType; chip: string }> = {
  Added:   { labelKey: 'changelogModal.sections.added',   Icon: Sparkles,   chip: 'bg-emerald-500/15 text-emerald-400' },
  Changed: { labelKey: 'changelogModal.sections.changed', Icon: ArrowRight,  chip: 'bg-blue-500/15 text-blue-400' },
  Fixed:   { labelKey: 'changelogModal.sections.fixed',   Icon: Wrench,      chip: 'bg-amber-500/15 text-amber-400' },
  Removed: { labelKey: 'changelogModal.sections.removed', Icon: AlertCircle, chip: 'bg-red-500/15 text-red-400' },
};
// CHANGELOG.md headings use New / Updated; they share the Added / Changed
// styling and translated labels.
SECTION_META.New = SECTION_META.Added;
SECTION_META.Updated = SECTION_META.Changed;
const SECTION_META_LIGHT: Record<string, { chip: string }> = {
  Added:   { chip: 'bg-emerald-50 text-emerald-700' },
  Changed: { chip: 'bg-blue-50 text-blue-700' },
  Fixed:   { chip: 'bg-amber-50 text-amber-700' },
  Removed: { chip: 'bg-red-50 text-red-700' },
};
SECTION_META_LIGHT.New = SECTION_META_LIGHT.Added;
SECTION_META_LIGHT.Updated = SECTION_META_LIGHT.Changed;

const LINK_PATTERN = /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;

/** Turns [text](https://...) into links, leaving everything else as written. Only https links, so a changelog line can never
 *  carry a script or other scheme into an href. */
function renderLinks(text: string, linkClass: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <a key={at} href={match[2]} target="_blank" rel="noopener noreferrer" className={linkClass}>{match[1]}</a>,
    );
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Renders **bold** spans and [links](https://...) from changelog text. A span holding a Settings path
 *  ("Settings -> Library -> Filter aliases") becomes a chip so it reads as a
 *  place to go; any other bold span is a plain lead-in. */
function renderInline(text: string, strongClass: string, isDark: boolean): React.ReactNode[] {
  const chipClass = isDark
    ? 'bg-slate-800 text-slate-100 ring-1 ring-slate-700'
    : 'bg-slate-100 text-slate-900 ring-1 ring-slate-200';
  const linkClass = isDark ? 'text-accent-400 hover:underline' : 'text-accent-600 hover:underline';
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => {
    if (i % 2 === 0) return <span key={i}>{renderLinks(part, linkClass)}</span>;
    if (part.includes('->')) {
      return (
        <span key={i} className={`mx-0.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[0.85em] font-medium ${chipClass}`}>
          {part.replace(/ -> /g, ' \u2192 ')}
        </span>
      );
    }
    return <strong key={i} className={strongClass}>{part}</strong>;
  });
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** When provided, the modal renders a footer with two buttons used by the
   *  first-login auto-popup: "Got it" calls onAcknowledge (which should
   *  persist lastSeenVersion server-side), and "Remind me later" just
   *  closes. Omit both for the regular Help → What's New trigger. */
  onAcknowledge?: () => void;
  acknowledging?: boolean;
  /** When set, the modal renders only the entry matching this version
   *  (used by the first-login popup so users see just what's new in the
   *  release they're seeing for the first time, not the whole history).
   *  Omit to show all entries — the Help → What's New trigger does this. */
  onlyVersion?: string;
  /** When provided, renders a "View full release notes" link in the footer
   *  (only visible alongside the acknowledgement footer). */
  onViewAll?: () => void;
}

export function ChangelogModal({ isOpen, onClose, onAcknowledge, acknowledging, onlyVersion, onViewAll }: Props) {
  const { isDark } = useTheme();
  const { t } = useTranslation('common');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const { data: entries = [], isPending: loading, isError: error } = useQuery({
    queryKey: ['changelog'],
    queryFn: () => fetchJSON<ChangelogEntry[]>('/meta/changelog'),
    enabled: isOpen,
    staleTime: 5 * 60 * 1000,
  });

  // When called from the first-login popup, narrow to a single version's
  // notes so users see what's new in *this* release rather than the entire
  // changelog. If the package.json version doesn't appear in CHANGELOG.md
  // verbatim (e.g. pkg=1.0.0 but changelog header says "1.1"), fall back to
  // the newest entry rather than the full history — the latter would
  // defeat the point of the filter.
  const visibleOrAll: ChangelogEntry[] = onlyVersion
    ? (() => {
        const match = entries.filter(e => e.version === onlyVersion);
        if (match.length > 0) return match;
        return entries.slice(0, 1); // newest entry; entries are sorted newest-first
      })()
    : entries;
  // Header label tracks what we actually rendered, not the pkg.json version,
  // so the title can't get out of sync with the bullets shown below.
  const renderedVersion = onlyVersion && visibleOrAll.length > 0
    ? visibleOrAll[0].version
    : null;

  // Two-pane layout kicks in only when there's actually history to browse.
  // The auto-popup path (onlyVersion) sticks with the single-pane style.
  const showRail = !onlyVersion && visibleOrAll.length > 1;
  // Fall back to the newest entry when the user hasn't clicked one yet.
  const effectiveKey = selectedKey ?? (visibleOrAll[0] ? `${visibleOrAll[0].version}-${visibleOrAll[0].build}` : null);
  const selectedEntry = visibleOrAll.find(e => `${e.version}-${e.build}` === effectiveKey)
    ?? visibleOrAll[0]
    ?? null;

  const bg      = isDark ? 'bg-slate-900'   : 'bg-white';
  const border  = isDark ? 'border-slate-800' : 'border-slate-200';
  const heading = isDark ? 'text-slate-100'  : 'text-slate-900';
  const muted   = isDark ? 'text-slate-400'  : 'text-slate-500';
  const divider = isDark ? 'border-slate-800' : 'border-slate-100';
  const itemText = isDark ? 'text-slate-300' : 'text-slate-700';
  const versionBadge = isDark
    ? 'bg-slate-800 text-slate-300 border-slate-700'
    : 'bg-slate-100 text-slate-600 border-slate-200';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('changelogModal.title')}
      // Two-pane layout needs more horizontal room than the single-pane
      // popup, so widen the modal when the version rail is showing. Both
      // step up on large viewports so release notes don't render as a narrow
      // column on high-resolution displays.
      className={`w-full ${showRail ? 'max-w-2xl xl:max-w-4xl 2xl:max-w-5xl' : 'max-w-lg xl:max-w-2xl 2xl:max-w-3xl'} max-h-[80vh] 2xl:max-h-[85vh] flex flex-col`}
    >
      <div className={`flex flex-col rounded-2xl border shadow-xl overflow-hidden ${bg} ${border}`}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${divider}`}>
          <div>
            <h2 className={`text-base font-bold ${heading}`}>
              {renderedVersion ? t('changelogModal.titleForVersion', { version: renderedVersion }) : t('changelogModal.title')}
            </h2>
            <p className={`text-xs mt-0.5 ${muted}`}>
              {renderedVersion ? t('changelogModal.highlightsFromRelease') : t('changelogModal.releaseHistory')}
            </p>
          </div>
          <button
            onClick={onClose}
            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
            aria-label={t('changelogModal.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        {(loading || error || visibleOrAll.length === 0) && (
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {loading && (
              <p className={`text-sm text-center py-8 ${muted}`}>{t('changelogModal.loading')}</p>
            )}
            {error && (
              <p className={`text-sm text-center py-8 text-red-400`}>{t('changelogModal.loadFailed')}</p>
            )}
            {!loading && !error && visibleOrAll.length === 0 && (
              <p className={`text-sm text-center py-8 ${muted}`}>{t('changelogModal.noEntries')}</p>
            )}
          </div>
        )}

        {!loading && !error && visibleOrAll.length > 0 && (
          <div className={`flex-1 flex min-h-0 ${showRail ? 'divide-x ' + (isDark ? 'divide-slate-800' : 'divide-slate-100') : ''}`}>
            {/* Left rail: vertical list of versions. Hidden when only one
                entry is in scope (auto-popup case). */}
            {showRail && (
              <nav
                aria-label={t('changelogModal.releaseVersions')}
                className={`w-36 shrink-0 overflow-y-auto py-3 ${isDark ? 'bg-slate-950/40' : 'bg-slate-50/60'}`}
              >
                <ul className="space-y-0.5 px-2">
                  {visibleOrAll.map(entry => {
                    const key = `${entry.version}-${entry.build}`;
                    const isSelected = key === effectiveKey;
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          onClick={() => setSelectedKey(key)}
                          aria-current={isSelected ? 'true' : undefined}
                          className={`w-full text-left px-2.5 py-2 rounded-lg transition ${
                            isSelected
                              ? (isDark ? 'bg-accent-500/15 text-accent-300' : 'bg-accent-50 text-accent-700')
                              : (isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100')
                          }`}
                        >
                          <div className="text-sm font-medium">v{entry.version}</div>
                          <div className={`text-[0.625rem] mt-0.5 ${isSelected ? '' : muted}`}>
                            {entry.date}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            )}

            {/* Right pane: selected version's release notes. When there's
                no rail this fills the modal alone. */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {selectedEntry && (
                <EntryDetail
                  entry={selectedEntry}
                  isDark={isDark}
                  heading={heading}
                  muted={muted}
                  itemText={itemText}
                  versionBadge={versionBadge}
                  t={t}
                />
              )}
            </div>
          </div>
        )}

        {/* Acknowledgement footer — present only when the modal was opened
            by the first-login auto-popup. "Got it" persists the dismissal
            for this version; "Remind me later" closes without persisting,
            so the popup will reappear on next login. */}
        {onAcknowledge && (
          <div className={`flex items-center justify-between gap-2 px-5 py-3 border-t ${divider}`}>
            {onViewAll ? (
              <button
                onClick={onViewAll}
                className={`text-xs font-medium transition ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}
              >
                {t('changelogModal.viewFullReleaseNotes')}
              </button>
            ) : <span />}
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                disabled={acknowledging}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50 ${
                  isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
                }`}
              >
                {t('changelogModal.remindMeLater')}
              </button>
              <button
                onClick={onAcknowledge}
                disabled={acknowledging || loading}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
              >
                {acknowledging ? t('changelogModal.saving') : t('changelogModal.gotIt')}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Render a single changelog entry's header + categorized bullet sections.
 *  Extracted so the same markup serves both the auto-popup (single entry)
 *  and the rail-driven detail pane. */
function EntryDetail({
  entry,
  isDark,
  heading,
  muted,
  itemText,
  versionBadge,
  t,
}: {
  entry: ChangelogEntry;
  isDark: boolean;
  heading: string;
  muted: string;
  itemText: string;
  versionBadge: string;
  t: TFunc;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-3">
        <span className={`text-sm font-bold ${heading}`}>v{entry.version}</span>
        <span className={`text-xs font-mono px-1.5 py-0.5 rounded border ${versionBadge}`}>
          {t('changelogModal.build', { number: entry.build })}
        </span>
        <span className={`text-xs ${muted}`}>{entry.date}</span>
      </div>
      <div className="space-y-6">
        {Object.entries(entry.sections).map(([sectionName, items]) => {
          const meta = SECTION_META[sectionName];
          const lightMeta = SECTION_META_LIGHT[sectionName];
          const chipClass = isDark
            ? (meta?.chip ?? 'bg-slate-700 text-slate-300')
            : (lightMeta?.chip ?? 'bg-slate-100 text-slate-600');
          const Icon = meta?.Icon;
          const sectionLabel = meta ? t(meta.labelKey) : sectionName;
          return (
            <div key={sectionName}>
              <div className={`inline-flex items-center gap-1 text-sm font-semibold px-3 py-1 rounded-full mb-3 ${chipClass}`}>
                {Icon && <Icon className="w-4 h-4" />}
                {sectionLabel}
              </div>
              <ul className="space-y-3.5">
                {items.map((item, j) => {
                  // Sub-bullets arrive as extra lines after the parent text.
                  const [head, ...subs] = item.split('\n');
                  const subText = isDark ? 'text-slate-400' : 'text-slate-600';
                  const strong = isDark ? 'font-semibold text-slate-100' : 'font-semibold text-slate-900';
                  const dot = isDark ? 'bg-slate-500' : 'bg-slate-400';
                  return (
                    <li key={j} className={`text-sm ${itemText}`}>
                      <div className="flex gap-2">
                        <span className={`mt-1.5 w-1 h-1 rounded-full shrink-0 ${dot}`} />
                        <span>{renderInline(head, strong, isDark)}</span>
                      </div>
                      {subs.length > 0 && (
                        <ul className={`mt-1.5 ml-3 space-y-1 ${subText}`}>
                          {subs.map((sub, k) => (
                            <li key={k} className="flex gap-2">
                              <span className={`mt-2.5 h-px w-2 shrink-0 ${isDark ? 'bg-slate-400' : 'bg-slate-500'}`} />
                              <span>{renderInline(sub, strong, isDark)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
