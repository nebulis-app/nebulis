import type { OverwriteTarget } from '../ImageEditorModal';
import type { GalleryItem } from '../GalleryModal';

/** A picture opened from an object page for editing, with the object and night it belongs to. */
export interface ObjectEditRequest {
  url: string;
  name: string;
  sourceKind: 'telescope' | 'processed';
  overwriteTarget?: OverwriteTarget;
  /** The object that owns the picture, which can be a variant (Mosaic, Hα) of the page's object. */
  objectId: string;
  /** Null for a picture that belongs to no single night. */
  date: string | null;
}

/**
 * Finds what an object page needs to edit the picture the viewer is showing. The viewer reports the picture by its
 * URL, so it is matched back to the item to learn which object and night it belongs to.
 */
export function editRequestFor(
  items: GalleryItem[],
  pageObjectId: string,
  url: string,
  name: string,
  sourceKind: 'telescope' | 'processed',
  overwriteTarget: OverwriteTarget | undefined,
): ObjectEditRequest {
  const match = items.find(i => (i.kind === 'file' ? i.file.downloadUrl : i.img.url) === url);
  const owner = match?.kind === 'processed' ? match.img.objectId : pageObjectId;
  const date = match?.kind === 'processed' ? match.img.date : match?.file.date ?? null;
  // Replacing an original happens inside its own night, so without one only "Save as new" is offered.
  const canOverwrite = overwriteTarget && !(overwriteTarget.kind === 'telescope' && !date);
  return { url, name, sourceKind, overwriteTarget: canOverwrite ? overwriteTarget : undefined, objectId: owner, date };
}
