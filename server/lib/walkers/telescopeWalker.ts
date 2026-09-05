/**
 * SeeStar folder-layout convention.
 *
 * SeeStar S50/S30 publish their photos at:
 *   \\<host>\EMMC Images\MyWorks\<Object>\...flat files...
 *   \\<host>\EMMC Images\MyWorks\<Object>_sub\...sub-frames...
 *
 * `import.ts` does its own discovery/listing via `smbListDir`, rooted at
 * `getTelescopeConfig().basePath`; this module only supplies that base path
 * and the file-path builder shared by every caller that needs one.
 */
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
