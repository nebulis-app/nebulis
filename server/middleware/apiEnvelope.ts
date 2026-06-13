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
  // Express augments `res.json` with a conditional return type we can't
  // reconstruct here — wrap the assignment in a helper so the single
  // unavoidable cast lives on one line with a justification.
  const wrappedJson = function (body: unknown) {
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
  // Express types `res.json` as an overloaded function whose conditional
  // return type depends on the generic body. Our wrapper accepts `unknown`
  // and returns `Response`, which is compatible at runtime. Single-cast
  // trust boundary, no `as unknown as T`.
  res.json = wrappedJson as typeof res.json;

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
