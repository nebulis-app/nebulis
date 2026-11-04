/**
 * Which phone app a connected device is running, read from the `X-Client-Platform` header ("Nebulis-iOS/2.1.2").
 * It is stored on the paired device (connectedDevices.clientPlatform / clientVersion) so the server knows what each one runs.
 */

export interface ClientApp { platform: string; version: string }

/** "Nebulis-iOS/2.1.2" as { platform: 'Nebulis-iOS', version: '2.1.2' }; null for anything else, so junk is never stored. */
export function parseClientPlatform(header: unknown): ClientApp | null {
  if (typeof header !== 'string') return null;
  const m = /^(Nebulis-[A-Za-z]{2,12})\/(\d{1,4}(?:\.\d{1,4}){0,2})(?:[-+][\w.]{0,32})?$/.exec(header.trim());
  return m ? { platform: m[1], version: m[2] } : null;
}
