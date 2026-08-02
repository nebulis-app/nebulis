/**
 * Share an image, degrading sensibly when the Web Share API is unavailable.
 *
 * The previous fallback opened a mail draft containing the image URL. That URL
 * is a LAN address (`http://192.168.x.x:8080/...`), so the recipient could
 * never open it unless they were on the same network and already had access.
 * Copying the file itself to the clipboard is useful off-network; copying the
 * link is at least honest about what it is. Mail is no longer involved.
 */
export type ShareOutcome = 'shared' | 'copied-image' | 'copied-link' | 'cancelled' | 'failed';

export async function shareImage(
  src: string,
  fileName: string,
  title: string,
): Promise<ShareOutcome> {
  let blob: Blob | null = null;
  try {
    const res = await fetch(src);
    if (res.ok) blob = await res.blob();
  } catch {
    // Offline or the file moved. Fall through to link sharing.
  }

  if (blob) {
    const file = new File([blob], fileName, { type: blob.type || 'image/jpeg' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title });
        return 'shared';
      } catch (err) {
        // The user dismissing the sheet is a normal outcome, not an error.
        if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      }
    }

    // Clipboard image write only accepts a handful of types, PNG universally.
    if (blob.type === 'image/png' && navigator.clipboard && 'write' in navigator.clipboard) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        return 'copied-image';
      } catch {
        // Not permitted in this context. Fall through to link copying.
      }
    }
  }

  const absolute = new URL(src, window.location.href).href;
  try {
    await navigator.clipboard.writeText(absolute);
    return 'copied-link';
  } catch {
    return 'failed';
  }
}

/** Toast text for an outcome, or null when nothing needs saying. */
export function shareOutcomeMessage(outcome: ShareOutcome): string | null {
  switch (outcome) {
    case 'copied-image': return 'Image copied to clipboard';
    case 'copied-link': return 'Link copied. It only works on this network.';
    case 'failed': return 'Could not share this image';
    default: return null;
  }
}
