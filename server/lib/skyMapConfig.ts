// Server-side sky-map dimensions. Mirrors nebulis-web/src/lib/visibilityCheck.ts.
//
// SKY_MAP_BANDS is advertised in the settings response (`skyMapBands`) so native
// clients can gate the finer-grid editor on it: a client built for 8 bands only
// renders/saves a 288-cell map when the server reports it supports that many.
// Older servers omit the field, so those clients fall back to the legacy 4-band
// (144-cell) grid and keep working.
export const SKY_MAP_AZ_SLICES = 36;
export const SKY_MAP_BANDS = 8;
export const SKY_MAP_CELLS = SKY_MAP_AZ_SLICES * SKY_MAP_BANDS; // 288
