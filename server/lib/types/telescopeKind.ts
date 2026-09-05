export const TELESCOPE_KINDS = ['seestar-s50', 'seestar-s50-pro', 'seestar-s30', 'seestar-s30-pro', 'dwarf-3', 'dwarf-2', 'dwarf-mini', 'asiair', 'other'] as const;
export type TelescopeKind = typeof TELESCOPE_KINDS[number];

/** Narrows an arbitrary string (DB column, query param, request body) to a
 *  TelescopeKind. Same shape as isTransportKind in telescopeTransports.ts, so
 *  every "is this a known kind?" check narrows instead of casting. Mirrored on
 *  the frontend at src/lib/telescopePresets.ts. */
export function isTelescopeKind(value: string): value is TelescopeKind {
  return (TELESCOPE_KINDS as readonly string[]).includes(value);
}

/** True when this kind uses Dwarf's session-folder layout (vs SeeStar's object-folder)
 *  and its FTP-only transport. Single source of truth: also re-exported from
 *  walkers/index.ts for existing callers, and mirrored on the frontend at
 *  src/lib/telescopePresets.ts (the two sides can't share a source without a
 *  monorepo — keep them in sync). */
export function isDwarfKind(kind: TelescopeKind): boolean {
  return kind === 'dwarf-2' || kind === 'dwarf-3' || kind === 'dwarf-mini';
}

/** True for ZWO SeeStar kinds. Mirrored on the frontend at
 *  src/lib/telescopePresets.ts — see the note on isDwarfKind above. */
export function isSeestarKind(kind: TelescopeKind): boolean {
  return kind === 'seestar-s50' || kind === 'seestar-s50-pro'
    || kind === 'seestar-s30' || kind === 'seestar-s30-pro';
}

/** True for the ZWO ASIAIR controller. Beta: the layout this implies is built
 *  from ZWO's transfer guide and community tooling, not from a device on the
 *  bench (see walkers/asiairWalker.ts). Unlike SeeStar it is a controller, not
 *  a fixed optic, so its rig varies per user. Mirrored on the frontend at
 *  src/lib/telescopePresets.ts — see the note on isDwarfKind above. */
export function isAsiairKind(kind: TelescopeKind): boolean {
  return kind === 'asiair';
}

/** Default badge color per kind. Used both when creating a new profile
 *  (telescopes.ts) and by db.ts's one-shot boot backfill for existing rows —
 *  dependency-free so both can import it without a cycle. Mirrored on the
 *  frontend at src/lib/telescopePresets.ts's DEFAULT_COLOR_BY_KIND. */
export const COLOR_BY_KIND: Record<TelescopeKind, string> = {
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

/** Infers a TelescopeKind from the free-text `model` field stored on a
 *  profile row. Used both for new profiles and by db.ts's boot backfill. */
export function kindFromModel(model: string): TelescopeKind {
  switch (model) {
    case 'SeeStar S50':     return 'seestar-s50';
    case 'SeeStar S50 Pro': return 'seestar-s50-pro';
    case 'SeeStar S30':     return 'seestar-s30';
    case 'SeeStar S30 Pro': return 'seestar-s30-pro';
    case 'Dwarf 3':         return 'dwarf-3';
    case 'Dwarf II':        return 'dwarf-2';
    case 'Dwarf Mini':      return 'dwarf-mini';
    // One kind covers ASIAIR, Pro, Plus, Mini and Plus 2: the on-disk layout is
    // identical across them, so splitting per model would only duplicate rows in
    // every exhaustive Record<TelescopeKind, ...> for no behavioral gain.
    case 'ASIAIR':          return 'asiair';
    default:                return 'other';
  }
}
