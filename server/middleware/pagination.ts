import { Request } from 'express';

export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

/**
 * Parse pagination params from query string.
 * Supports: ?page=1&limit=50 (default: page 1, limit 50, max 200)
 */
export function parsePagination(req: Request, defaultLimit = 50): PaginationParams {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || String(defaultLimit)), 10) || defaultLimit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * Apply pagination to an array of items and return with pagination metadata.
 */
export function paginate<T>(items: T[], params: PaginationParams): PaginatedResult<T> {
  const total = items.length;
  const totalPages = Math.ceil(total / params.limit);
  const paged = items.slice(params.offset, params.offset + params.limit);

  return {
    items: paged,
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages,
      hasNext: params.page < totalPages,
      hasPrev: params.page > 1,
    },
  };
}
