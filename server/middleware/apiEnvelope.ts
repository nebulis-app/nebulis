import { Request, Response, NextFunction } from 'express';

/**
 * Standard API response envelope.
 * All JSON responses are wrapped in: { ok, data, meta?, error? }
 *
 * Native clients (iOS/macOS) can rely on this consistent shape
 * for Codable/Decodable structs.
 */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data: T | null;
  meta?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Wraps res.json to automatically apply the API envelope.
 * Call res.json(data) as normal — the middleware transforms it.
 * To send an error, use res.apiError() instead.
 */
export function apiEnvelope(req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);

  // Attach helper for success responses with meta
  res.apiSuccess = function (data: unknown, meta?: Record<string, unknown>) {
    return originalJson({ ok: true, data, meta: meta || undefined });
  };

  // Attach helper for error responses
  res.apiError = function (statusCode: number, code: string, message: string) {
    res.status(statusCode);
    return originalJson({ ok: false, data: null, error: { code, message } });
  };

  // Type guard: narrows `unknown` to `Record<string, unknown>` so we can safely
  // read properties without casts. `in` requires an object operand, so the
  // guard is the proof the compiler needs.
  function isRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object';
  }

  // Override res.json so existing route handlers get automatic wrapping.
  // Express types `res.json` as `Send<any, this>`; a function taking an
  // optional body and returning the bound original's Response satisfies it
  // directly, so no assertion is needed.
  res.json = function (body?: unknown) {
    // If already wrapped (has 'ok' field), pass through
    if (isRecord(body) && 'ok' in body) {
      return originalJson(body);
    }

    // If this is an error response (status >= 400), wrap as error
    if (res.statusCode >= 400) {
      const message = isRecord(body) && 'error' in body
        ? String(body.error)
        : 'An error occurred';
      return originalJson({
        ok: false,
        data: null,
        error: {
          code: getErrorCode(res.statusCode),
          message,
        },
      });
    }

    // Wrap success responses
    return originalJson({ ok: true, data: body });
  };

  next();
}

function getErrorCode(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 422: return 'VALIDATION_ERROR';
    case 429: return 'RATE_LIMITED';
    case 500: return 'INTERNAL_ERROR';
    case 502: return 'BAD_GATEWAY';
    case 503: return 'SERVICE_UNAVAILABLE';
    default: return 'ERROR';
  }
}

// Extend Express types
declare global {
  namespace Express {
    interface Response {
      apiSuccess: (data: unknown, meta?: Record<string, unknown>) => Response;
      apiError: (statusCode: number, code: string, message: string) => Response;
    }
  }
}
