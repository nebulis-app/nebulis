import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { getCatalogEntry } from '../data/catalog.js';
import { parsePagination, paginate } from '../middleware/pagination.js';
import { getLibraryDir } from '../lib/libraryPath.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  parseFilename,
  normalizeCatalogId,
  isRealFile,
  isObjectFolder,
  isSubFolder,
  getFileCategory,
  sessionNightFor,
} from '../lib/telescopeFiles.js';
import { cachedSmbListDir, BASE_PATH } from '../lib/smbCache.js';
import { pickDefaultTarget } from '../lib/telescopes.js';
import { queryString, contentDispositionHeader } from '../lib/queryHelpers.js';
import {
  getLocalObjects,
  getLocalSessions,
  getLocalFiles,
  getLocalThumbnail,
  deleteLocalFile,
  getObjectFolderName,
} from '../lib/localLibrary.js';

const router = Router();

// ─── Test connection (only route that touches SMB) ──────────────────

router.get('/test', async (_req: Request, res: Response) => {
  try {
    const entries = await cachedSmbListDir(BASE_PATH, pickDefaultTarget());
    const objectFolders = entries.filter(e => e.type === 'dir' && isObjectFolder(e.name));
    const subFolders = entries.filter(e => e.type === 'dir' && isSubFolder(e.name));

    res.apiSuccess({
      connected: true,
      basePath: BASE_PATH,
      objectCount: objectFolders.length,
      subFolderCount: subFolders.length,
      objects: objectFolders.map(e => e.name),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    res.apiError(502, 'CONNECTION_FAILED', message);
  }
});

// ─── List objects (from local library) ──────────────────────────────

router.get('/objects', (req: Request, res: Response) => {
  try {
    let objects = getLocalObjects();

    const typeFilter = queryString(req.query.type);
    const search = (queryString(req.query.search) ?? '').toLowerCase();

    if (typeFilter) {
      objects = objects.filter(o => o.type.toLowerCase().includes(typeFilter.toLowerCase()));
    }
    if (search) {
      objects = objects.filter(o =>
        o.name.toLowerCase().includes(search) ||
        o.catalogId.toLowerCase().includes(search) ||
        o.folderName.toLowerCase().includes(search) ||
        o.constellation.toLowerCase().includes(search)
      );
    }

    const pagination = parsePagination(req);
    const result = paginate(objects, pagination);
    res.apiSuccess(result.items, { pagination: result.pagination });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to list objects';
    res.apiError(500, 'LIST_FAILED', message);
  }
});

// ─── Get single object detail (from local library) ──────────────────

router.get('/objects/:objectId', (req: Request, res: Response) => {
  try {
    const LIBRARY_DIR = getLibraryDir();
    const objectId = String(req.params.objectId);
    const folderName = getObjectFolderName(objectId);
    const objDir = path.join(LIBRARY_DIR, folderName);

    if (!fs.existsSync(objDir)) {
      res.apiError(404, 'NOT_FOUND', 'Object not found in local library. Run a sync to import it.');
      return;
    }

    const normalized = normalizeCatalogId(objectId);
    const catalogEntry = getCatalogEntry(normalized) || getCatalogEntry(objectId);

    const files = fs.readdirSync(objDir).filter(isRealFile);
    const sessions = new Map<string, { count: number; latestTimestamp: string }>();

    for (const fname of files) {
      const parsed = parseFilename(fname);
      if (parsed.isThumbnail) continue;
      const key = sessionNightFor(parsed) || 'unknown';
      const existing = sessions.get(key);
      if (!existing) {
        sessions.set(key, { count: 1, latestTimestamp: parsed.timestamp || '' });
      } else {
        existing.count++;
        if (parsed.timestamp && parsed.timestamp > existing.latestTimestamp) {
          existing.latestTimestamp = parsed.timestamp;
        }
      }
    }

    const stackedCount = files.filter(f => parseFilename(f).type === 'stacked').length;

    // Check for local sub folder
    let subFrameCount = 0;
    for (const suffix of ['_sub', '_subs']) {
      const subDir = path.join(LIBRARY_DIR, `${folderName}${suffix}`);
      if (fs.existsSync(subDir)) {
        subFrameCount = fs.readdirSync(subDir).filter(f => isRealFile(f) && !f.toLowerCase().includes('_thn.')).length;
        break;
      }
    }

    res.apiSuccess({
      id: objectId,
      catalogId: normalized,
      folderName,
      name: catalogEntry?.name || objectId,
      type: catalogEntry?.type || 'Unknown',
      constellation: catalogEntry?.constellation || 'Unknown',
      description: catalogEntry?.description || '',
      magnitude: catalogEntry?.magnitude || null,
      ra: catalogEntry?.ra || null,
      dec: catalogEntry?.dec || null,
      sessionCount: sessions.size,
      sessions: Array.from(sessions.entries()).map(([date, info]) => ({
        date,
        fileCount: info.count,
      })),
      totalFiles: files.length,
      stackedImageCount: stackedCount,
      subFrameCount,
      hasSubFrames: subFrameCount > 0,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to get object';
    res.apiError(500, 'FETCH_FAILED', message);
  }
});

// ─── Object thumbnail (from local library) ──────────────────────────

router.get('/objects/:objectId/thumbnail', (req: Request, res: Response) => {
  const objectId = String(req.params.objectId);
  const data = getLocalThumbnail(objectId);

  if (!data) {
    res.apiError(404, 'NO_THUMBNAIL', 'No thumbnail found in local library. Run a sync first.');
    return;
  }

  const wantsBase64 = req.query.format === 'base64';
  if (wantsBase64) {
    res.apiSuccess({ base64: data.toString('base64'), mimeType: 'image/jpeg', filename: `${objectId}_thumb.jpg` });
  } else {
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(data);
  }
});

// ─── List sessions (from local library) ─────────────────────────────

router.get('/objects/:objectId/sessions', (req: Request, res: Response) => {
  try {
    const objectId = String(req.params.objectId);
    const sessions = getLocalSessions(objectId);
    const pagination = parsePagination(req);
    const result = paginate(sessions, pagination);
    res.apiSuccess(result.items, { pagination: result.pagination });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to list sessions';
    res.apiError(500, 'LIST_FAILED', message);
  }
});

// ─── List files in a session (from local library) ────────────────────

router.get('/objects/:objectId/sessions/:sessionDate/files', (req: Request, res: Response) => {
  try {
    const objectId = String(req.params.objectId);
    const sessionDate = String(req.params.sessionDate);
    const fileTypeFilter = queryString(req.query.fileType);

    let files = getLocalFiles(objectId, sessionDate === 'all' ? undefined : sessionDate);

    if (req.query.includeThumbnails !== 'true') {
      files = files.filter(f => !f.isThumbnail);
    }
    if (fileTypeFilter) {
      files = files.filter(f => f.type === fileTypeFilter);
    }

    const pagination = parsePagination(req, 100);
    const result = paginate(files, pagination);

    const summary = {
      totalFiles: files.length,
      imageCount: files.filter(f => f.type === 'image').length,
      fitsCount: files.filter(f => f.type === 'fits').length,
      stackedCount: files.filter(f => f.fileType === 'stacked').length,
    };

    res.apiSuccess(result.items, { pagination: result.pagination, summary });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to list files';
    res.apiError(500, 'LIST_FAILED', message);
  }
});

// ─── List all files for an object (from local library) ───────────────

router.get('/objects/:objectId/files', (req: Request, res: Response) => {
  try {
    const objectId = String(req.params.objectId);
    const fileTypeFilter = queryString(req.query.fileType);

    let files = getLocalFiles(objectId);

    if (req.query.includeThumbnails !== 'true') {
      files = files.filter(f => !f.isThumbnail);
    }
    if (fileTypeFilter) {
      files = files.filter(f => f.type === fileTypeFilter);
    }

    const pagination = parsePagination(req, 100);
    const result = paginate(files, pagination);
    res.apiSuccess(result.items, { pagination: result.pagination });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to list files';
    res.apiError(500, 'LIST_FAILED', message);
  }
});

// ─── List sub-frames (from local library) ───────────────────────────

router.get('/objects/:objectId/subs', (req: Request, res: Response) => {
  try {
    const LIBRARY_DIR = getLibraryDir();
    const objectId = String(req.params.objectId);
    const fileTypeFilter = queryString(req.query.fileType);
    const sessionDate = queryString(req.query.date);

    // Find the local sub folder
    const subFolderName = getObjectFolderName(objectId);
    let subDir: string | null = null;
    for (const suffix of ['_sub', '_subs']) {
      const candidate = path.join(LIBRARY_DIR, `${subFolderName}${suffix}`);
      if (fs.existsSync(candidate)) { subDir = candidate; break; }
    }

    if (!subDir) {
      res.apiSuccess([], { pagination: { page: 1, limit: 100, total: 0, pages: 0 }, summary: { totalSubFrames: 0, fitsCount: 0, jpgCount: 0, sessionDates: [] } });
      return;
    }

    const files = fs.readdirSync(subDir)
      .filter(isRealFile)
      .map(fname => {
        const parsed = parseFilename(fname);
        const fullPath = path.join(subDir!, fname);
        const stat = fs.statSync(fullPath);
        const category = getFileCategory(fname);
        return {
          name: fname,
          size: stat.size,
          type: category as 'image' | 'fits' | 'video' | 'thumbnail' | 'other',
          fileType: parsed.type as 'stacked' | 'sub' | 'thumbnail' | 'video' | 'other',
          subIndex: parsed.subIndex || null,
          path: `${objectId}/${fname}`,
          exposure: parsed.exposure || null,
          filter: parsed.filter || null,
          timestamp: parsed.timestamp || null,
          date: parsed.date || null,
          isThumbnail: parsed.isThumbnail,
          downloadUrl: `/api/v1/telescope/files?path=${encodeURIComponent(`${BASE_PATH}/${objectId}/${fname}`)}`,
        };
      })
      .filter(f => !f.isThumbnail)
      .filter(f => !fileTypeFilter || f.type === fileTypeFilter)
      .filter(f => !sessionDate || sessionNightFor(parseFilename(f.name)) === sessionDate);

    const pagination = parsePagination(req, 100);
    const result = paginate(files, pagination);

    const dateGroups = new Map<string, number>();
    for (const f of files) {
      const d = sessionNightFor(parseFilename(f.name)) || 'unknown';
      dateGroups.set(d, (dateGroups.get(d) || 0) + 1);
    }

    res.apiSuccess(result.items, {
      pagination: result.pagination,
      summary: {
        totalSubFrames: files.length,
        fitsCount: files.filter(f => f.type === 'fits').length,
        jpgCount: files.filter(f => f.type === 'image').length,
        sessionDates: Array.from(dateGroups.entries()).map(([date, count]) => ({ date, count })),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to list sub-frames';
    res.apiError(500, 'LIST_FAILED', message);
  }
});

// ─── Get a specific file (from local library) ────────────────────────

router.get('/files', async (req: Request, res: Response) => {
  try {
    const LIBRARY_DIR = getLibraryDir();
    const filePath = String(req.query.path || '');
    if (!filePath) {
      res.apiError(400, 'MISSING_PATH', 'Query parameter "path" is required');
      return;
    }
    if (!filePath.startsWith(BASE_PATH) || filePath.includes('..')) {
      res.apiError(403, 'FORBIDDEN', 'Invalid file path');
      return;
    }
    if (!isRealFile(path.basename(filePath))) {
      res.apiError(400, 'INVALID_FILE', 'Not a real image file');
      return;
    }

    const relative = filePath.slice(BASE_PATH.length + 1); // strip "MyWorks/"
    const localPath = path.join(LIBRARY_DIR, relative);
    if (!fs.existsSync(localPath)) {
      res.apiError(404, 'NOT_FOUND', 'File not found in local library. Run an import to sync it from the telescope.');
      return;
    }

    const data = fs.readFileSync(localPath);
    const ext = path.extname(filePath).toLowerCase();
    const wantsBase64 = req.query.format === 'base64';

    if (wantsBase64) {
      res.apiSuccess({
        base64: data.toString('base64'),
        mimeType: getMimeType(ext),
        filename: path.basename(filePath),
        size: data.length,
      });
    } else {
      res.set('Content-Type', getMimeType(ext));
      res.set('Cache-Control', 'public, max-age=3600');
      res.set('Content-Disposition', contentDispositionHeader('inline', path.basename(filePath)));
      res.send(data);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to get file';
    res.apiError(500, 'FETCH_FAILED', message);
  }
});

// ─── Delete a file (from local library) ─────────────────────────────

router.delete('/files', requireAdmin, (req: Request, res: Response) => {
  try {
    const filePath = String(req.query.path || '');
    if (!filePath) {
      res.apiError(400, 'MISSING_PATH', 'Query parameter "path" is required');
      return;
    }
    if (!filePath.startsWith(BASE_PATH) || filePath.includes('..')) {
      res.apiError(403, 'FORBIDDEN', 'Invalid file path');
      return;
    }

    const relative = filePath.slice(BASE_PATH.length + 1);
    deleteLocalFile(relative);
    res.apiSuccess({ deleted: true, path: filePath });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to delete file';
    res.apiError(500, 'DELETE_FAILED', message);
  }
});

// ─── Legacy compat endpoints (for web frontend) ─────────────────────

router.get('/file', (req: Request, res: Response) => {
  const LIBRARY_DIR = getLibraryDir();
  const filePath = String(req.query.path || '');
  if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
  if (!filePath.startsWith(BASE_PATH) || filePath.includes('..')) {
    res.status(403).json({ error: 'Invalid path' }); return;
  }
  if (!isRealFile(path.basename(filePath))) {
    res.status(400).json({ error: 'Not a real image file' }); return;
  }
  const relative = filePath.slice(BASE_PATH.length + 1);
  const localPath = path.join(LIBRARY_DIR, relative);
  if (!fs.existsSync(localPath)) {
    res.status(404).json({ error: 'File not found in local library' });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.set('Content-Type', getMimeType(ext));
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(localPath);
});

router.delete('/file', requireAdmin, (req: Request, res: Response) => {
  try {
    const filePath = String(req.query.path || '');
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
    if (!filePath.startsWith(BASE_PATH) || filePath.includes('..')) {
      res.status(403).json({ error: 'Invalid path' }); return;
    }
    const relative = filePath.slice(BASE_PATH.length + 1);
    deleteLocalFile(relative);
    res.json({ deleted: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to delete file';
    res.status(500).json({ error: message });
  }
});

function getMimeType(ext: string): string {
  switch (ext) {
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.fit': case '.fits': return 'application/fits';
    case '.tif': case '.tiff': return 'image/tiff';
    case '.avi': return 'video/x-msvideo';
    case '.mp4': return 'video/mp4';
    default: return 'application/octet-stream';
  }
}

export { router as telescopeRouter };
