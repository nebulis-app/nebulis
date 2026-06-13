import type { UserRole } from '../lib/auth.js';

declare global {
  namespace Express {
    interface Request {
      id: string;
      userId?: string;
      username?: string;
      userRole?: UserRole;
    }
  }
}
