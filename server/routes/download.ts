/**
 * Download routes — all data read from local library only.
 * No SMB calls. Files must be imported first.
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { getLibraryDir } from '../lib/libraryPath.js';
import { getFileCategory, isRealFile, parseFilename } from '../lib/telescopeFiles.js';
import { getObjectFolderName } from '../lib/localLibrary.js';
import { queryString } from '../lib/queryHelpers.js';

const router = Router();

// Download an object's files as ZIP (from local library)
router.get('/objects/:objectId', (req: Request, res: Response) => {
  try {
    const LIBRARY_DIR = getLibraryDir();
    const objectId = String(req.params.objectId);
    const fileType = queryString(req.query.fileType); // image, fits, all
    const sessionDate = queryString(req.query.date);

    const objDir = path.join(LIBRARY_DIR, getObjectFolderName(objectId));
    if (!fs.existsSync(objDir)) {
      res.apiError(404, 'NOT_FOUND', 'Object not found in local library. Run an import first.');
      return;
    }

    let files = fs.readdirSync(objDir)
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
    res.set('Content-Disposition', `attachment; filename="${zipName}"`);

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
