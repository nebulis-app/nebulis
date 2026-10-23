import { describe, it, expect } from 'vitest';
import { isErrnoException, errnoCode, childProcessOutput } from '../../server/lib/errors';
import { isRecord, parseJsonRecord, assertNever } from '../../server/lib/typeGuards';

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`fail ${code}`), { code });
}

describe('errnoCode / isErrnoException', () => {
  it('returns the code from an Error carrying one', () => {
    expect(errnoCode(errnoError('ENOENT'))).toBe('ENOENT');
    expect(isErrnoException(errnoError('EEXIST'))).toBe(true);
  });

  it('returns undefined for a plain Error without code', () => {
    expect(errnoCode(new Error('plain'))).toBeUndefined();
    expect(isErrnoException(new Error('plain'))).toBe(false);
  });

  it('rejects non-Error objects even when they have a code field', () => {
    expect(errnoCode({ code: 'ENOENT' })).toBeUndefined();
    expect(errnoCode('ENOENT')).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
  });

  it('reads a real fs error code', async () => {
    const fs = await import('fs/promises');
    const err = await fs.readFile('/definitely/not/here/nebulis-xyz').catch((e: unknown) => e);
    expect(errnoCode(err)).toBe('ENOENT');
  });
});

describe('childProcessOutput', () => {
  it('returns string stdout/stderr as-is', () => {
    const err = Object.assign(new Error('x'), { stdout: 'out text', stderr: 'err text' });
    expect(childProcessOutput(err, 'stdout')).toBe('out text');
    expect(childProcessOutput(err, 'stderr')).toBe('err text');
  });

  it('decodes a Buffer as UTF-8', () => {
    const err = Object.assign(new Error('x'), { stderr: Buffer.from('NT_STATUS_LOGON_FAILURE é', 'utf8') });
    expect(childProcessOutput(err, 'stderr')).toBe('NT_STATUS_LOGON_FAILURE é');
  });

  it('returns undefined when the stream is missing or of another type', () => {
    expect(childProcessOutput(new Error('x'), 'stdout')).toBeUndefined();
    expect(childProcessOutput({ stdout: 42 }, 'stdout')).toBeUndefined();
    expect(childProcessOutput(null, 'stdout')).toBeUndefined();
    expect(childProcessOutput('stdout', 'stdout')).toBeUndefined();
  });

  it('works on plain objects too (not just Error instances)', () => {
    expect(childProcessOutput({ stdout: 'hi' }, 'stdout')).toBe('hi');
  });
});

describe('server typeGuards', () => {
  it('isRecord accepts plain objects and rejects arrays/null/primitives', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('parseJsonRecord returns the object for object JSON', () => {
    expect(parseJsonRecord('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('parseJsonRecord returns null for invalid JSON and non-object JSON', () => {
    expect(parseJsonRecord('{nope')).toBeNull();
    expect(parseJsonRecord('[1,2]')).toBeNull();
    expect(parseJsonRecord('42')).toBeNull();
    expect(parseJsonRecord('null')).toBeNull();
    expect(parseJsonRecord('"str"')).toBeNull();
  });

  it('assertNever throws with the message and JSON of the value', () => {
    expect(() => assertNever('rogue' as never, 'Unhandled kind')).toThrow('Unhandled kind: "rogue"');
  });
});
