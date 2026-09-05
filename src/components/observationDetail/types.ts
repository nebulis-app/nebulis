import type { CompareFile } from '../ImageCompareModal';

/** One slot of the two-up image compare picker. Shared by the page and its
 *  two grid children (SessionFileGrid, ProcessedImagesGrid) — living here
 *  instead of on the page means neither grid depends on the page module to
 *  get its own prop type. */
export type CompareItem = { key: string; file: CompareFile };
