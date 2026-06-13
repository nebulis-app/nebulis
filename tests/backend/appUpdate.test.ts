import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { compareVersions } from '../../server/lib/appUpdate/platform';
import { AppUpdateIndex } from '../../server/lib/appUpdate/manifest';
import { verifyAppManifestSignature } from '../../server/lib/appUpdate/verify';
import { verifyWithKey, signManifest } from '../../server/lib/catalogPack/verify';

describe('appUpdate/platform compareVersions', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('treats equal versions as 0 and tolerates differing segment counts', () => {
    expect(compareVersions('1.1.0', '1.1.0')).toBe(0);
    expect(compareVersions('1.1', '1.1.0')).toBe(0);
    expect(compareVersions('1.1.1', '1.1')).toBeGreaterThan(0);
  });
});

describe('appUpdate/manifest schema', () => {
  const valid = {
    schemaVersion: 1,
    channel: 'stable',
    generatedAt: '2026-05-21T00:00:00.000Z',
    latest: {
      version: '1.2.0',
      build: 100,
      minUpgradableFrom: '1.0.0',
      mandatory: false,
      notesUrl: 'https://downloads.nebulis.app/app/v1/1.2.0/CHANGELOG.md',
      artifacts: {
        'win-x64': {
          url: 'https://downloads.nebulis.app/latest/nebulis-1.2.0-win.exe',
          sha256: 'a'.repeat(64),
          bytes: 12345,
        },
      },
    },
  };

  it('accepts a well-formed manifest', () => {
    expect(() => AppUpdateIndex.parse(valid)).not.toThrow();
  });

  it('rejects a manifest with a short sha256', () => {
    const bad = structuredClone(valid);
    bad.latest.artifacts['win-x64'].sha256 = 'abc';
    expect(() => AppUpdateIndex.parse(bad)).toThrow();
  });

  it('rejects an unknown channel', () => {
    const bad = { ...valid, channel: 'nightly' };
    expect(() => AppUpdateIndex.parse(bad)).toThrow();
  });
});

describe('appUpdate/verify', () => {
  it('rejects the manifest while the trusted key is still the placeholder', () => {
    // The committed trustedKey.ts is a placeholder until gen-app-key.mjs runs;
    // an unsigned/forged manifest must never verify against it.
    const data = Buffer.from('{"latest":{"version":"9.9.9"}}', 'utf8');
    expect(verifyAppManifestSignature(data, 'AAAA')).toBe(false);
  });

  it('verifies a genuine Ed25519 signature and rejects tampering (build↔server roundtrip)', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const data = Buffer.from(JSON.stringify({ latest: { version: '1.2.0' } }), 'utf8');
    const sig = signManifest(data, privateKey);

    expect(verifyWithKey(data, sig, publicKey)).toBe(true);
    const tampered = Buffer.concat([data, Buffer.from('!')]);
    expect(verifyWithKey(tampered, sig, publicKey)).toBe(false);
  });
});
