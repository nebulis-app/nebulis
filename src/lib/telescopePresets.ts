/**
 * Per-vendor defaults for new telescope profiles.
 *
 * Picking a `TelescopeKind` in the Add Telescope modal pre-fills the
 * `model`, `shareName`, `username`, and a help blurb so the user only has
 * to type the IP. Selecting `other` clears the share name and exposes a
 * "Generic SMB Layout" docs panel so the user can still import from any
 * SMB-attached camera that follows the documented folder convention.
 *
 * If you add a new vendor, also update the import pipeline if its folder
 * convention differs from SeeStar's (see [docs/multi-telescope-support.md]).
 */

// Keep in sync with server/lib/types/telescopeKind.ts — these cannot share a source without a monorepo.
export const TELESCOPE_KINDS = ['seestar-s50', 'seestar-s30', 'dwarf-3', 'dwarf-2', 'dwarf-mini', 'other'] as const;
export type TelescopeKind = typeof TELESCOPE_KINDS[number];

export interface TelescopePreset {
  kind: TelescopeKind;
  /** Human label shown in the dropdown */
  label: string;
  /** Stored in `TelescopeProfile.model` — used to pick port/protocol defaults */
  model: string;
  /** SMB share name to mount. Empty for `other` so the user fills it in. */
  shareName: string;
  /** Default SMB username. Empty for `other`. */
  username: string;
  /** Short help text shown beneath the share-name input. */
  shareHelp: string;
}

export const TELESCOPE_PRESETS: Record<TelescopeKind, TelescopePreset> = {
  'seestar-s50': {
    kind: 'seestar-s50',
    label: 'ZWO SeeStar S50',
    model: 'SeeStar S50',
    shareName: 'EMMC Images',
    username: 'guest',
    shareHelp: 'SeeStar S50 publishes its photo storage as the SMB share "EMMC Images" with guest access.',
  },
  'seestar-s30': {
    kind: 'seestar-s30',
    label: 'ZWO SeeStar S30',
    model: 'SeeStar S30',
    shareName: 'EMMC Images',
    username: 'guest',
    shareHelp: 'SeeStar S30 publishes its photo storage as the SMB share "EMMC Images" with guest access.',
  },
  'dwarf-3': {
    kind: 'dwarf-3',
    label: 'DwarfLab Dwarf 3',
    model: 'Dwarf 3',
    shareName: 'Astronomy',
    username: 'dwarf',
    shareHelp: 'Dwarf 3 exposes its astronomy storage as an SMB share named "Astronomy". The default SMB user is "dwarf".',
  },
  'dwarf-2': {
    kind: 'dwarf-2',
    label: 'DwarfLab Dwarf II',
    model: 'Dwarf II',
    shareName: 'Astronomy',
    username: 'dwarf',
    shareHelp: 'Dwarf II exposes its astronomy storage as an SMB share named "Astronomy". The default SMB user is "dwarf".',
  },
  'dwarf-mini': {
    kind: 'dwarf-mini',
    label: 'DwarfLab Dwarf Mini',
    model: 'Dwarf Mini',
    shareName: 'Astronomy',
    username: 'dwarf',
    shareHelp: 'Dwarf Mini exposes its astronomy storage as an SMB share named "Astronomy". The default SMB user is "dwarf".',
  },
  'other': {
    kind: 'other',
    label: 'Other (custom SMB share)',
    model: 'Custom',
    shareName: '',
    username: '',
    shareHelp: 'Custom SMB share. See "Generic SMB Layout" for the folder convention this app expects.',
  },
};

/** Coerce a DOM select string to TelescopeKind. Unknown values fall back to 'other'. */
export function toTelescopeKind(v: string): TelescopeKind {
  return (TELESCOPE_KINDS as readonly string[]).includes(v) ? (v as TelescopeKind) : 'other';
}

/** Default badge color for each telescope kind. The backend uses the same
 *  palette during boot backfill — keep them in sync. */
export const DEFAULT_COLOR_BY_KIND: Record<TelescopeKind, string> = {
  'seestar-s50': '#3b82f6',
  'seestar-s30': '#10b981',
  'dwarf-3':     '#f59e0b',
  'dwarf-2':     '#ef4444',
  'dwarf-mini':  '#f97316',
  'other':       '#8b5cf6',
};

/** Hand-picked palette used by the per-telescope color picker. Eight shades
 *  scoped to be high-contrast against both light and dark backgrounds. */
export const TELESCOPE_COLOR_PALETTE: string[] = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
];

/** 2-3 letter abbreviation used as fallback inside marker badges when there's
 *  no room to render the full name. */
export function abbreviateTelescope(name: string, kind: TelescopeKind): string {
  switch (kind) {
    case 'seestar-s50': return 'S50';
    case 'seestar-s30': return 'S30';
    case 'dwarf-3':     return 'D3';
    case 'dwarf-2':     return 'D2';
    case 'dwarf-mini':  return 'DM';
    case 'other': {
      // First two non-space chars uppercased, falling back to "?" if blank.
      const compact = name.replace(/\s+/g, '');
      return compact.slice(0, 2).toUpperCase() || '??';
    }
  }
}

/** Reverse-lookup: given a stored profile's `model` field, infer which kind
 *  it was created from. Used by the edit modal to seed the dropdown. */
export function modelToKind(model: string): TelescopeKind {
  switch (model) {
    case 'SeeStar S50': return 'seestar-s50';
    case 'SeeStar S30': return 'seestar-s30';
    case 'Dwarf 3':     return 'dwarf-3';
    case 'Dwarf II':    return 'dwarf-2';
    case 'Dwarf Mini':  return 'dwarf-mini';
    default:            return 'other';
  }
}
