/**
 * Per-vendor folder walker dispatch.
 *
 * Each telescope kind has a (transport, folder-layout) pair. The transport is
 * dispatched inside smb.ts based on profile.connectionType. The folder layout
 * lives here — one walker per known convention.
 */
import type { TelescopeKind } from '../telescopes.js';
import { getTelescopeConfig, type WalkerConfig } from './telescopeWalker.js';
import { getDwarfWalkerConfig } from './dwarfWalker.js';

export type { DiscoveredObject, WalkerConfig } from './telescopeWalker.js';
export { discoverObjects, listObjectFiles, buildObjectFilePath } from './telescopeWalker.js';
export {
  discoverDwarfObjects,
  listDwarfObjectFiles,
  buildDwarfFilePath,
  isDwarfSessionFolder,
  extractTargetFromSessionFolder,
  extractDateFromSessionFolder,
  extractTimestampFromSessionFolder,
  DWARF_BASE_PATH,
} from './dwarfWalker.js';
export type { DwarfDiscoveredObject } from './dwarfWalker.js';

export function getWalkerConfig(kind: TelescopeKind): WalkerConfig {
  switch (kind) {
    case 'seestar-s50':
    case 'seestar-s30':
      return getTelescopeConfig();
    case 'dwarf-3':
    case 'dwarf-2':
    case 'dwarf-mini':
      return getDwarfWalkerConfig();
    case 'other':
      // Generic SMB share: object folders at the share root.
      return { basePath: '' };
  }
}

/** True when this kind uses Dwarf's session-folder layout (vs SeeStar's object-folder). */
export function isDwarfKind(kind: TelescopeKind): boolean {
  return kind === 'dwarf-2' || kind === 'dwarf-3' || kind === 'dwarf-mini';
}
