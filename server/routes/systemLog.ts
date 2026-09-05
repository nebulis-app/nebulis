import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { parsePagination } from '../middleware/pagination.js';
import {
  getSystemLogs,
  clearSystemLog,
  logEvent,
  isSystemLogCategory,
  isSystemLogLevel,
} from '../lib/systemLog.js';

const router = Router();

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

// Admin-only audit trail. Entire router is gated since this can surface
// usernames, IPs, and account changes that a viewer has no business seeing.
router.use(requireAdmin);

router.get('/', (req: Request, res: Response) => {
  const { limit, offset } = parsePagination(req, 50);

  // Unknown filter values are dropped rather than passed through, so a
  // hand-edited query string can never widen the WHERE clause.
  const categoryRaw = typeof req.query.category === 'string' ? req.query.category : '';
  const category = isSystemLogCategory(categoryRaw) ? categoryRaw : undefined;

  const levelRaw = typeof req.query.level === 'string' ? req.query.level : '';
  const level = isSystemLogLevel(levelRaw) ? levelRaw : undefined;

  const searchRaw = typeof req.query.search === 'string' ? req.query.search.trim() : '';

  res.apiSuccess(getSystemLogs({ limit, offset, category, level, search: searchRaw || undefined }));
});

// Wipes the log. A record of who cleared it is written right after, so the
// audit trail never goes from "has history" to "no history, no explanation".
router.delete('/', (req: Request, res: Response) => {
  clearSystemLog();
  logEvent({
    category: 'system',
    event: 'log_cleared',
    message: `Cleared the system log${req.username ? ` (${req.username})` : ''}.`,
    userId: req.userId,
    username: req.username,
    ip: clientIp(req),
  });
  res.apiSuccess({ cleared: true });
});

export const systemLogRouter = router;
