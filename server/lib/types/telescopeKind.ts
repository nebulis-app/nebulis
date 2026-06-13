export const TELESCOPE_KINDS = ['seestar-s50', 'seestar-s30', 'dwarf-3', 'dwarf-2', 'dwarf-mini', 'other'] as const;
export type TelescopeKind = typeof TELESCOPE_KINDS[number];
