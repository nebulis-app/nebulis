import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Sparkles, Wrench, ArrowRight, AlertCircle } from 'lucide-react';
import { Modal } from './ui/Modal';
import { useTheme } from '../hooks/useTheme';
import { fetchJSON } from '../lib/api/client';

interface ChangelogEntry {
  version: string;
  build: number;
  date: string;
  sections: Record<string, string[]>;
}

const SECTION_META: Record<string, { label: string; Icon: React.ElementType; chip: string }> = {
  Added:   { label: 'Added',   Icon: Sparkles,   chip: 'bg-emerald-500/15 text-emerald-400' },
  Changed: { label: 'Changed', Icon: ArrowRight,  chip: 'bg-blue-500/15 text-blue-400' },
  Fixed:   { label: 'Fixed',   Icon: Wrench,      chip: 'bg-amber-500/15 text-amber-400' },
  Removed: { label: 'Removed', Icon: AlertCircle, chip: 'bg-red-500/15 text-red-400' },
};
const SECTION_META_LIGHT: Record<string, { chip: string }> = {
  Added:   { chip: 'bg-emerald-50 text-emerald-700' },
  Changed: { chip: 'bg-blue-50 text-blue-700' },
  Fixed:   { chip: 'bg-amber-50 text-amber-700' },
  Removed: { chip: 'bg-red-50 text-red-700' },
};

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
      title="What's New"
      // Two-pane layout needs more horizontal room than the single-pane
      // popup, so widen the modal when the version rail is showing.
      className={`w-full ${showRail ? 'max-w-2xl' : 'max-w-lg'} max-h-[80vh] flex flex-col`}
    >
      <div className={`flex flex-col rounded-2xl border shadow-xl overflow-hidden ${bg} ${border}`}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${divider}`}>
          <div>
            <h2 className={`text-base font-bold ${heading}`}>
              {renderedVersion ? `What's New in v${renderedVersion}` : "What's New"}
            </h2>
            <p className={`text-xs mt-0.5 ${muted}`}>
              {renderedVersion ? 'Highlights from this release' : 'Release history'}
            </p>
          </div>
          <button
            onClick={onClose}
            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        {(loading || error || visibleOrAll.length === 0) && (
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {loading && (
              <p className={`text-sm text-center py-8 ${muted}`}>Loading...</p>
            )}
            {error && (
              <p className={`text-sm text-center py-8 text-red-400`}>Could not load changelog.</p>
            )}
            {!loading && !error && visibleOrAll.length === 0 && (
              <p className={`text-sm text-center py-8 ${muted}`}>No entries yet.</p>
            )}
          </div>
        )}

        {!loading && !error && visibleOrAll.length > 0 && (
          <div className={`flex-1 flex min-h-0 ${showRail ? 'divide-x ' + (isDark ? 'divide-slate-800' : 'divide-slate-100') : ''}`}>
            {/* Left rail: vertical list of versions. Hidden when only one
                entry is in scope (auto-popup case). */}
            {showRail && (
              <nav
                aria-label="Release versions"
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
                          <div className={`text-[10px] mt-0.5 ${isSelected ? '' : muted}`}>
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
                View full release notes
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
                Remind me later
              </button>
              <button
                onClick={onAcknowledge}
                disabled={acknowledging || loading}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
              >
                {acknowledging ? 'Saving…' : 'Got it'}
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
}: {
  entry: ChangelogEntry;
  isDark: boolean;
  heading: string;
  muted: string;
  itemText: string;
  versionBadge: string;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-3">
        <span className={`text-sm font-bold ${heading}`}>v{entry.version}</span>
        <span className={`text-xs font-mono px-1.5 py-0.5 rounded border ${versionBadge}`}>
          build {entry.build}
        </span>
        <span className={`text-xs ${muted}`}>{entry.date}</span>
      </div>
      <div className="space-y-3">
        {Object.entries(entry.sections).map(([sectionName, items]) => {
          const meta = SECTION_META[sectionName];
          const lightMeta = SECTION_META_LIGHT[sectionName];
          const chipClass = isDark
            ? (meta?.chip ?? 'bg-slate-700 text-slate-300')
            : (lightMeta?.chip ?? 'bg-slate-100 text-slate-600');
          const Icon = meta?.Icon;
          return (
            <div key={sectionName}>
              <div className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full mb-2 ${chipClass}`}>
                {Icon && <Icon className="w-3 h-3" />}
                {sectionName}
              </div>
              <ul className="space-y-1">
                {items.map((item, j) => (
                  <li key={j} className={`flex gap-2 text-sm ${itemText}`}>
                    <span className={`mt-1.5 w-1 h-1 rounded-full shrink-0 ${isDark ? 'bg-slate-500' : 'bg-slate-400'}`} />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
