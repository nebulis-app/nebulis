/**
 * Authenticated symmetric encryption for at-rest secrets.
 *
 * Format: `<nonce_b64>.<tag_b64>.<ciphertext_b64>` using AES-256-GCM with
 * a fresh 12-byte nonce per call. The auth tag is verified on decrypt —
 * tampered blobs throw.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { getDataKey } from './dataKey.js';

export function encrypt(plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getDataKey(), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${nonce.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(blob: string): string {
  const parts = blob.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted blob: expected 3 dot-separated parts');
  }
  const [nonceB64, tagB64, ctB64] = parts;
  const nonce = Buffer.from(nonceB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', getDataKey(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
