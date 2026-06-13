import { describe, it, expect, vi } from 'vitest';
import { apiEnvelope } from '../../server/middleware/apiEnvelope';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockRes(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    _jsonData: null,
    _originalJson: null,
  };
  // Store original json
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res._originalJson = (data: any) => { res._jsonData = data; return res; };
  res.json = res._originalJson;
  return res;
}

function mockReq() {
  return {} as Record<string, unknown>;
}

describe('apiEnvelope middleware', () => {
  it('attaches apiSuccess method', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    apiEnvelope(req, res, next);
    expect(typeof res.apiSuccess).toBe('function');
    expect(next).toHaveBeenCalled();
  });

  it('attaches apiError method', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    apiEnvelope(req, res, next);
    expect(typeof res.apiError).toBe('function');
  });

  it('apiSuccess wraps data correctly', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    apiEnvelope(req, res, next);
    res.apiSuccess({ test: true }, { page: 1 });

    expect(res._jsonData).toEqual({
      ok: true,
      data: { test: true },
      meta: { page: 1 },
    });
  });

  it('apiSuccess works without meta', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    apiEnvelope(req, res, next);
    res.apiSuccess({ hello: 'world' });

    expect(res._jsonData).toEqual({
      ok: true,
      data: { hello: 'world' },
    });
  });

  it('apiError sets status and error envelope', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    apiEnvelope(req, res, next);
    res.apiError(404, 'NOT_FOUND', 'Resource not found');

    expect(res.statusCode).toBe(404);
    expect(res._jsonData).toEqual({
      ok: false,
      data: null,
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
      },
    });
  });

  it('auto-wraps plain json calls on success', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    apiEnvelope(req, res, next);
    res.json({ plain: 'data' });

    expect(res._jsonData.ok).toBe(true);
    expect(res._jsonData.data).toEqual({ plain: 'data' });
  });

  it('auto-wraps error json calls', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    apiEnvelope(req, res, next);
    res.statusCode = 500;
    res.json({ error: 'something broke' });

    expect(res._jsonData.ok).toBe(false);
    expect(res._jsonData.error.message).toBe('something broke');
  });

  it('passes through already-wrapped responses', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    apiEnvelope(req, res, next);
    const alreadyWrapped = { ok: true, data: { foo: 'bar' } };
    res.json(alreadyWrapped);

    expect(res._jsonData).toEqual(alreadyWrapped);
  });
});
