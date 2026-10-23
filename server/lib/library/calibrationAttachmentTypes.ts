/**
 * Types for calibration attachments, kept in a leaf module so the pure
 * filesystem scanner (calibrationScan.ts) can describe attachments without
 * importing the database-backed calibrationAttachments.ts.
 */
import type { CalibrationFrameType } from './calibrationFolders.js';

/** Only flats and flat-darks are session-specific enough to need this — see
 *  calibrationAttachments.ts's header. Attaching a bias/dark/mixed bundle is rejected upstream
 *  (the route layer), not silently allowed here. */
export type AttachableCalibrationType = Extract<CalibrationFrameType, 'flat' | 'flatDark'>;

export interface CalibrationAttachment {
  id: string;
  objectId: string;
  /** '' means "whole object" — see WHOLE_OBJECT_DATE (calibrationAttachments.ts). */
  date: string;
  calibrationType: AttachableCalibrationType;
  scope: string | null;
  folderName: string;
  settingsKey: string;
  createdAt: string;
}

export interface CalibrationAttachmentSummary extends CalibrationAttachment {
  /** Display name for the attached object, or its folder name when it has no
   *  resolved catalog name — never absent, so the UI never has to fall back
   *  to a bare id. */
  objectName: string;
}
