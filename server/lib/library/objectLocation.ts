/**
 * Library — "where do these files actually live" resolution.
 *
 * Powers the object and session "Show file location" panels: the absolute path
 * on disk (or the network share) for an object folder or one session's folder.
 *
 * Paths are for a person to copy into a file manager or terminal. Nothing here
 * reads or writes files beyond an existence check.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getLibraryDir, isNetworkLocation, getLibraryLocationInfo } from '../libraryPath.js';
import { getFolderName } from './objects.js';
import { getLocalFiles } from './observations.js';

export interface DiskLocation {
  /** '<folder>' or '<folder>/<session subdir>', relative to the library root. */
  relPath: string;
  /** Absolute path a file manager / terminal opens. */
  path: string;
  exists: boolean;
}

export interface ObjectLocation {
  storage: 'local' | 'network';
  /** Absolute library root. Network locations show the UNC / mount path here. */
  libraryRoot: string;
  /** The object folder itself. */
  object: DiskLocation;
  /** One session's folder, when a date is given and it could be resolved. */
  session: DiskLocation | null;
}

/** Directory portion of a relative file path, '' for a file at the folder root. */
function dirOf(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}

/** The session's own subdirectory under the object folder, or '' when the
 *  session's files sit directly in the object folder (the flat SeeStar case). */
function sessionSubdir(objectId: string, date: string): string {
  const files = getLocalFiles(objectId, date).filter(f => !f.isThumbnail);
  if (files.length === 0) return '';
  const dirs = new Set(files.map(f => dirOf(f.path)));
  // f.path is '<folder>/<rest>'; strip the leading folder segment.
  const folderName = getFolderName(objectId);
  const rels = [...dirs].map(d =>
    d === folderName ? '' : d.startsWith(folderName + '/') ? d.slice(folderName.length + 1) : d,
  );
  // Use the shared prefix so a session split across sub-subdirs still resolves
  // to the directory that contains them all.
  return rels.reduce((a, b) => {
    if (a === '' || b === '') return '';
    const as = a.split('/');
    const bs = b.split('/');
    const out: string[] = [];
    for (let i = 0; i < Math.min(as.length, bs.length); i++) {
      if (as[i] !== bs[i]) break;
      out.push(as[i]);
    }
    return out.join('/');
  });
}

function diskLocation(relPath: string): DiskLocation {
  const abs = path.join(getLibraryDir(), relPath);
  let exists = false;
  try {
    exists = fs.existsSync(abs);
  } catch {
    exists = false;
  }
  return { relPath, path: abs, exists };
}

export async function getObjectLocation(objectId: string, date?: string): Promise<ObjectLocation> {
  const folderName = getFolderName(objectId);
  const object = diskLocation(folderName);

  let session: DiskLocation | null = null;
  if (date) {
    const sub = sessionSubdir(objectId, date);
    session = diskLocation(sub ? `${folderName}/${sub}` : folderName);
  }

  let networkRoot: string | null = null;
  if (isNetworkLocation()) {
    const { host, share, subpath } = (await getLibraryLocationInfo()).network;
    if (host) {
      networkRoot = `\\\\${host}\\${share}${subpath ? `\\${subpath.replace(/^[\\/]+/, '')}` : ''}`;
    }
  }

  return {
    storage: isNetworkLocation() ? 'network' : 'local',
    libraryRoot: networkRoot ?? getLibraryDir(),
    object,
    session,
  };
}
