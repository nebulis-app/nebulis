/**
 * Which library picture an image-editor URL points at, so the server can edit the file itself instead of the browser
 * redrawing it. Only the app's own two picture URLs are recognized; anything else (an external image) returns null and
 * the editor falls back to editing in the browser.
 */
export type EditSource =
  | { kind: 'telescope'; path: string }
  | { kind: 'processed'; id: string };

export function editSourceFromUrl(url: string): EditSource | null {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.origin);
  } catch {
    return null;
  }
  if (parsed.origin !== window.location.origin) return null;
  if (/\/library\/file$/.test(parsed.pathname)) {
    const filePath = parsed.searchParams.get('path');
    return filePath ? { kind: 'telescope', path: filePath } : null;
  }
  const processed = /\/library\/processed-images\/([^/]+)$/.exec(parsed.pathname);
  return processed ? { kind: 'processed', id: decodeURIComponent(processed[1]) } : null;
}
