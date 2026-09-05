/**
 * Per-vendor folder walker dispatch.
 *
 * Each telescope kind has a (transport, folder-layout) pair. The transport is
 * dispatched inside smb.ts based on profile.connectionType. The folder layout
 * lives here — one walker per known convention.
 */
import type { TelescopeKind } from '../telescopes.js';
import { isDwarfKind } from '../types/telescopeKind.js';
import { getTelescopeConfig, type WalkerConfig } from './telescopeWalker.js';
import { getDwarfWalkerConfig } from './dwarfWalker.js';

export { isDwarfKind };

export type { DiscoveredObject, WalkerConfig } from './telescopeWalker.js';
export { buildObjectFilePath } from './telescopeWalker.js';
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
export {
  discoverGenericObjects,
  listGenericObjectFiles,
  buildGenericFilePath,
  isGenericSessionFolder,
  GENERIC_BASE_PATH,
} from './genericWalker.js';
export type { GenericDiscoveredObject } from './genericWalker.js';
export {
  discoverAsiairObjects,
  listAsiairObjectFiles,
  buildAsiairFilePath,
  asiairLocalName,
  resolveAsiairRoot,
  ASIAIR_CALIBRATION_PATHS,
  ASIAIR_MODE_FOLDERS,
  ASIAIR_LIVE_FOLDER,
} from './asiairWalker.js';
export type { AsiairDiscoveredObject } from './asiairWalker.js';

export function getWalkerConfig(kind: TelescopeKind): WalkerConfig {
  switch (kind) {
    case 'seestar-s50':
    case 'seestar-s50-pro':
    case 'seestar-s30':
    case 'seestar-s30-pro':
      return getTelescopeConfig();
    case 'dwarf-3':
    case 'dwarf-2':
    case 'dwarf-mini':
      return getDwarfWalkerConfig();
    case 'asiair':
      // ASIAIR's capture-mode folders sit at the storage root, but the tree may
      // be one level down under `ASIAir/` on removable media. That is resolved
      // per run by resolveAsiairRoot rather than fixed here, since one profile
      // hits both cases across its SMB and USB transports.
      return { basePath: '' };
    case 'other':
      // Generic SMB share: object folders at the share root.
      return { basePath: '' };
  }
}
