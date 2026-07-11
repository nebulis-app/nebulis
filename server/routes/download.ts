/**
 * Download routes — all data read from local library only.
 * No SMB calls. Files must be imported first.
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { getLibraryDir, isLibraryAvailable, withTimeout, LIBRARY_IO_TIMEOUT_MS } from '../lib/libraryPath.js';
import { isLibraryMigrating } from '../lib/libraryMaintenance.js';
import { getFileCategory, isRealFile, parseFilename } from '../lib/telescopeFiles.js';
import { getObjectFolderName } from '../lib/localLibrary.js';
import { queryString, contentDispositionHeader } from '../lib/queryHelpers.js';

const router = Router();

// Download an object's files as ZIP (from local library)
router.get('/objects/:objectId', async (req: Request, res: Response) => {
  try {
    // The library may live on a network share; a stale mount would hang the fs
    // calls below and freeze the whole event loop. This route is on the
    // auth-bypass list, so an unauthenticated request must not be able to. Gate
    // on availability first (timeout-bounded), then use bounded async fs.
    if (isLibraryMigrating()) {
      res.apiError(503, 'LIBRARY_MIGRATING', 'The library is being moved to a new location. Try again once the move finishes.');
      return;
    }
    if (!(await isLibraryAvailable())) {
      res.apiError(503, 'LIBRARY_UNAVAILABLE', 'Your library drive is not connected. Reconnect it and try again.');
      return;
    }
    const LIBRARY_DIR = getLibraryDir();
    const objectId = String(req.params.objectId);
    const fileType = queryString(req.query.fileType); // image, fits, all
    const sessionDate = queryString(req.query.date);

    // Resolve and contain — getObjectFolderName falls back to the raw objectId
    // on a DB miss, so a crafted objectId with traversal tokens would escape
    // LIBRARY_DIR. Mirror the guard used in library.ts:1164/1201.
    const objDir = path.resolve(LIBRARY_DIR, getObjectFolderName(objectId));
    if (!objDir.startsWith(LIBRARY_DIR + path.sep)) {
      res.apiError(400, 'INVALID_OBJECT_ID', 'Object id resolves outside the library');
      return;
    }
    try {
      await withTimeout(fs.promises.access(objDir), LIBRARY_IO_TIMEOUT_MS);
    } catch {
      res.apiError(404, 'NOT_FOUND', 'Object not found in local library. Run an import first.');
      return;
    }

    let files = (await withTimeout(fs.promises.readdir(objDir), LIBRARY_IO_TIMEOUT_MS))
      .filter(f => isRealFile(f) && !f.toLowerCase().includes('_thn.'));

    // Filter by type
    if (fileType && fileType !== 'all') {
      files = files.filter(f => getFileCategory(f) === fileType);
    }

    // Filter by date
    if (sessionDate) {
      files = files.filter(f => {
        const parsed = parseFilename(f);
        return parsed.date === sessionDate;
      });
    }

    if (files.length === 0) {
      res.apiError(404, 'NO_FILES', 'No files match the filter criteria');
      return;
    }

    // Stream ZIP
    const zipName = `${objectId}${sessionDate ? `_${sessionDate}` : ''}.zip`;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', contentDispositionHeader('attachment', zipName));

    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', (err: Error) => {
      if (!res.headersSent) {
        res.apiError(500, 'ARCHIVE_ERROR', err.message);
      }
    });
    archive.pipe(res);

    // Add files from local library
    for (const fname of files) {
      const fullPath = path.join(objDir, fname);
      archive.file(fullPath, { name: `${objectId}/${fname}` });
    }

    archive.finalize();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Download failed';
    if (!res.headersSent) {
      res.apiError(500, 'DOWNLOAD_FAILED', message);
    }
  }
});

export { router as downloadRouter };
