import {
  Settings,
  User,
  Telescope,
  Compass,
  HardDrive,
  AlertTriangle,
  ScrollText,
  Download,
  Library,
  Info,
} from 'lucide-react';
import { cloneElement, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getUpdateStatus } from '../../lib/api/update';
import { TourAnchor } from '../tour/TourAnchor';

export interface SettingsNavItem {
  id: string;
  label: string;
}

interface SettingsNavGroup {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
  adminOnly?: boolean;
  /** Sub-navigation for groups dense enough to need it. Absent groups render
   *  as a single flat pane, same as before this file existed. */
  items?: SettingsNavItem[];
}

/** Ids are load-bearing: `Settings.tsx` reads `?tab=` from three external deep
 *  links (TonightPanel, BackupStatus, and Settings' own What's New link), so
 *  they stay stable even where the label shown to the user has changed
 *  (`hardware` → "Telescopes", `danger` → "Advanced"). */
export const SETTINGS_NAV: SettingsNavGroup[] = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'updates', label: 'Updates', icon: Download, adminOnly: true },
  {
    id: 'account',
    label: 'Account',
    icon: User,
    adminOnly: true,
    items: [
      { id: 'users', label: 'Users' },
      { id: 'devices', label: 'Devices' },
    ],
  },
  { id: 'hardware', label: 'Telescopes', icon: Telescope, adminOnly: true },
  { id: 'sky', label: 'Sky', icon: Compass, adminOnly: true },
  {
    id: 'storage',
    label: 'Storage',
    icon: HardDrive,
    adminOnly: true,
    items: [
      { id: 'location', label: 'Location' },
      { id: 'organize', label: 'Organize' },
      { id: 'cleanup', label: 'Cleanup' },
      { id: 'backups', label: 'Backups' },
    ],
  },
  { id: 'log', label: 'System Log', icon: ScrollText, adminOnly: true },
  { id: 'danger', label: 'Advanced', icon: AlertTriangle, danger: true, adminOnly: true },
  { id: 'about', label: 'About', icon: Info },
];

interface Props {
  activeGroupId: string;
  activeItemId: string | null;
  onNavigateGroup: (id: string) => void;
  onNavigateItem: (id: string) => void;
  isDark: boolean;
  isAdmin?: boolean;
}

export function SettingsNav({
  activeGroupId,
  activeItemId,
  onNavigateGroup,
  onNavigateItem,
  isDark,
  isAdmin = true,
}: Props) {
  const visible = SETTINGS_NAV.filter(g => !g.adminOnly || isAdmin);

  // Same query key as SoftwareUpdateCard / the top nav's Settings badge, so
  // this rides their cache instead of firing its own request.
  const { data: updateStatus } = useQuery({
    queryKey: ['update-status'],
    queryFn: getUpdateStatus,
    enabled: isAdmin,
    refetchInterval: 60_000,
  });
  const hasUpdateAvailable = updateStatus?.updateAvailable ?? false;

  return (
    <>
      {/* Desktop: sticky left sidebar. Hidden below `lg`, where the strip
          below takes over. */}
      <nav className="hidden lg:block sticky top-24 w-56 shrink-0 self-start">
        <div className={`px-2.5 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${
          isDark ? 'text-slate-600' : 'text-slate-400'
        }`}>
          Settings
        </div>
        <ul className="space-y-0.5">
          {visible.map(group => {
            const Icon = group.icon;
            const isActive = group.id === activeGroupId;
            const isDanger = group.danger;
            return (
              <li key={group.id}>
                <TourAnchor id={`settings-nav-${group.id}`}>
                <button
                  onClick={() => onNavigateGroup(group.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors ${
                    isActive
                      ? isDanger
                        ? isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-600'
                        : isDark ? 'bg-slate-800 text-accent-400' : 'bg-accent-100 text-accent-700'
                      : isDanger
                        ? isDark ? 'text-slate-500 hover:bg-slate-900 hover:text-red-400' : 'text-slate-500 hover:bg-slate-100 hover:text-red-600'
                        : isDark ? 'text-slate-400 hover:bg-slate-900 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {group.label}
                  {group.id === 'updates' && hasUpdateAvailable && (
                    <span className="ml-auto flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none shrink-0">
                      1
                    </span>
                  )}
                </button>
                </TourAnchor>

                {group.items && (
                  <ul className={`mt-0.5 ml-[1.125rem] space-y-0.5 border-l pl-3.5 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                    {group.items.map(item => {
                      const itemActive = item.id === activeItemId;
                      return (
                        <li key={item.id}>
                          <button
                            onClick={() => onNavigateItem(item.id)}
                            className={`block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] font-medium transition-colors ${
                              itemActive
                                ? isDark ? 'text-accent-400' : 'text-accent-700'
                                : isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-500 hover:text-slate-800'
                            }`}
                          >
                            {item.label}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Mobile/tablet: horizontal scrollable strip, same interaction as the
          old top-tab design. A second strip of sub-tabs appears under it when
          the active group has items — this is the "top tabs + sub-tabs"
          layout kept alive as the responsive fallback for the sidebar above. */}
      <div className="lg:hidden">
        <TabStrip
          activeId={activeGroupId}
          items={visible.map(g => ({
            id: g.id,
            label: g.label,
            icon: g.icon,
            danger: g.danger,
            badge: g.id === 'updates' && hasUpdateAvailable,
          }))}
          onSelect={onNavigateGroup}
          isDark={isDark}
          // The guided tour anchors on `settings-nav-<group.id>` (see steps.ts).
          // The desktop sidebar above carries it directly; below the `lg`
          // breakpoint that sidebar is `hidden`, so without this the anchor
          // never resolves and the tour's "telescopes"/"settings" steps hang
          // forever waiting for an element that will never mount.
          tourAnchorPrefix="settings-nav-"
        />
        {(() => {
          const activeGroup = visible.find(g => g.id === activeGroupId);
          if (!activeGroup?.items) return null;
          return (
            <TabStrip
              activeId={activeItemId ?? activeGroup.items[0].id}
              items={activeGroup.items.map(i => ({ id: i.id, label: i.label }))}
              onSelect={onNavigateItem}
              isDark={isDark}
              compact
            />
          );
        })()}
      </div>
    </>
  );
}

interface TabStripItem {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  danger?: boolean;
  badge?: boolean;
}

/** Underlined horizontal tab strip. Ported from the pre-sidebar `SettingsTabs`
 *  so mobile keeps the same proven interaction; reused a second time, in
 *  `compact` mode, for the sub-item row under a group that has one. */
function TabStrip({
  activeId,
  items,
  onSelect,
  isDark,
  compact = false,
  tourAnchorPrefix,
}: {
  activeId: string;
  items: TabStripItem[];
  onSelect: (id: string) => void;
  isDark: boolean;
  compact?: boolean;
  /** When set, each tab is wrapped in a `<TourAnchor id={prefix + item.id}>`. */
  tourAnchorPrefix?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [underline, setUnderline] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    function measure() {
      const el = refs.current[activeId];
      if (!el) return setUnderline(null);
      setUnderline({ left: el.offsetLeft, width: el.offsetWidth });
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [activeId, items.length]);

  const isDanger = items.find(i => i.id === activeId)?.danger;

  return (
    <div
      className={`${compact ? '' : 'sticky top-16 z-30 -mx-4 sm:-mx-6 backdrop-blur-xl border-b'} px-4 sm:px-6 ${
        compact ? '' : isDark ? 'bg-slate-950/85 border-slate-800' : 'bg-white/85 border-slate-200'
      }`}
    >
      <div
        className={`relative flex items-center gap-1 overflow-x-auto ${compact ? 'h-9 border-b' : 'h-12'} ${
          compact ? (isDark ? 'border-slate-800/70' : 'border-slate-100') : ''
        }`}
      >
        {items.map(item => {
          const Icon = item.icon;
          const isActive = item.id === activeId;
          const isItemDanger = item.danger;
          const button = (
            <button
              ref={el => { refs.current[item.id] = el; }}
              onClick={() => onSelect(item.id)}
              className={`relative flex items-center gap-2 h-full whitespace-nowrap font-medium transition-colors ${
                compact ? 'px-3 text-[12px]' : 'px-4 text-[13px]'
              } ${
                isActive
                  ? isItemDanger
                    ? isDark ? 'text-red-400' : 'text-red-600'
                    : isDark ? 'text-accent-400' : 'text-accent-600'
                  : isItemDanger
                    ? isDark ? 'text-slate-500 hover:text-red-400' : 'text-slate-400 hover:text-red-600'
                    : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {Icon && <Icon className="w-4 h-4" />}
              {item.label}
              {item.badge && (
                <span className="absolute top-1.5 right-1.5 flex items-center justify-center w-3.5 h-3.5 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none">
                  1
                </span>
              )}
            </button>
          );
          if (!tourAnchorPrefix) return cloneElement(button, { key: item.id });
          return (
            <TourAnchor key={item.id} id={`${tourAnchorPrefix}${item.id}`}>
              {button}
            </TourAnchor>
          );
        })}
        {underline && (
          <span
            aria-hidden
            className={`absolute bottom-0 rounded-full transition-all duration-200 ease-out ${
              compact ? 'h-[1.5px]' : 'h-[2px]'
            } ${isDanger ? 'bg-red-500' : 'bg-accent-500'}`}
            style={{ left: underline.left, width: underline.width }}
          />
        )}
      </div>
    </div>
  );
}
