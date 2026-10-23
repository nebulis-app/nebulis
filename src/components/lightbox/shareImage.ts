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
    const outcome = await shareBlob(blob, fileName, title);
    if (outcome !== 'failed') return outcome;
  }

  const absolute = new URL(src, window.location.href).href;
  try {
    await navigator.clipboard.writeText(absolute);
    return 'copied-link';
  } catch {
    return 'failed';
  }
}

/**
 * Share a picture already in hand (a burned-in annotated copy), through the share sheet or, failing that, the
 * clipboard. There is no link to fall back to: the picture exists only in this tab. `asPng` is asked for lazily,
 * because the clipboard takes PNG only and most shares never need the conversion.
 */
export async function shareBlob(
  blob: Blob,
  fileName: string,
  title: string,
  asPng?: () => Promise<Blob>,
): Promise<ShareOutcome> {
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
  if (navigator.clipboard && 'write' in navigator.clipboard) {
    try {
      const png = blob.type === 'image/png' ? blob : asPng ? await asPng() : null;
      if (png) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        return 'copied-image';
      }
    } catch {
      // Not permitted in this context.
    }
  }
  return 'failed';
}

/** The three outcomes that need a toast, pre-translated by the caller (this
 *  module stays free of an i18next dependency, same reasoning as
 *  `ListShareStrings` in `listShare.ts`). */
export interface ShareOutcomeStrings {
  copiedImage: string;
  copiedLink: string;
  failed: string;
}

/** Toast text for an outcome, or null when nothing needs saying. */
export function shareOutcomeMessage(outcome: ShareOutcome, strings: ShareOutcomeStrings): string | null {
  switch (outcome) {
    case 'copied-image': return strings.copiedImage;
    case 'copied-link': return strings.copiedLink;
    case 'failed': return strings.failed;
    // The OS share sheet already gave its own feedback, and a cancel needs no
    // comment. Listed rather than left to the default so a new outcome has to
    // decide for itself whether it says anything.
    case 'shared': return null;
    case 'cancelled': return null;
    default: {
      const _exhaustive: never = outcome;
      void _exhaustive;
      return null;
    }
  }
}
