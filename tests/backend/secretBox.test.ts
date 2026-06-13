import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { _resetDataKeyForTests } from '../../server/lib/crypto/dataKey';
import { encrypt, decrypt } from '../../server/lib/crypto/secretBox';

// Force a deterministic test key so the tests don't touch DATA_DIR.
beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-crypto-'));
  process.env.DATA_DIR = tmpDir;
  process.env.DATA_KEY = Buffer.alloc(32, 7).toString('base64');
  _resetDataKeyForTests();
});

describe('encrypt / decrypt round-trip', () => {
  it('recovers ASCII plaintext', () => {
    const blob = encrypt('hunter2');
    expect(decrypt(blob)).toBe('hunter2');
  });

  it('recovers empty string', () => {
    const blob = encrypt('');
    expect(decrypt(blob)).toBe('');
  });

  it('recovers unicode plaintext', () => {
    const plain = 'パスワード 🔐 ñ';
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it('produces different ciphertext for the same input (fresh nonce)', () => {
    expect(encrypt('same input')).not.toBe(encrypt('same input'));
  });

  it('produces a 3-part dot-separated blob', () => {
    const blob = encrypt('x');
    expect(blob.split('.')).toHaveLength(3);
  });
});

describe('decrypt failure modes', () => {
  it('throws on a blob with the wrong shape', () => {
    expect(() => decrypt('not-encrypted')).toThrow(/3 dot-separated parts/);
    expect(() => decrypt('a.b')).toThrow(/3 dot-separated parts/);
  });

  it('throws when the auth tag is tampered', () => {
    const blob = encrypt('secret');
    const [nonce, , ct] = blob.split('.');
    const tampered = `${nonce}.${Buffer.alloc(16, 0).toString('base64')}.${ct}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws when the ciphertext is tampered', () => {
    const blob = encrypt('secret');
    const [nonce, tag, ct] = blob.split('.');
    // Flip the first byte of ciphertext.
    const ctBuf = Buffer.from(ct, 'base64');
    if (ctBuf.length > 0) ctBuf[0] ^= 0xff;
    const tampered = `${nonce}.${tag}.${ctBuf.toString('base64')}`;
    expect(() => decrypt(tampered)).toThrow();
  });
});
