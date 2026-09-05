/**
 * Frontend mirror of server/lib/library/dwarfStartrails.ts's curated
 * constants. Detection uses `objectType`, not the objectId: the server
 * patches `libraryObjects.objectType` to this exact value once, right after
 * creating the synthetic object (see patchStartrailsObjectMeta), and that
 * value is already present on every AstroObject the frontend fetches — no
 * id-normalization logic needs duplicating here.
 */
export const DWARF_STARTRAILS_OBJECT_TYPE = 'Star Trails';

/** Bundled placeholder, served from public/, shown until the object has a
 *  real captured cover image. Once one exists, the normal galleryImage
 *  resolution takes over and this is never reached again. */
export const DWARF_STARTRAILS_PLACEHOLDER_IMAGE = '/star-trails-placeholder.svg';
