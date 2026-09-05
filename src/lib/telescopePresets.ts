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

import { isOneOf } from './typeGuards';

// Keep in sync with server/lib/types/telescopeKind.ts — these cannot share a source without a monorepo.
export const TELESCOPE_KINDS = ['seestar-s50', 'seestar-s50-pro', 'seestar-s30', 'seestar-s30-pro', 'dwarf-3', 'dwarf-2', 'dwarf-mini', 'asiair', 'other'] as const;
export type TelescopeKind = typeof TELESCOPE_KINDS[number];

interface HelpBlock {
  /** Bolded first line. One idea, no more than ~45 chars. */
  headline: string;
  /** Optional supporting sentence. */
  body?: string;
  /** Optional caveats, rendered as a bullet list. */
  tips?: string[];
}

interface TelescopePreset {
  kind: TelescopeKind;
  /** Human label shown in the dropdown */
  label: string;
  /** Stored in `TelescopeProfile.model` — used to pick port/protocol defaults */
  model: string;
  /** SMB share name to mount. Empty for `other` so the user fills it in, and
   *  empty for Dwarf kinds, which serve FTP rather than an SMB share. */
  shareName: string;
  /** Default username. Empty for `other`. `anonymous` for Dwarf kinds,
   *  matching the FTP login their firmware documents (smb.ftp.ts). */
  username: string;
  /** Help under the Hostname/IP field. Only used by FTP (Dwarf) kinds. */
  addressHelp?: HelpBlock;
  /** Help under the SMB Share Name field. Unused by FTP kinds. */
  shareHelp?: HelpBlock;
  /** Pre-filled address for the connection field. Dwarf devices always sit at
   *  192.168.88.1 when running their own access point. Empty means the user
   *  has to find their telescope's IP themselves. */
  defaultHostname: string;
  /** Support for this device is built from published layouts rather than
   *  tested against hardware. Renders a "(Beta)" marker and a short caveat so
   *  the user knows what they are opting into. */
  beta?: boolean;
}

/** Address a DWARFLAB telescope serves from when broadcasting its own Wi-Fi.
 *  In station mode (joined to a home router) the address comes from DHCP. */
export const DWARF_AP_HOST = '192.168.88.1';

/** Help for Dwarf address field. Same for all three models. */
const DWARF_ADDRESS_HELP: HelpBlock = {
  headline: 'Dwarf telescopes use FTP, not SMB.',
  body: 'Connect to telescope Wi-Fi and leave the address at 192.168.88.1.',
  tips: ['On station mode, enter the address your router gave it instead.'],
};

export const TELESCOPE_PRESETS: Record<TelescopeKind, TelescopePreset> = {
  'seestar-s50': {
    kind: 'seestar-s50',
    label: 'ZWO SeeStar S50',
    model: 'SeeStar S50',
    shareName: 'EMMC Images',
    username: 'guest',
    shareHelp: {
      headline: 'Leave this as "EMMC Images".',
      body: 'SeeStar publishes its photo storage under that name with guest access.',
    },
    defaultHostname: '',
  },
  'seestar-s50-pro': {
    kind: 'seestar-s50-pro',
    label: 'ZWO SeeStar S50 Pro',
    model: 'SeeStar S50 Pro',
    shareName: 'EMMC Images',
    username: 'guest',
    shareHelp: {
      headline: 'Leave this as "EMMC Images".',
      body: 'SeeStar publishes its photo storage under that name with guest access.',
    },
    defaultHostname: '',
  },
  'seestar-s30': {
    kind: 'seestar-s30',
    label: 'ZWO SeeStar S30',
    model: 'SeeStar S30',
    shareName: 'EMMC Images',
    username: 'guest',
    shareHelp: {
      headline: 'Leave this as "EMMC Images".',
      body: 'SeeStar publishes its photo storage under that name with guest access.',
    },
    defaultHostname: '',
  },
  'seestar-s30-pro': {
    kind: 'seestar-s30-pro',
    label: 'ZWO SeeStar S30 Pro',
    model: 'SeeStar S30 Pro',
    shareName: 'EMMC Images',
    username: 'guest',
    shareHelp: {
      headline: 'Leave this as "EMMC Images".',
      body: 'SeeStar publishes its photo storage under that name with guest access.',
    },
    defaultHostname: '',
  },
  'dwarf-3': {
    kind: 'dwarf-3',
    label: 'DwarfLab Dwarf 3',
    model: 'Dwarf 3',
    shareName: '',
    username: 'anonymous',
    addressHelp: DWARF_ADDRESS_HELP,
    defaultHostname: DWARF_AP_HOST,
  },
  'dwarf-2': {
    kind: 'dwarf-2',
    label: 'DwarfLab Dwarf II',
    model: 'Dwarf II',
    shareName: '',
    username: 'anonymous',
    addressHelp: DWARF_ADDRESS_HELP,
    defaultHostname: DWARF_AP_HOST,
  },
  'dwarf-mini': {
    kind: 'dwarf-mini',
    label: 'DwarfLab Dwarf Mini',
    model: 'Dwarf Mini',
    shareName: '',
    username: 'anonymous',
    addressHelp: DWARF_ADDRESS_HELP,
    defaultHostname: DWARF_AP_HOST,
  },
  'asiair': {
    kind: 'asiair',
    label: 'ZWO ASIAIR (Beta)',
    model: 'ASIAIR',
    // ZWO uses the same share name on ASIAIR as on SeeStar.
    shareName: 'EMMC Images',
    username: 'guest',
    beta: true,
    shareHelp: {
      headline: 'Leave this as "EMMC Images".',
      body: 'ASIAIR publishes its storage under that name with guest access, read-only.',
      tips: [
        'ASIAIR has no FTP server. Use the share, or plug its USB stick into this machine.',
        'Frames import as sub-frames, since ASIAIR only stacks in Live mode.',
      ],
    },
    defaultHostname: '',
  },
  'other': {
    kind: 'other',
    label: 'Other (custom SMB share)',
    model: 'Custom',
    shareName: '',
    username: '',
    shareHelp: {
      headline: 'Enter the share name on its own.',
      body: 'Use "share/folder" to start inside a subfolder. Do not paste a full smb:// address.',
      tips: ['See "Generic SMB Layout" for the folder layout Nebulis expects.'],
    },
    defaultHostname: '',
  },
};

/** True for the DWARFLAB models, which share one transport story: FTP over
 *  Wi-Fi, or USB mass storage. Never SMB. */
export function isDwarfKind(kind: TelescopeKind): boolean {
  return kind === 'dwarf-2' || kind === 'dwarf-3' || kind === 'dwarf-mini';
}

/** True for ZWO SeeStar models. Keep in sync with server/lib/types/telescopeKind.ts. */
export function isSeestarKind(kind: TelescopeKind): boolean {
  return kind === 'seestar-s50' || kind === 'seestar-s50-pro'
    || kind === 'seestar-s30' || kind === 'seestar-s30-pro';
}

/** True for the ZWO ASIAIR controller, whose transport story is SMB over the
 *  network or its USB storage. Never FTP: the device runs no FTP server. Keep
 *  in sync with server/lib/types/telescopeKind.ts. */
export function isAsiairKind(kind: TelescopeKind): boolean {
  return kind === 'asiair';
}

/** What to call this device in a sentence. The `other` kind is a NAS or a PC
 *  sharing a folder, so calling it a telescope reads as nonsense to whoever
 *  chose that option. Mirrors deviceNoun in server/lib/deviceWording.ts, which
 *  words the connection errors; keep the two in step. */
export function deviceNoun(kind: TelescopeKind | null | undefined): string {
  return kind === 'other' ? 'server' : 'telescope';
}

/** Narrows a bare string (DOM select value, API payload) to a TelescopeKind.
 *  Mirrors isTelescopeKind in server/lib/types/telescopeKind.ts. */
export function isTelescopeKind(v: string): v is TelescopeKind {
  return isOneOf(TELESCOPE_KINDS, v);
}

/** Coerce a DOM select string to TelescopeKind. Unknown values fall back to 'other'. */
export function toTelescopeKind(v: string): TelescopeKind {
  return isTelescopeKind(v) ? v : 'other';
}

/** Default badge color for each telescope kind. The backend uses the same
 *  palette during boot backfill — keep them in sync. */
export const DEFAULT_COLOR_BY_KIND: Record<TelescopeKind, string> = {
  'seestar-s50':     '#3b82f6',
  'seestar-s50-pro': '#14b8a6',
  'seestar-s30':     '#10b981',
  'seestar-s30-pro': '#84cc16',
  'dwarf-3':         '#f59e0b',
  'dwarf-2':         '#ef4444',
  'dwarf-mini':      '#f97316',
  'asiair':          '#06b6d4',
  'other':           '#8b5cf6',
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

/** Reverse-lookup: given a stored profile's `model` field, infer which kind
 *  it was created from. Used by the edit modal to seed the dropdown. */
export function modelToKind(model: string): TelescopeKind {
  switch (model) {
    case 'SeeStar S50':     return 'seestar-s50';
    case 'SeeStar S50 Pro': return 'seestar-s50-pro';
    case 'SeeStar S30':     return 'seestar-s30';
    case 'SeeStar S30 Pro': return 'seestar-s30-pro';
    case 'Dwarf 3':         return 'dwarf-3';
    case 'Dwarf II':        return 'dwarf-2';
    case 'Dwarf Mini':      return 'dwarf-mini';
    case 'ASIAIR':          return 'asiair';
    default:                return 'other';
  }
}
