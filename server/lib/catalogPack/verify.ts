/**
 * Signature and integrity verification for catalog asset packs.
 *
 * Two layers:
 *   1. Ed25519 detached signature over manifest.json bytes (authenticity).
 *   2. Per-file SHA-256 hash checked after extraction (integrity).
 *
 * The public key is compiled in via trustedKey.ts — a compromised CDN
 * cannot inject content without the offline private key.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { TRUSTED_PUBLIC_KEY_PEM } from './trustedKey.js';

/**
 * Verify an Ed25519 detached signature against an arbitrary public key (PEM).
 * Used by tests to verify with a dynamically generated test keypair.
 */
export function verifyWithKey(data: Buffer, sigBase64: string, publicKeyPem: string): boolean {
  try {
    const sig = Buffer.from(sigBase64.trim(), 'base64');
    return crypto.verify(null, data, publicKeyPem, sig);
  } catch {
    return false;
  }
}

/**
 * Verify an Ed25519 detached signature.
 *
 * @param data - The signed data (manifest JSON bytes).
 * @param sigBase64 - Base64-encoded 64-byte Ed25519 signature from the .sig file.
 * @returns true if the signature is valid under the compiled-in public key.
 */
export function verifyManifestSignature(data: Buffer, sigBase64: string): boolean {
  if (TRUSTED_PUBLIC_KEY_PEM.includes('PLACEHOLDER')) return false;
  return verifyWithKey(data, sigBase64, TRUSTED_PUBLIC_KEY_PEM);
}

/**
 * Verify a file on disk matches the expected SHA-256 hash (hex).
 * Reads the file synchronously — call only on files already on local disk.
 */
export function verifyFileSha256(filePath: string, expectedHex: string): boolean {
  try {
    const data = fs.readFileSync(filePath);
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    return actual === expectedHex;
  } catch {
    return false;
  }
}

/**
 * Compute the SHA-256 hash of a file on disk (hex string).
 */
export function sha256File(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Compute the SHA-256 hash of a Buffer.
 */
export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Sign data with an Ed25519 private key (PEM string).
 * Used by the build script — not imported by the server at runtime.
 */
export function signManifest(data: Buffer, privateKeyPem: string): string {
  const sig = crypto.sign(null, data, privateKeyPem);
  return sig.toString('base64');
}
