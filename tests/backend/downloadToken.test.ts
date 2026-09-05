import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { _resetDataKeyForTests } from '../../server/lib/crypto/dataKey';
import { mintDownloadToken, verifyDownloadToken } from '../../server/lib/downloadToken';

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-dltoken-'));
  process.env.DATA_DIR = tmpDir;
  process.env.DATA_KEY = Buffer.alloc(32, 9).toString('base64');
  _resetDataKeyForTests();
});

const SCOPE = '/library/download/objects/M42';

describe('mint / verify round-trip', () => {
  it('accepts a fresh token for the same scope', () => {
    expect(verifyDownloadToken(mintDownloadToken(SCOPE), SCOPE)).toBe(true);
  });

  it('rejects a token presented for a different scope', () => {
    const token = mintDownloadToken(SCOPE);
    expect(verifyDownloadToken(token, '/library/download/objects/M99')).toBe(false);
  });

  it('rejects an expired token', () => {
    const token = mintDownloadToken(SCOPE, -1_000); // already in the past
    expect(verifyDownloadToken(token, SCOPE)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const token = mintDownloadToken(SCOPE);
    const [exp] = token.split('.');
    expect(verifyDownloadToken(`${exp}.deadbeef`, SCOPE)).toBe(false);
  });

  it('rejects a tampered expiry (signature no longer matches)', () => {
    const token = mintDownloadToken(SCOPE);
    const sig = token.slice(token.indexOf('.') + 1);
    expect(verifyDownloadToken(`${Date.now() + 60_000}.${sig}`, SCOPE)).toBe(false);
  });

  it.each(['', '.', 'nodot', 'abc.def', '123'])('rejects malformed token %j without throwing', (bad) => {
    expect(() => verifyDownloadToken(bad, SCOPE)).not.toThrow();
    expect(verifyDownloadToken(bad, SCOPE)).toBe(false);
  });

  it('is bound to the signing key (a different key does not verify)', () => {
    const token = mintDownloadToken(SCOPE);
    process.env.DATA_KEY = Buffer.alloc(32, 1).toString('base64');
    _resetDataKeyForTests();
    try {
      expect(verifyDownloadToken(token, SCOPE)).toBe(false);
    } finally {
      process.env.DATA_KEY = Buffer.alloc(32, 9).toString('base64');
      _resetDataKeyForTests();
    }
  });
});
