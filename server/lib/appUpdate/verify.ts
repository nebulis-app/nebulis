/**
 * Signature + integrity verification for the desktop app update manifest.
 *
 * Reuses the Ed25519 primitive from catalogPack/verify.ts but checks against
 * the SEPARATE app-update public key (trustedKey.ts), so the two release
 * channels cannot be confused and have independent blast radius.
 */

import { verifyWithKey } from '../catalogPack/verify.js';
import { APP_UPDATE_PUBLIC_KEY_PEM } from './trustedKey.js';

/**
 * Verify an Ed25519 detached signature over the manifest bytes.
 * Returns false (never throws) for a bad signature, and always false while the
 * compiled-in key is still the placeholder — an unsigned/forged manifest can
 * never be accepted.
 */
export function verifyAppManifestSignature(data: Buffer, sigBase64: string): boolean {
  if (APP_UPDATE_PUBLIC_KEY_PEM.includes('PLACEHOLDER')) {
    console.warn('[appUpdate] trusted key is a placeholder — run scripts/gen-app-key.mjs. Rejecting manifest.');
    return false;
  }
  return verifyWithKey(data, sigBase64, APP_UPDATE_PUBLIC_KEY_PEM);
}
