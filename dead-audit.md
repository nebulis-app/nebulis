# 🪦 Dead Code Crusade Report

**Date**: 2026-06-26  
**Scope**: `nebulis-web/src` (391 files, ~77,630 LOC)  
**Mode**: AUDIT  

---

## Executive Summary

The Dead Code Reapers have completed their sweep of the 145 source files under `src/`.

**Total Findings**: 112 (1 CRITICAL, 111 WARNING, 0 INFO)

**Findings by Severity**:
- 🔴 CRITICAL: 1
- 🟡 WARNING: 111
- 🔵 INFO: 0

**Findings by Category**:
| Category | Count | Notes |
|---|---|---|
| Unused Exports | 110 | 1 entire dead module + 109 individual symbols |
| Orphaned Files | 2 | 329 total lines |
| Commented Code | 0 | Clean |
| Debug Artifacts | 0 | Clean |
| Stale TODOs | 0 | Clean |
| Unreachable Code | 0 | Clean |

The codebase is exceptionally clean on discipline metrics (no debug artifacts, no TODO debt, no commented-out code, no unreachable branches). The dead weight is concentrated in **unused API types and exports** — symbols defined and never consumed.

---

## 🔴 CRITICAL Findings

### Entire Dead Module: `src/lib/api/wishlist.ts`

**Issue**: All 5 exports have zero importers anywhere in the codebase. The "wishlist" string appears in routes and UI labels but none of these API functions are ever called. This is a complete mausoleum.

| Export | Line | Type |
|---|---|---|
| `WishlistItem` | 3 | interface |
| `getWishlist` | 16 | const |
| `addToWishlist` | 17 | const |
| `updateWishlistItem` | 19 | const |
| `removeFromWishlist` | 21 | const |

**Recommendation**: Delete `src/lib/api/wishlist.ts` entirely. If wishlist functionality is planned, it belongs in a ticket — not in dead code.

---

## 🟡 WARNING Findings

### Orphaned Files (2)

These files are not imported by any other file in the dependency graph (143 of 145 files are reachable from `src/main.tsx`).

| File | Lines | Notes |
|---|---|---|
| `src/components/folderImport/FolderBrowser.tsx` | 190 | Sibling `FolderImportWizard.tsx` is live; this was left behind |
| `src/components/ObjectPreview.tsx` | 139 | Referenced in a prose comment in `server/lib/catalogPrefetch.ts` but never imported |

**Recommendation**: Delete both files. `FolderBrowser.tsx` may have been superseded by `FolderImportWizard.tsx`; confirm before deleting. `ObjectPreview.tsx` appears to be a component that was planned/started but never wired in.

---

### Unused Type/Interface Exports (65)

All have zero importers across the entire `src/` tree.

**`src/lib/api/telescopes.ts`** (12 dead exports — heaviest concentration)
| Export | Line |
|---|---|
| `TelescopeStatus` | 5 |
| `TelescopeStatusEntry` | 14 |
| `ConnectionType` | 34 |
| `TelescopeTransport` | 83 |
| `DwarfMount` | 108 |
| `TelescopeCreateInput` | 125 |
| `TelescopeUpdateInput` | 143 |
| `ProbeIdentityInput` | 210 |
| `ProbeIdentityResult` | 222 |
| `listProfileTransports` | 238 |
| `updateProfileTransport` | 252 |
| `deleteProfileTransport` | 262 |

**`src/lib/api/library.ts`** (13 dead exports)
| Export | Line |
|---|---|
| `LibraryObjectFilter` | 49 |
| `SubFramePreviewGroup` | 153 |
| `ImportCatalogMatch` | 220 |
| `ImportScannedSession` | 228 |
| `ImportScannedObject` | 236 |
| `ImportCommitObject` | 253 |
| `StackedImage` | 457 |
| `LibraryImagesPage` | 607 |
| `getLibrarySessionFiles` | 121 |
| `getLibraryIntegrationStats` | 125 |
| `triggerFolderImport` | 211 |
| `getSessionReportUrl` | 552 |
| `getLibraryImagesPage` | 625 |

**`src/lib/fits.ts`** (8 dead exports — note: `server/lib/fitsThumbnail.ts` has its own private copies of these functions; they are NOT imports)
| Export | Line |
|---|---|
| `FitsHeader` | 15 |
| `RgbPlanes` | 27 |
| `StretchParams` | 328 |
| `debayerBilinear` | 168 |
| `debayerSuperpixel` | 214 |
| `applyColormap` | 290 |
| `computeAutoStretch` | 349 |
| `applyStretch` | 405 |

**`src/lib/api/catalog.ts`** (5 dead exports)
| Export | Line |
|---|---|
| `CatalogObjectInfo` | 35 |
| `CatalogCacheStats` | 91 |
| `CatalogPrefetchStatus` | 108 |
| `getThumbnailUrl` | 5 |
| `startCatalogPhase` | 136 |

**`src/lib/api/storage.ts`** (5 dead exports)
| Export | Line |
|---|---|
| `SystemStorage` | 18 |
| `LibraryObjectStat` | 34 |
| `LibraryLocation` | 59 |
| `MigrationPhase` | 66 |
| `getMigrationStatus` | 92 |

**`src/lib/api/auth.ts`** (3 dead exports)
| Export | Line |
|---|---|
| `AuthStatus` | 4 |
| `AppUser` | 22 |
| `CurrentUser` | 31 |

**`src/lib/altaz.ts`** (2 dead exports)
| Export | Line |
|---|---|
| `AltAz` | 29 |
| `CurveSample` | 68 |

**`src/lib/visibilityCheck.ts`** (4 dead exports — entire file is effectively dead)
| Export | Line |
|---|---|
| `SKY_MAP_AZ_WIDTH_DEG` | 24 |
| `isEmptyMap` | 30 |
| `locateCell` | 47 |
| `isPointVisible` | 57 |

**`src/lib/nightWindow.ts`** (3 dead exports)
| Export | Line |
|---|---|
| `localMidnight` | 12 |
| `localDateKeyInTimeZone` | 76 |
| `dateFromKey` | 101 |

**`src/lib/api/settings.ts`** (2 dead exports)
| Export | Line |
|---|---|
| `DebugLoggingStatus` | 22 |
| `testConnection` | 18 |

**`src/lib/api/observations.ts`** (2 dead exports)
| Export | Line |
|---|---|
| `TleCatalogStatus` | 107 |
| `getCachedSatelliteResults` | 98 |

**`src/lib/bestImagingWindow.ts`** (2 dead exports)
| Export | Line |
|---|---|
| `MonthlyAltSample` | 12 |
| `BestImagingWindow` | 23 |

**`src/lib/api/catalogs.ts`**
| Export | Line |
|---|---|
| `CatalogProgress` | 24 |

**`src/lib/api/devices.ts`**
| Export | Line |
|---|---|
| `DeviceQrStatus` | 44 |

**`src/lib/api/plannedSessions.ts`**
| Export | Line |
|---|---|
| `PlannedSessionPatch` | 29 |

**`src/lib/api/planner.ts`**
| Export | Line |
|---|---|
| `PlannerResponse` | 81 |

**`src/lib/api/update.ts`**
| Export | Line |
|---|---|
| `UpdateStatus` | 3 |

**`src/lib/autoPlan.ts`**
| Export | Line |
|---|---|
| `AutoPlanParams` | 37 |

**`src/lib/catalogImage.ts`** (5 dead exports)
| Export | Line |
|---|---|
| `CatalogSourceId` | 80 |
| `CATALOG_IMAGE_WIDTH` | 15 |
| `CATALOG_IMAGE_HEIGHT` | 16 |
| `fovForSize` | 26 |
| `getCatalogMasterUrl` | 68 |

**`src/lib/dsoSearch.ts`** (2 dead exports)
| Export | Line |
|---|---|
| `SearchableEntry` | 14 |
| `getDisplayNames` | 87 |

**`src/lib/telescopePresets.ts`** (2 dead exports)
| Export | Line |
|---|---|
| `TelescopePreset` | 18 |
| `abbreviateTelescope` | 114 |

**`src/data/skyChartData.ts`**
| Export | Line |
|---|---|
| `ConstellationLabel` | 19 |

**`src/hooks/useSwipeDownToClose.ts`**
| Export | Line |
|---|---|
| `UseSwipeDownToCloseOptions` | 17 |

**`src/components/folderImport/ObjectReviewCard.tsx`**
| Export | Line |
|---|---|
| `SessionEdit` | 9 |

**`src/components/gallery/`** (5 dead exports across 4 files)
| Export | File | Line |
|---|---|---|
| `ImageCardProps` | `ImageCard.tsx` | 6 |
| `ImageViewerProps` | `ImageViewer.tsx` | 8 |
| `KenBurnsSlideProps` | `KenBurnsSlide.tsx` | 10 |
| `PlanetariumModeProps` | `PlanetariumMode.tsx` | 12 |
| `SlotAction` | `galleryReducer.ts` | 6 |
| `DISPLAY_MS` | `galleryUtils.ts` | 3 |

**`src/components/help/`** (3 dead exports)
| Export | File | Line |
|---|---|---|
| `HelpHubProps` | `HelpHub.tsx` | 25 |
| `Tone` | `HelpPrimitives.tsx` | 266 |
| `HelpReaderProps` | `HelpReader.tsx` | 22 |
| `hasArticleBody` | `HelpArticles.tsx` | 648 |

**`src/components/onboarding/`** (7 dead exports — entire props surface is dead)
| Export | File | Line |
|---|---|---|
| `OnboardingChromeProps` | `OnboardingChrome.tsx` | 6 |
| `OnboardingStep1Props` | `OnboardingStep1.tsx` | 3 |
| `OnboardingStep2Props` | `OnboardingStep2.tsx` | 23 |
| `OnboardingStep3Props` | `OnboardingStep3.tsx` | 14 |
| `OnboardingStep4Props` | `OnboardingStep4.tsx` | 14 |
| `OnboardingStepsProps` | `OnboardingSteps.tsx` | 8 |
| `StepState` | `stepReducer.ts` | 7 |
| `StepAction` | `stepReducer.ts` | 13 |

**`src/components/planner/`** (4 dead exports)
| Export | File | Line |
|---|---|---|
| `LibraryFilter` | `LibraryPanel.tsx` | 18 |
| `ALTITUDE_BAND_CHART_HEIGHT` | `AltitudeBandChart.tsx` | 363 |
| `PX_PER_HOUR` | `scheduleGeometry.ts` | 8 |
| `MIN_PX_PER_MINUTE` | `scheduleGeometry.ts` | 20 |
| `timeToY` | `scheduleGeometry.ts` | 42 |

**`src/components/settings/SettingsTabs.tsx`**
| Export | Line |
|---|---|
| `SettingsTabItem` | 11 |

---

## Squad Performance

| Squad | Findings | Status |
|---|---|---|
| ⚰️ Unused Export Squad | 110 dead exports | Done |
| 🏚️ Orphan File Squad | 2 orphaned files (329 lines) | Done |
| 💀 Comment Archaeology Squad | 0 | Clean |
| 🐛 Debug Artifact Squad | 0 | Clean |
| 📝 Stale TODO Squad | 0 | Clean |
| 🚫 Unreachable Code Squad | 0 | Clean |

---

## Key Patterns & Observations

1. **API type sprawl**: The `src/lib/api/` directory exports a large surface of types and functions that are defined for server parity but never consumed in the client. `library.ts`, `telescopes.ts`, and `catalog.ts` are the worst offenders.

2. **`fits.ts` duplication**: The client-side FITS processing functions (`debayerBilinear`, `applyStretch`, etc.) are duplicated verbatim in `server/lib/fitsThumbnail.ts` as private functions. Consider whether `fits.ts` should move to a shared location or be deleted from the client.

3. **`visibilityCheck.ts` entirely dead**: All 4 exports have zero importers. This file can likely be deleted outright.

4. **Onboarding props not consumed**: All 6 `OnboardingStep*Props` interfaces are exported but never imported — the onboarding components are consumed without explicit prop typing at the call site (likely relying on inference).

5. **`wishlist.ts` is a skeleton**: The wishlist feature exists in name only. Either it was started and abandoned, or it was built for a future sprint and the API layer was pre-written. Delete or move to a feature branch.

---

## Recommended Cleanup Order

| Priority | Action |
|---|---|
| 1 | Delete `src/lib/api/wishlist.ts` (entire dead module) |
| 2 | Delete `src/components/folderImport/FolderBrowser.tsx` (orphan) |
| 3 | Delete `src/components/ObjectPreview.tsx` (orphan) |
| 4 | Audit `src/lib/visibilityCheck.ts` — all exports dead, likely deletable |
| 5 | Prune unused type exports from `src/lib/api/` (library, telescopes, catalog, storage, auth) |
| 6 | Decide fate of `src/lib/fits.ts` — consolidate with server copy or remove from client |
| 7 | Remove unexported `Props` interfaces in gallery, help, onboarding, planner |

To reap the dead code when ready, review this report and run targeted deletions. No `--reap` flag is needed for what's here — all removals are straightforward.

---

*The Dead Code Reapers have completed their mission.*  
*112 findings catalogued. The living code now knows what it carries.*

🪦 **110 dead exports + 2 orphaned files identified** 🪦
