/** The Settings page's navigation tree. Lives apart from SettingsNav.tsx so that file only exports a component. */
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
  Puzzle,
  Bell,
} from 'lucide-react';

/** Sidebar section id -> label key. Absent ids render a divider only. */
export const SETTINGS_SECTION_LABELS: Record<string, string> = {
  equipment: 'nav.sectionEquipment',
  system: 'nav.sectionSystem',
  advanced: 'nav.sectionAdvanced',
};

export interface SettingsNavItem {
  id: string;
  labelKey: string;
  adminOnly?: boolean;
}

export interface SettingsNavGroup {
  id: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
  adminOnly?: boolean;
  /** Sidebar heading this group sits under. A heading is drawn wherever the
   *  value changes from the previous visible group; sections with no entry in
   *  SETTINGS_SECTION_LABELS get a plain divider instead. */
  section: string;
  /** Sub-navigation for groups dense enough to need it. Absent groups render
   *  as a single flat pane, same as before this file existed. */
  items?: SettingsNavItem[];
}

/** Ids are load-bearing: `Settings.tsx` reads `?tab=` from three external deep
 *  links (TonightPanel, BackupStatus, and Settings' own What's New link), so
 *  they stay stable even where the label shown to the user has changed
 *  (`hardware` → "Telescopes", `danger` → "Advanced").
 *
 * `labelKey` rather than `label`: this array is built at module load, before
 * any component (and its useTranslation() hook) exists, so it cannot carry
 * translated text directly — consumers resolve it with t(labelKey, { ns:
 * 'settings' }). */
export const SETTINGS_NAV: SettingsNavGroup[] = [
  { id: 'general', labelKey: 'nav.general', icon: Settings, section: 'main' },
  {
    id: 'library',
    labelKey: 'nav.library',
    icon: Library,
    section: 'main',
    items: [
      { id: 'display', labelKey: 'nav.display' },
      { id: 'organization', labelKey: 'nav.organization' },
      { id: 'processing', labelKey: 'nav.processing' },
    ],
  },
  { id: 'hardware', labelKey: 'nav.hardware', icon: Telescope, adminOnly: true, section: 'equipment' },
  {
    id: 'sky',
    labelKey: 'nav.sky',
    icon: Compass,
    adminOnly: true,
    section: 'equipment',
    items: [
      { id: 'sites', labelKey: 'nav.sites' },
      // Downloaded reference data (offline catalogs, TLEs) is sky data, not disk management.
      { id: 'catalogs', labelKey: 'nav.catalogs' },
    ],
  },
  { id: 'integrations', labelKey: 'nav.features', icon: Puzzle, adminOnly: true, section: 'equipment' },
  {
    id: 'storage',
    labelKey: 'nav.storage',
    icon: HardDrive,
    adminOnly: true,
    section: 'system',
    items: [
      { id: 'location', labelKey: 'nav.location' },
      // A bare "Archive" in the nav, which the user asked for. This codebase also has
      // a calibration archive, so the section title stays "External archive" and the
      // copy says "archive disk" throughout: the short nav label is disambiguated by
      // what it opens, not by repeating the qualifier in the menu.
      { id: 'archive', labelKey: 'nav.archive' },
      { id: 'linked', labelKey: 'nav.linked' },
      { id: 'backups', labelKey: 'nav.backups' },
      { id: 'cleanup', labelKey: 'nav.cleanup' },
      { id: 'maintenance', labelKey: 'nav.maintenance' },
    ],
  },
  {
    id: 'account',
    labelKey: 'nav.account',
    icon: User,
    section: 'system',
    items: [
      { id: 'users', labelKey: 'nav.users', adminOnly: true },
      { id: 'devices', labelKey: 'nav.devices', adminOnly: true },
      // Keys belong to the signed-in user, so non-admins get Account too, with
      // just this item. Admins see everyone's keys via the Mine/Everyone toggle.
      { id: 'api-keys', labelKey: 'nav.apiKeys' },
    ],
  },
  { id: 'alerts', labelKey: 'nav.alerts', icon: Bell, adminOnly: true, section: 'system' },
  { id: 'updates', labelKey: 'nav.updates', icon: Download, adminOnly: true, section: 'system' },
  { id: 'log', labelKey: 'nav.log', icon: ScrollText, adminOnly: true, section: 'advanced' },
  { id: 'danger', labelKey: 'nav.danger', icon: AlertTriangle, danger: true, adminOnly: true, section: 'advanced' },
  { id: 'about', labelKey: 'nav.about', icon: Info, section: 'about' },
];

/** Groups and sub-items the current user may see. A group whose items are all
 *  filtered out is dropped, and one left with a single item keeps it. */
export function visibleSettingsNav(isAdmin: boolean): SettingsNavGroup[] {
  return SETTINGS_NAV.filter(g => !g.adminOnly || isAdmin).map(g =>
    g.items ? { ...g, items: g.items.filter(i => !i.adminOnly || isAdmin) } : g,
  );
}
