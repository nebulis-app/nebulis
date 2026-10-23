import type { UserRole } from '../lib/types/userRole.js';

declare global {
  namespace Express {
    interface Request {
      id: string;
      userId?: string;
      username?: string;
      userRole?: UserRole;
      /** True when the request authenticated with a personal API key (neb-…) rather than a sign-in token. */
      viaApiKey?: boolean;
      /** Upload-route diagnostics, set by the upload-temp handler and read by
       *  the global error handler for truncated-upload logging. Undefined on
       *  every other route — harmless. */
      __uploadStart?: number;
      __bytesReceived?: number;
    }
  }
}
