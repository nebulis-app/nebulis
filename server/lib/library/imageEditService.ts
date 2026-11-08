/**
 * Run an image-editor save: find the picture, render the edit (see imageEdit.ts), and put the result where the user
 * asked, through the same library functions the upload routes use, so naming, backups and records behave identically.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { isErrnoException } from '../errors.js';
import { markGeometryEdited } from '../annotate/geometryEdits.js';
import { carrySolutionThroughEdit, solutionBeforeEdit } from '../annotate/annotateService.js';
import { resolveLibraryFile } from './fileResolver.js';
import { addProcessedImage, getProcessedImageFile, getProcessedImageRecord, processedImageMimeType, replaceProcessedImageFile } from './processed.js';
import { replaceLibraryFile, ReplaceFileError } from './replaceFile.js';
import { editedVariantTarget } from './editedVariant.js';
import { renderEditedPicture } from './imageEdit.js';
import type { ImageEditRequest } from './imageEditSchema.js';

export class ImageEditError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 415, readonly code: string, message: string) {
    super(message);
    this.name = 'ImageEditError';
  }
}

export type ImageEditResult =
  | { kind: 'telescope'; path: string; bytes: number }
  | { kind: 'telescopeNew'; objectId: string; date: string; filename: string }
  | { kind: 'processed'; id: string; objectId: string };

const SOURCE_EXT = /\.(jpe?g|png)$/i;

function moveInto(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

function hasGeometry(edit: ImageEditRequest['edit']): boolean {
  return !!edit.crop || !!edit.flipH || !!edit.flipV || !!edit.rotation;
}

/** Where the picture to edit is on disk, and the name to give the result when the user typed none. */
function locateSource(source: ImageEditRequest['source']): { abs: string; stem: string; isPng: boolean; sourceId: string | null } {
  if (source.kind === 'telescope') {
    const resolved = resolveLibraryFile(source.path);
    if (!resolved) throw new ImageEditError(404, 'FILE_NOT_FOUND', 'That file is not in the library');
    if (!fs.existsSync(resolved.abs)) throw new ImageEditError(404, 'FILE_NOT_FOUND', 'That file is no longer on disk');
    if (!SOURCE_EXT.test(resolved.abs)) throw new ImageEditError(415, 'UNSUPPORTED_FORMAT', 'Only JPEG and PNG pictures can be edited');
    return { abs: resolved.abs, stem: path.basename(resolved.abs).replace(/\.[^.]+$/, ''), isPng: /\.png$/i.test(resolved.abs), sourceId: resolved.sourceId };
  }
  const file = getProcessedImageFile(source.id);
  if (!file || !fs.existsSync(file.abs)) throw new ImageEditError(404, 'NOT_FOUND', 'Processed image not found');
  return { abs: file.abs, stem: file.name.replace(/\.[^.]+$/, ''), isPng: /\.png$/i.test(file.abs), sourceId: null };
}

export async function runImageEdit(request: ImageEditRequest, overlay?: Buffer): Promise<ImageEditResult> {
  const source = locateSource(request.source);
  const { save, edit } = request;
  // An overwrite keeps the file's format (a PNG stays a PNG); a new version is a JPEG, as the canvas export was.
  const format = save.mode === 'overwrite' && source.isPng ? 'png' : 'jpeg';
  const ext = format === 'png' ? 'png' : 'jpg';
  const name = `${request.title.trim() || source.stem}.${ext}`;

  // Cheap refusals before the expensive render.
  if (save.mode === 'overwrite') {
    if (request.source.kind === 'processed' && !getProcessedImageRecord(request.source.id)) {
      throw new ImageEditError(404, 'NOT_FOUND', 'Processed image not found');
    }
    if (request.source.kind === 'telescope' && source.sourceId !== null && !save.confirmLinked) {
      throw new ImageEditError(409, 'LINKED_REPLACE_UNCONFIRMED', 'This file is in a linked folder. Confirm that Nebulis may rewrite it.');
    }
  }

  const tmp = path.join(os.tmpdir(), `imageedit_${randomUUID()}.${ext}`);
  try {
    await renderEditedPicture({ sourcePath: source.abs, edit, adjust: request.adjust, overlay, format, outPath: tmp });

    if (save.mode === 'overwrite') {
      if (request.source.kind === 'processed') {
        const record = replaceProcessedImageFile(request.source.id, tmp, name, processedImageMimeType(name));
        if (!record) throw new ImageEditError(404, 'NOT_FOUND', 'Processed image not found');
        return { kind: 'processed', id: record.id, objectId: record.objectId };
      }
      const relPath = request.source.path;
      // The plate solution is keyed to the file's current mtime, so read it before the write replaces the file.
      const base = await solutionBeforeEdit(relPath);
      let replaced;
      try {
        replaced = replaceLibraryFile(relPath, tmp, { confirmLinked: !!save.confirmLinked });
      } catch (err) {
        if (err instanceof ReplaceFileError) throw new ImageEditError(err.status as 404 | 409 | 415, err.code, err.message);
        throw err;
      }
      if (hasGeometry(edit)) markGeometryEdited(relPath);
      if (base) carrySolutionThroughEdit(relPath, base, edit);
      return { kind: 'telescope', path: relPath, bytes: replaced.bytes };
    }

    if (save.target === 'library') {
      if (!save.date) throw new ImageEditError(400, 'INVALID_REQUEST', 'A new library picture needs a session date');
      const target = editedVariantTarget(save.objectId, save.date, ext);
      moveInto(tmp, target.destPath);
      return { kind: 'telescopeNew', objectId: save.objectId, date: save.date, filename: target.filename };
    }
    const notes = save.date ? 'Created with image editor' : '';
    const record = addProcessedImage(save.objectId, save.date, tmp, name, processedImageMimeType(name), save.date ? request.title.trim() || source.stem : '', notes, null);
    return { kind: 'processed', id: record.id, objectId: record.objectId };
  } finally {
    // A successful save moved or renamed the temp file away; a failed one leaves it behind.
    fs.rmSync(tmp, { force: true });
  }
}
