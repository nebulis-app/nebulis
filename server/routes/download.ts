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
import { getFileCategory, isRealFile } from '../lib/telescopeFiles.js';
import { getObjectFolderName } from '../lib/localLibrary.js';
import { getProcessedImages, getAllProcessedImagesForObject } from '../lib/library/processed.js';
import { listObjectFiles, getObjectLayout } from '../lib/library/libraryLayout.js';
import { resolverFor } from '../lib/library/libraryFiles.js';
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

    // Layout-aware: a nested object keeps its files one level down, inside a
    // per-session directory. A flat readdir here would silently export an empty
    // archive for every nested object.
    let files = listObjectFiles(objDir, getObjectLayout(objectId))
      .filter(e => isRealFile(e.fileName) && !e.fileName.toLowerCase().includes('_thn.'));

    // Filter by type
    if (fileType && fileType !== 'all') {
      files = files.filter(e => getFileCategory(e.fileName) === fileType);
    }

    // Filter by date. Uses the recorded session rather than re-parsing the
    // filename, because a nested import keeps the device's own names and those
    // carry no date at all.
    if (sessionDate) {
      const identity = resolverFor(objectId);
      files = files.filter(e => identity.session(e.relPath) === sessionDate);
    }

    // Processed images live in a `processed/` subdirectory and were previously
    // absent from the archive entirely, because the listing above is a
    // non-recursive readdir. That made it impossible to get your own
    // post-processing work back out of Nebulis in one action.
    //
    // Taken from the DB rather than by walking the directory, for two reasons:
    // the records carry the session each image belongs to (a processed
    // filename is arbitrary, so the filename-based date filter above cannot
    // work on them), and they are not constrained to `isRealFile`'s image
    // extensions, so formats we store without rendering still come along.
    //
    // Only included in an unfiltered export: a "FITS only" or "images only"
    // request is asking for telescope output, not derived work.
    const includeProcessed = !fileType || fileType === 'all';
    const processed = includeProcessed
      ? (sessionDate
          ? getProcessedImages(objectId, sessionDate)
          : getAllProcessedImagesForObject(objectId))
      : [];

    if (files.length === 0 && processed.length === 0) {
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

    // Add files from local library. The object-relative path is preserved
    // inside the archive, so an extracted nested object mirrors the library
    // (and therefore the telescope's own) directory structure.
    for (const entry of files) {
      const fullPath = path.join(objDir, entry.relPath);
      archive.file(fullPath, { name: `${objectId}/${entry.relPath}` });
    }

    // Processed images keep their `processed/` prefix inside the archive so the
    // extracted tree mirrors the library layout. A DB row whose file is missing
    // is skipped rather than handed to archiver, which would abort the whole
    // stream mid-download for one absent file.
    for (const record of processed) {
      const fullPath = path.join(objDir, 'processed', record.filename);
      if (!fs.existsSync(fullPath)) {
        console.warn(`[download] Skipping missing processed image: ${record.filename}`);
        continue;
      }
      archive.file(fullPath, { name: `${objectId}/processed/${record.filename}` });
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
