import { describe, it, expect } from 'vitest';
import { parsePagination, paginate } from '../../server/middleware/pagination';

// Mock Express Request
function mockReq(query: Record<string, string> = {}) {
  return { query } as Record<string, unknown>;
}

describe('parsePagination', () => {
  it('returns defaults with no query params', () => {
    const result = parsePagination(mockReq());
    expect(result.page).toBe(1);
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it('parses page and limit', () => {
    const result = parsePagination(mockReq({ page: '3', limit: '20' }));
    expect(result.page).toBe(3);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(40);
  });

  it('uses custom default limit', () => {
    const result = parsePagination(mockReq(), 100);
    expect(result.limit).toBe(100);
  });

  it('clamps page to minimum of 1', () => {
    const result = parsePagination(mockReq({ page: '0' }));
    expect(result.page).toBe(1);
  });

  it('clamps page to minimum of 1 for negative', () => {
    const result = parsePagination(mockReq({ page: '-5' }));
    expect(result.page).toBe(1);
  });

  it('caps limit at 200', () => {
    const result = parsePagination(mockReq({ limit: '500' }));
    expect(result.limit).toBe(200);
  });

  it('should return defaults when page and limit are non-numeric strings', () => {
    const result = parsePagination(mockReq({ page: 'abc', limit: 'xyz' }));
    expect(result.page).toBe(1);
    expect(result.limit).toBe(50);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));

  it('returns first page correctly', () => {
    const result = paginate(items, { page: 1, limit: 10, offset: 0 });
    expect(result.items).toHaveLength(10);
    expect(result.items[0]).toEqual({ id: 1 });
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.total).toBe(25);
    expect(result.pagination.totalPages).toBe(3);
    expect(result.pagination.hasNext).toBe(true);
    expect(result.pagination.hasPrev).toBe(false);
  });

  it('returns middle page correctly', () => {
    const result = paginate(items, { page: 2, limit: 10, offset: 10 });
    expect(result.items).toHaveLength(10);
    expect(result.items[0]).toEqual({ id: 11 });
    expect(result.pagination.hasNext).toBe(true);
    expect(result.pagination.hasPrev).toBe(true);
  });

  it('returns last page correctly', () => {
    const result = paginate(items, { page: 3, limit: 10, offset: 20 });
    expect(result.items).toHaveLength(5);
    expect(result.items[0]).toEqual({ id: 21 });
    expect(result.pagination.hasNext).toBe(false);
    expect(result.pagination.hasPrev).toBe(true);
  });

  it('should return zero items and totalPages when input array is empty', () => {
    const result = paginate([], { page: 1, limit: 10, offset: 0 });
    expect(result.items).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
    expect(result.pagination.totalPages).toBe(0);
    expect(result.pagination.hasNext).toBe(false);
    expect(result.pagination.hasPrev).toBe(false);
  });

  it('should return zero items when page exceeds total pages', () => {
    const result = paginate(items, { page: 10, limit: 10, offset: 90 });
    expect(result.items).toHaveLength(0);
    expect(result.pagination.total).toBe(25);
  });
});
