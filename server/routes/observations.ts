/**
 * Observation routes — all data served from local library only.
 * No SMB calls during viewing. Data must be imported first.
 */
import { Router, Request, Response } from 'express';
import {
  getLocalObservations,
  getLocalObservationDetail,
} from '../lib/localLibrary.js';

const router = Router();

// ─── List all observations across all objects ────────────────────────

router.get('/', (_req: Request, res: Response) => {
  try {
    const observations = getLocalObservations();
    res.apiSuccess(observations);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to list observations';
    res.apiError(500, 'LIST_FAILED', message);
  }
});

// ─── Get detail for a single observation ─────────────────────────────

router.get('/:objectId/:date', (req: Request, res: Response) => {
  try {
    const objectId = String(req.params.objectId);
    const date = String(req.params.date);
    const detail = getLocalObservationDetail(
      decodeURIComponent(objectId),
      decodeURIComponent(date),
    );
    res.apiSuccess(detail);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to get observation detail';
    res.apiError(500, 'FETCH_FAILED', message);
  }
});

export { router as observationsRouter };
