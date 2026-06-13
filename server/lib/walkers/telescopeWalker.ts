/**
 * SeeStar folder walker.
 *
 * SeeStar S50/S30 publish their photos at:
 *   \\<host>\EMMC Images\MyWorks\<Object>\...flat files...
 *   \\<host>\EMMC Images\MyWorks\<Object>_sub\...sub-frames...
 *
 * This walker is shared with Dwarf (assumed to match SeeStar's object-folder
 * convention until a real Dwarf 3 share is verified) and is the v1 default
 * for `other`. The "Generic SMB Layout" documented in the Add Telescope modal
 * (session subfolders + lights/subframes) is not yet implemented — write a
 * second walker when a non-SeeStar share is on hand to test against.
 */
import { smbListDir, type SmbEntry } from '../smb.js';
import { debugLog } from '../debugLogger.js';
import { isObjectFolder, isSubFolder, getObjectFromSubFolder } from '../telescopeFiles.js';
import type { TelescopeProfile } from '../telescopes.js';

/** Subfolder inside the share where the telescope actually writes files.
 *  SeeStar nests everything under "MyWorks"; other vendors typically use the
 *  share root. Override per kind in walkers/index.ts if needed. */
export interface WalkerConfig {
  /** Path inside the SMB share where object folders live ('' = share root). */
  basePath: string;
}

export interface DiscoveredObject {
  /** Raw SMB folder name as it appears on the share, e.g. "M 42" or "M42". */
  folderName: string;
  /** Companion sub-frame folder, when one exists ("M 42_sub"). */
  subFolderName: string | null;
}

const DEFAULT_CONFIG: WalkerConfig = { basePath: 'MyWorks' };

export function getTelescopeConfig(): WalkerConfig {
  return DEFAULT_CONFIG;
}

/** List object folders + their `_sub` companions for one telescope. */
export async function discoverObjects(
  profile: TelescopeProfile,
  config: WalkerConfig,
): Promise<DiscoveredObject[]> {
  debugLog('walker:seestar', `Listing ${config.basePath || '(root)'} for object folders`);
  const entries = await smbListDir(config.basePath, profile);
  const allDirs = entries.filter(e => e.type === 'dir');
  debugLog('walker:seestar', `Found ${allDirs.length} dir(s) under ${config.basePath || '(root)'}`);
  const objectDirs = allDirs.filter(e => isObjectFolder(e.name));
  const subDirs = allDirs.filter(e => isSubFolder(e.name));
  debugLog('walker:seestar', `${objectDirs.length} object folder(s): ${objectDirs.map(d => d.name).join(', ') || '(none)'}`);
  if (subDirs.length > 0) debugLog('walker:seestar', `${subDirs.length} sub-folder(s): ${subDirs.map(d => d.name).join(', ')}`);

  return objectDirs.map(obj => ({
    folderName: obj.name,
    subFolderName: subDirs.find(s => getObjectFromSubFolder(s.name) === obj.name)?.name ?? null,
  }));
}

/** List files for one object (and optionally its `_sub` companion). */
export async function listObjectFiles(
  profile: TelescopeProfile,
  config: WalkerConfig,
  object: DiscoveredObject,
): Promise<{ files: SmbEntry[]; subFiles: SmbEntry[] }> {
  const objectPath = config.basePath ? `${config.basePath}/${object.folderName}` : object.folderName;
  debugLog('walker:seestar', `Listing files for object "${object.folderName}" at ${objectPath}`);
  let files: SmbEntry[] = [];
  try {
    const entries = await smbListDir(objectPath, profile);
    files = entries.filter(e => e.type === 'file');
    debugLog('walker:seestar', `"${object.folderName}": ${files.length} file(s)`);
  } catch {
    debugLog('walker:seestar', `Failed to list ${objectPath} — skipping`);
  }

  let subFiles: SmbEntry[] = [];
  if (object.subFolderName) {
    const subPath = config.basePath ? `${config.basePath}/${object.subFolderName}` : object.subFolderName;
    debugLog('walker:seestar', `Listing sub-files for "${object.folderName}" at ${subPath}`);
    try {
      const entries = await smbListDir(subPath, profile);
      subFiles = entries.filter(e => e.type === 'file');
      debugLog('walker:seestar', `"${object.folderName}": ${subFiles.length} sub-file(s)`);
    } catch {
      debugLog('walker:seestar', `Failed to list sub-folder ${subPath} — skipping`);
    }
  }
  return { files, subFiles };
}

/** Build the absolute SMB path for one file inside an object's folder. */
export function buildObjectFilePath(
  config: WalkerConfig,
  object: Pick<DiscoveredObject, 'folderName' | 'subFolderName'>,
  fileName: string,
  fromSub: boolean,
): string {
  const folder = fromSub ? object.subFolderName ?? object.folderName : object.folderName;
  return config.basePath ? `${config.basePath}/${folder}/${fileName}` : `${folder}/${fileName}`;
}
