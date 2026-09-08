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
 * A caller may pass ?offset=N directly instead of ?page; when present it wins
 * and `page` is derived from it, so an offset-based client (the System Log)
 * isn't silently pinned to the first page.
 */
export function parsePagination(req: Request, defaultLimit = 50): PaginationParams {
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || String(defaultLimit)), 10) || defaultLimit));

  const hasOffset = req.query.offset !== undefined;
  if (hasOffset) {
    const offset = Math.max(0, parseInt(String(req.query.offset), 10) || 0);
    return { page: Math.floor(offset / limit) + 1, limit, offset };
  }

  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
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
