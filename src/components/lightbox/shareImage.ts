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

/**
 * Pictures fetched ahead of a share. Safari lets `navigator.share` and a clipboard write run only straight from the
 * click that asked for them; waiting on a download first spends that permission, and then the share and the link copy
 * after it both fail. So the picture is fetched when the pointer reaches the share button, and the click finds it
 * ready and shares at once. Held briefly and in small number: the bytes behind a URL can change when a picture is
 * edited and saved over itself.
 */
const WARM_MAX = 4;
const WARM_MS = 60_000;
const warmed = new Map<string, { promise: Promise<Blob | null>; blob: Blob | null; at: number }>();

async function fetchBlob(src: string): Promise<Blob | null> {
  try {
    const res = await fetch(src);
    return res.ok ? await res.blob() : null;
  } catch {
    // Offline or the file moved. The caller falls through to link sharing.
    return null;
  }
}

/** Start fetching the picture a share would send. Safe to call on every hover or focus. */
export function warmShareImage(src: string): void {
  const existing = warmed.get(src);
  if (existing && Date.now() - existing.at < WARM_MS) return;
  const entry: { promise: Promise<Blob | null>; blob: Blob | null; at: number } = {
    promise: Promise.resolve(null), blob: null, at: Date.now(),
  };
  entry.promise = fetchBlob(src).then(blob => {
    entry.blob = blob;
    if (!blob && warmed.get(src) === entry) warmed.delete(src);
    return blob;
  });
  warmed.set(src, entry);
  while (warmed.size > WARM_MAX) {
    const oldest = warmed.keys().next().value;
    if (oldest === undefined) break;
    warmed.delete(oldest);
  }
}

export async function shareImage(
  src: string,
  fileName: string,
  title: string,
): Promise<ShareOutcome> {
  // Nothing may be awaited before the share when the picture is already in hand: that is the click's one chance.
  let blob: Blob | null = null;
  const ready = warmed.get(src);
  if (ready?.blob && Date.now() - ready.at < WARM_MS) {
    blob = ready.blob;
  } else {
    warmShareImage(src);
    blob = await (warmed.get(src)?.promise ?? fetchBlob(src));
  }

  if (blob) {
    const outcome = await shareBlob(blob, fileName, title);
    if (outcome !== 'failed') return outcome;
  }

  const absolute = new URL(src, window.location.href).href;
  try {
    await navigator.clipboard.writeText(absolute);
    return 'copied-link';
  } catch (err) {
    console.warn('[share] could not copy the link either:', err);
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
      console.warn('[share] the share sheet refused the picture:', err);
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
