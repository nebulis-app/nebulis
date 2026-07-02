# Architecture Audit — Nebulis Web Frontend

**Date:** 2026-06-25
**Audited path:** `nebulis-web/src/`
**Structure type:** React feature-folder (components/, contexts/, hooks/, lib/, pages/, types/, data/)

---

## Fortress Status: COMPROMISED

The codebase is well-organized for a React SPA of this size and shows good instincts throughout. No circular dependency graph cycles were found. The violations found are mostly WARNING-level structural debts that compound over time: one clear CRITICAL cross-layer import, several god components, and a pervasive `isDark` prop-drilling pattern that creates friction everywhere the settings feature touches.

---

## Violations by Severity

---

### CRITICAL

#### C-1 — lib/ imports from components/

**File:** `src/lib/planShare.ts`, line 15

```
import { formatHm } from '../components/planner/scheduleGeometry';
```

**Why it matters:** `lib/` is the dependency foundation of the project. Nothing below it should point upward to `components/`. This import inverts the dependency graph: `lib/planShare.ts` → `components/planner/scheduleGeometry.ts`. Any consumer of `planShare.ts` now transitively depends on the planner component folder, making the library non-portable and harder to tree-shake.

**Root cause:** `formatHm` is a pure date-formatting utility. It was defined in `scheduleGeometry.ts` (a component-folder file) because the planner was its first consumer. When `planShare.ts` needed it later, it reached up instead of moving the function down.

**Fix:** Move `formatHm` (and `hourTicks`, `secondsIntoHour` — all three are pure time utilities with no React/DOM dependencies) out of `scheduleGeometry.ts` into a new `src/lib/timeFormat.ts`. Update both `planShare.ts` and `PlannerPage.tsx` imports.

```
// New file: src/lib/timeFormat.ts
export function formatHm(d: Date, timeZone?: string): string { ... }
export function hourTicks(nightStart: Date, nightEnd: Date, timeZone?: string): Date[] { ... }

// src/lib/planShare.ts
import { formatHm } from './timeFormat';

// src/pages/PlannerPage.tsx
import { formatHm, hourTicks } from '../lib/timeFormat';
```

`scheduleGeometry.ts` retains the layout/geometry constants and functions (PX_PER_HOUR, computePxPerMinute, snapToGrid, etc.) that are planner-UI-specific.

---

### WARNING

#### W-1 — God Component: ObservationDetail (1826 lines, 27 useState, 10 useQuery, 4 useMutation, 6 useEffect)

**File:** `src/pages/ObservationDetail.tsx`

This is the largest file in the codebase by a significant margin. It simultaneously manages:

- Session file browsing with pagination (galleryPage, viewMode, galleryItems)
- Multi-step compare mode (compareMode, compareItems, compareModalOpen)
- Processed image CRUD (showUploadModal, pendingUploadFile, isDragging, deletingProcessedId, confirmDeleteProcessedId, settingGalleryId)
- Image editing (editorOpen, editorSrc)
- Satellite trail scanning (satelliteScanOpen)
- Sub-frame archive download with polling loop (archiveState, archiveAbortRef)
- Telescope reassignment with outside-click popover (showReassign, reassignWrapRef)
- Sub-frame deletion with confirm (confirmDeleteSubframes)
- Sub-frame grid sizing via ResizeObserver (subFramesVisible, subFramesRowRef)
- Session notes (notesModalOpen, existingNote)
- Reverse geocoding (locationName, via raw `.then()` in useEffect)
- Seven separate useQuery calls for observation, settings, telescopes, object info, processed images, telescope status, and image favorites

**Fix:** Extract the following as separate hooks. None require structural JSX changes — they just consolidate related state and side effects:

1. `useSubframesArchive(objectId, date)` — archive polling loop, archiveState, archiveAbortRef
2. `useCompareMode()` — compareMode, compareItems, compareModalOpen, toggleCompareItem, exitCompareMode
3. `useSubframesGrid(ref)` — ResizeObserver + subFramesVisible
4. `useTelescopeReassign(objectId, date)` — showReassign, reassignWrapRef, reassignMutation + keyboard/click listeners

Each of these hooks can live in a co-located `hooks/` folder under `src/pages/observation/` if the file is eventually split, or in a shared `src/hooks/` if they're general.

The raw `fetchLocationName().then(...)` in useEffect (lines 243–251) should be replaced with a `useQuery` call so it participates in the query cache and avoids the manual cancellation bookkeeping.

---

#### W-2 — God Component: ImageEditorModal (1137 lines, 43 hook calls)

**File:** `src/components/ImageEditorModal.tsx`

Combines canvas rendering, text layer management, crop interaction, pixel adjustment sliders, watermark preset load/save, and file upload into one component. Notably fetches watermark presets via raw `.then()` in a useEffect (lines 188–196) instead of `useQuery`, bypassing the cache and needing manual abort logic.

**Fix:**

1. Extract `useWatermarkPresets()` hook that wraps the fetch in `useQuery` — one line of benefit: automatic caching, no manual `cancelled` flag.
2. Extract `useCanvasEditor(imageUrl)` as a hook that owns imgRef, canvasRef, imgLoaded/Error state, and sizeCanvas — the canvas lifecycle is self-contained and currently inlined.
3. Extract `useTextLayers()` hook for textLayers, selectedId, and the sidebar sync logic.

These three extractions shrink the component to roughly 500 lines and make the canvas rendering logic independently testable.

---

#### W-3 — God Component: Settings sections with excessive `isDark` prop drilling

**Files:** All `src/components/settings/` section components, all onboarding step components

The `isDark: boolean` prop is threaded from `SettingsPage` down through six section components, each of which passes it further to sub-components, modals, and inner helper functions like `getInputClass(isDark)`, `getCardClass(isDark)`, etc. This creates a prop-drilling chain:

```
SettingsPage → GeneralSection → SoftwareUpdateCard → ChangelogModal → ...
Settings.tsx:86 → isDark={isDark} (passed to each section)
components/settings/ConnectionSection.tsx:125, 129, 136, 164, 206, 295, 484, 485 (8 further passdowns)
```

The same pattern appears in onboarding:
```
OnboardingSteps → OnboardingStep2/3/4 → OnboardingStorageChoice → ChangeLocationModal
```

Components like `LibraryLocationSection`, `ConnectedDevicesSection`, `UsersSection`, `DangerSection`, and `AccountSection` already call `useTheme()` in some places but accept `isDark` as a prop in their signature, creating inconsistency.

**Fix:** The `ThemeContext` is already available everywhere. For any component that only consumes `isDark` (not `setTheme` or `cycle`), remove the prop from the interface and call `useTheme()` directly. The `SettingsUI.tsx` helper functions (`getInputClass`, `getCardClass`, etc.) can become CSS class constants or use CSS custom properties instead of a boolean parameter.

Short-term: stop the drilling at the page boundary. `SettingsPage` calls `const { isDark } = useTheme()` once; section components should do the same rather than receiving it as a prop.

---

#### W-4 — Cross-feature coupling: `onboarding/` imports from `settings/`

**Files:**
- `src/components/onboarding/OnboardingStep2.tsx:18-19` — imports `DwarfLocalPathPicker` and `LocalPathPicker` from `../settings/`
- `src/components/onboarding/OnboardingStorageChoice.tsx:5` — imports `ChangeLocationModal` from `../settings/LibraryLocationSection`

**Why it matters:** The onboarding flow depends on internal implementation details of the settings feature. `ChangeLocationModal` is exported as a side effect from `LibraryLocationSection.tsx` (line 208), which is primarily a different component. If `LibraryLocationSection` is refactored, the onboarding breaks.

**Fix:**

1. Move `LocalPathPicker`, `DwarfLocalPathPicker`, and `ChangeLocationModal` to `src/components/ui/` or a new `src/components/storage/` shared folder.
2. Both settings and onboarding import from that shared location.
3. `LibraryLocationSection` no longer exports `ChangeLocationModal` — it imports it.

---

#### W-5 — Cross-feature coupling: `settings/SoftwareUpdateCard` imports from `help/`

**File:** `src/components/settings/SoftwareUpdateCard.tsx:7`

```
import { ChangelogModal } from '../help/ChangelogModal';
```

A settings component imports a modal from the `help/` feature folder.

**Fix:** `ChangelogModal` belongs in `src/components/ui/` or a dedicated `src/components/changelog/` folder that both settings and help can import from. Alternatively, lift it one level to `src/components/ChangelogModal.tsx` (already exists for several other modals at this level).

---

#### W-6 — `SyncSubframesContext` imports from `components/`

**File:** `src/contexts/SyncSubframesContext.tsx:3`

```
import { SyncSubframesModal } from '../components/SyncSubframesModal';
```

**Analysis:** This is a deliberate pattern where the context "owns" the modal and renders it as a portal. The context value exposes only `openSync()` — callers never import the modal directly. This is architecturally intentional (similar to a toast context owning its toast component).

**Severity reduced** — this is INFO rather than WARNING because:
- There is no cycle (SyncSubframesModal does not import SyncSubframesContext)
- The context exposing a thin interface (`openSync`) is the clean public API
- The pattern prevents consumers from needing to manage modal state themselves

If the project moves to a stricter layering model, the modal could be split from the context by having the context emit a custom event and a top-level provider mount the modal independently. But this is not urgent.

---

#### W-7 — `ObservationSummary` type is private, causing duplication

**Files:**
- `src/lib/api/observations.ts:4` — `interface ObservationSummary` (not exported)
- `src/pages/ObservationsCalendar.tsx:21` — `interface Observation` (local, identical shape)

The `ObservationsCalendar.tsx` file defines its own local `Observation` interface that mirrors the `ObservationSummary` shape in the API module, field-for-field. This happened because `ObservationSummary` was never exported.

**Fix:** Export `ObservationSummary` from `observations.ts` and have `ObservationsCalendar` import and use it directly.

```ts
// src/lib/api/observations.ts
export interface ObservationSummary { ... }
```

```ts
// src/pages/ObservationsCalendar.tsx
import type { ObservationSummary } from '../lib/api/observations';
// use ObservationSummary instead of local Observation
```

---

#### W-8 — `formatBytes` utility duplicated in 6 files

**Files:**
- `src/components/StorageDashboard.tsx:7`
- `src/components/CombineSubframesModal.tsx:38`
- `src/components/settings/LibraryLocationSection.tsx:14`
- `src/components/folderImport/ObjectReviewCard.tsx:273`
- `src/components/folderImport/FolderBrowser.tsx:182`
- `src/pages/BackupStatus.tsx:28`

All six implementations are identical (bytes → B/KB/MB/GB).

**Fix:** Add `formatBytes(bytes: number): string` to `src/lib/utils.ts`. Import from there in all six files.

---

#### W-9 — `catalogs.ts` missing from the `lib/api` barrel

**File:** `src/lib/api/index.ts` (missing `export * from './catalogs'`)

All API modules are re-exported from the barrel except `catalogs.ts`. The barrel exists — `ConnectDeviceModal` is the only file that uses it (`from '../../lib/api'`). The inconsistency means `catalogs` types and functions are only accessible via direct module path, and the barrel gives an incomplete picture of the API surface.

**Fix — option A (preferred):** Add `export * from './catalogs'` to `src/lib/api/index.ts`.

**Fix — option B:** Remove the barrel entirely since 113 of 114 import sites use direct module paths anyway. This removes the appearance of consistency without the reality. The single barrel consumer (`ConnectDeviceModal`) switches to a direct import.

---

### INFO

#### I-1 — `scheduleGeometry.ts` in `components/planner/` contains pure utilities

**File:** `src/components/planner/scheduleGeometry.ts`

The file mixes layout constants (`PX_PER_HOUR`, `PX_PER_MINUTE`) with pure time utilities (`formatHm`, `hourTicks`). As noted in C-1, the time utilities should move to `lib/`. The layout geometry constants and functions (`computePxPerMinute`, `snapToGrid`, `clampTime`, `rangesOverlap`, `yToTime`, `timeToY`) are legitimately planner-UI-specific and belong in `components/planner/`.

After the C-1 fix, `scheduleGeometry.ts` becomes a pure planner-layout module with no business logic — which is appropriate for a component subfolder.

---

#### I-2 — No barrel files in any component feature folder

**Missing index files in:**
- `src/components/catalogs/`
- `src/components/folderImport/`
- `src/components/gallery/`
- `src/components/help/`
- `src/components/onboarding/`
- `src/components/planner/`
- `src/components/settings/`
- `src/components/ui/`

Also missing: `src/contexts/`, `src/hooks/`, `src/pages/`

**Impact:** Every import path must reference the exact filename. Refactoring a filename requires updating every importer. No consistent public API surface for each feature folder.

**Fix:** The absence of barrels is not itself a problem if the project prefers explicit paths (which is a valid, increasingly popular choice with bundler-aware tree shaking). The issue is inconsistency: `lib/api/` has a barrel but nothing else does.

Either adopt barrels everywhere or remove the `lib/api/index.ts` barrel. The direct-import approach is simpler and avoids re-export churn.

---

#### I-3 — `WatermarkPreset` lives in `auth.ts`

**File:** `src/lib/api/auth.ts:52-70`

Watermark presets are a user preferences feature, not an authentication feature. They share an API file with login, logout, user management, and JWT handling only because the endpoint is user-scoped.

**Fix:** Create `src/lib/api/preferences.ts` for `WatermarkPreset`, `getWatermarkPresets`, `saveWatermarkPresets`, `getLastSeenVersion`, and `setLastSeenVersion`. Add it to the barrel. This is low-priority and purely organizational.

---

#### I-4 — `helpData.ts` lives in `components/help/`

**File:** `src/components/help/helpData.ts`

This is a 446-line static data and search module with no React or DOM dependencies. It exports data structures (`TOPICS`, `QUICK_ACTIONS`, etc.) and pure search functions (`searchArticles`, `allArticles`). Files like this typically live in `lib/` or `data/`.

**Impact:** Low. The file has no upward dependencies and doesn't pull anything from components. Its location in `components/help/` is arguably fine as co-location. No refactoring needed unless the help search logic is reused outside the help feature.

---

#### I-5 — Data fetching in leaf components is widespread but consistent

**Pattern:** ~154 `useQuery`/`useMutation` calls appear inside `components/`. Examples: `ConnectionSection`, `UsersSection`, `SyncSubframesModal`, `ObjectCard`, etc.

**Assessment:** This is React Query's intended usage pattern — components own their data needs without requiring a parent page to prop-drill data down. It is not a violation. The components are self-contained rather than being "pure presentation" components that must receive everything as props.

The distinction that matters is: do any components issue `useQuery` for data that is ALSO fetched by their parent, causing duplicate requests? A brief inspection shows the query keys match (`['telescopes']`, `['settings']`, etc.), so React Query's deduplication handles this transparently. No violation.

---

#### I-6 — `getFormatsDate` duplicated across 3 files

**Files:**
- `src/components/StorageDashboard.tsx:14` — `formatDate(dateStr: string | null)`
- `src/pages/ObservationsCalendar.tsx:823` — `formatDate(date: string)`
- `src/lib/planShare.ts:78` — `formatDate(date: Date, timeZone, long)` (different signature)

The first two have similar but not identical signatures. They could be consolidated in `src/lib/utils.ts` alongside `formatBytes`.

---

## Recommended Actions

### Immediate (blocks clean architecture)

1. **Fix C-1 (cross-layer import):** Move `formatHm` and `hourTicks` to `src/lib/timeFormat.ts`. Update `lib/planShare.ts` and `pages/PlannerPage.tsx` imports. This is a 20-line change.

2. **Fix W-7 (ObservationSummary export):** Export `ObservationSummary` from `observations.ts` and remove the duplicate local `Observation` type from `ObservationsCalendar.tsx`. Prevents type drift between the two.

3. **Fix W-8 (formatBytes):** Add to `lib/utils.ts`, remove the 6 duplicate local definitions.

### Short-term (reduce friction)

4. **Fix W-3 (isDark prop drilling):** Stop drilling `isDark` at the page boundary. Settings sections, onboarding steps, and sub-components call `useTheme()` directly. Remove the prop from their interfaces. Estimated ~30 call sites to update, but the change is mechanical.

5. **Fix W-4 (onboarding→settings coupling):** Move `LocalPathPicker`, `DwarfLocalPathPicker`, and `ChangeLocationModal` to a shared location. `src/components/storage/` or elevate them to `src/components/`.

6. **Fix W-5 (settings→help coupling):** Move `ChangelogModal` to `src/components/` root level (alongside other top-level modals).

7. **Fix W-9 (catalogs barrel gap):** Add `export * from './catalogs'` to `src/lib/api/index.ts`. One line.

### Long-term (architectural health)

8. **Address W-1 (ObservationDetail god component):** Extract `useSubframesArchive`, `useCompareMode`, `useSubframesGrid`, and `useTelescopeReassign` as custom hooks. The raw `fetchLocationName().then()` in useEffect should become a `useQuery` call. This is the highest-value refactor: the file at 1826 lines is a maintenance burden.

9. **Address W-2 (ImageEditorModal god component):** Extract `useWatermarkPresets`, `useCanvasEditor`, and `useTextLayers`. The raw promise fetch for watermark presets is a concrete bug risk — if the component unmounts during a slow load, the state updates hit an unmounted component (the `cancelled` flag mitigates this, but `useQuery` handles it automatically).

10. **Decide on barrel strategy:** Commit to either "all feature folders have index.ts" or "no barrels, all paths are direct." The current hybrid (only `lib/api` has a barrel, used by 1 of 115 importers) provides neither the discoverability of full barrels nor the simplicity of pure direct imports.

---

## Summary Table

| ID | Severity | File(s) | Issue | Fix Complexity |
|---|---|---|---|---|
| C-1 | CRITICAL | `lib/planShare.ts:15` | lib imports from components/ | Small |
| W-1 | WARNING | `pages/ObservationDetail.tsx` | God component, 1826 lines, 27 useState | Medium |
| W-2 | WARNING | `components/ImageEditorModal.tsx` | God component, 1137 lines, raw promise fetches | Medium |
| W-3 | WARNING | `components/settings/*`, `components/onboarding/*` | isDark prop drilling, 30+ call sites | Mechanical |
| W-4 | WARNING | `onboarding/OnboardingStep2.tsx`, `OnboardingStorageChoice.tsx` | onboarding imports from settings/ | Small |
| W-5 | WARNING | `settings/SoftwareUpdateCard.tsx:7` | settings imports from help/ | Small |
| W-6 | INFO | `contexts/SyncSubframesContext.tsx:3` | context imports from components/ | Intentional pattern — leave |
| W-7 | WARNING | `lib/api/observations.ts`, `pages/ObservationsCalendar.tsx` | ObservationSummary duplicated as local Observation | Tiny |
| W-8 | WARNING | 6 files | formatBytes duplicated | Tiny |
| W-9 | WARNING | `lib/api/index.ts` | catalogs.ts missing from barrel | One line |
| I-1 | INFO | `components/planner/scheduleGeometry.ts` | Pure time utils in component folder | Resolved by C-1 fix |
| I-2 | INFO | All feature folders | No barrel files | Decision needed |
| I-3 | INFO | `lib/api/auth.ts` | WatermarkPreset in wrong module | Low priority |
| I-4 | INFO | `components/help/helpData.ts` | Data module in component folder | Acceptable as co-location |
| I-5 | INFO | All components with useQuery | Data fetching in leaf components | Not a violation |
| I-6 | INFO | 3 files | formatDate partially duplicated | Address with W-8 |

---

*Audit performed by static analysis — file reads, import graph tracing, and line counts. No runtime profiling.*
