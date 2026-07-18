import type { UserRole } from '../lib/auth.js';

declare global {
  namespace Express {
    interface Request {
      id: string;
      userId?: string;
      username?: string;
      userRole?: UserRole;
      /** Upload-route diagnostics, set by the upload-temp handler and read by
       *  the global error handler for truncated-upload logging. Undefined on
       *  every other route — harmless. */
      __uploadStart?: number;
      __bytesReceived?: number;
    }
  }
}
