import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  recordSmbOpResult,
  getSmbOpHealth,
  invalidateSmbReachability,
} from '../../server/lib/smbReachability';

describe('SMB real-operation health', () => {
  beforeEach(() => {
    invalidateSmbReachability(); // clear all hosts between tests
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for a host with no recorded op', () => {
    expect(getSmbOpHealth('10.0.0.1')).toBeUndefined();
  });

  it('records a failure with its reason', () => {
    recordSmbOpResult('10.0.0.1', false, 'SMB connection failed: Connection failed');
    const health = getSmbOpHealth('10.0.0.1');
    expect(health?.ok).toBe(false);
    expect(health?.error).toBe('SMB connection failed: Connection failed');
  });

  it('records a success and clears any prior error', () => {
    recordSmbOpResult('10.0.0.1', false, 'boom');
    recordSmbOpResult('10.0.0.1', true);
    const health = getSmbOpHealth('10.0.0.1');
    expect(health?.ok).toBe(true);
    expect(health?.error).toBeUndefined();
  });

  it('keeps hosts independent', () => {
    recordSmbOpResult('10.0.0.1', false, 'boom');
    recordSmbOpResult('10.0.0.2', true);
    expect(getSmbOpHealth('10.0.0.1')?.ok).toBe(false);
    expect(getSmbOpHealth('10.0.0.2')?.ok).toBe(true);
  });

  it('ignores an empty/undefined host', () => {
    recordSmbOpResult('', false, 'boom');
    recordSmbOpResult(undefined, false, 'boom');
    expect(getSmbOpHealth('')).toBeUndefined();
  });

  it('invalidation drops recorded health for a host', () => {
    recordSmbOpResult('10.0.0.1', false, 'boom');
    invalidateSmbReachability('10.0.0.1');
    expect(getSmbOpHealth('10.0.0.1')).toBeUndefined();
  });

  it('stamps checkedAt so callers can age out stale failures', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T20:00:00Z'));
    recordSmbOpResult('10.0.0.1', false, 'boom');
    expect(getSmbOpHealth('10.0.0.1')?.checkedAt).toBe(Date.parse('2026-06-15T20:00:00Z'));
  });
});
