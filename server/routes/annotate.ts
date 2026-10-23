/**
 * Image annotation: which catalog objects are in this picture, and where.
 *
 *   GET  /annotate?path=<library path>      annotations + quality tier + solver state
 *   POST /annotate/solve?path=<path>        start a background plate solve
 *   GET  /annotate/solver                   is the plate solver installed?
 *   POST /annotate/solver/install  (admin)  download ASTAP + star database
 *
 *  GET  /annotate/auto-solve               background solving: on/off, how many pictures are waiting
 *  POST /annotate/auto-solve/run  (admin)  solve what is waiting now
 *
 * See lib/annotate/annotateService.ts for the quality tiers.
 */
import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { queryString } from '../lib/queryHelpers.js';
import { log } from '../lib/logger.js';
import { getAnnotations, startSolve, AnnotateInputError } from '../lib/annotate/annotateService.js';
import { getSolverStatus, installSolver } from '../lib/annotate/astap.js';
import { getAutoSolveStatus, tickAutoSolve } from '../lib/annotate/autoSolve.js';

export const annotateRouter = Router();

function fail(res: Response, err: unknown): void {
  if (err instanceof AnnotateInputError) {
    res.apiError(err.status, err.status === 404 ? 'NOT_FOUND' : 'INVALID_INPUT', err.message);
    return;
  }
  log.warn({ err }, '[annotate] request failed');
  res.apiError(500, 'ANNOTATE_FAILED', err instanceof Error ? err.message : 'Annotation failed');
}

annotateRouter.get('/solver', (_req: Request, res: Response) => {
  res.apiSuccess(getSolverStatus());
});

annotateRouter.post('/solver/install', requireAdmin, (_req: Request, res: Response) => {
  const status = getSolverStatus();
  if (!status.supported) {
    res.apiError(422, 'UNSUPPORTED_PLATFORM', 'The plate solver is not available for this computer');
    return;
  }
  if (!status.ready) void installSolver().catch(() => undefined);
  res.apiSuccess(getSolverStatus());
});

annotateRouter.get('/auto-solve', (_req: Request, res: Response) => {
  res.apiSuccess(getAutoSolveStatus());
});

annotateRouter.post('/auto-solve/run', requireAdmin, (_req: Request, res: Response) => {
  void tickAutoSolve().catch(() => undefined);
  res.apiSuccess(getAutoSolveStatus());
});

annotateRouter.get('/', async (req: Request, res: Response) => {
  const filePath = queryString(req.query.path);
  if (!filePath) {
    res.apiError(400, 'MISSING_PATH', 'Query parameter "path" is required');
    return;
  }
  try {
    res.apiSuccess(await getAnnotations(filePath));
  } catch (err) {
    fail(res, err);
  }
});

annotateRouter.post('/solve', async (req: Request, res: Response) => {
  const filePath = queryString(req.query.path);
  if (!filePath) {
    res.apiError(400, 'MISSING_PATH', 'Query parameter "path" is required');
    return;
  }
  if (!getSolverStatus().ready) {
    res.apiError(409, 'SOLVER_NOT_INSTALLED', 'Install the plate solver first');
    return;
  }
  try {
    res.apiSuccess(await startSolve(filePath));
  } catch (err) {
    fail(res, err);
  }
});
