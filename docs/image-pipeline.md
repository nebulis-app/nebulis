# Image Pipeline

End-to-end reference for how catalog imagery flows from external sources, through the server cache, and out to every client (iOS, tvOS, web).

---

## 1. Architectural model — master + on-demand resize

There is **one master image per object**, downloaded once from the best available external source. Every thumbnail, tile, preview, and full-screen view is derived from that master at request time:

- **Master** = highest-quality source-resolution file. Streamed verbatim for full-screen views.
- **Resized** = Sharp-generated JPG at a specific pixel size, cached on disk after first generation. All grids/tiles/previews hit this cache.

Clients never download from external sources. The server is the single point that talks to NASA, Wikipedia, and CDS HiPS, then serves everything from `DATA_DIR/sky-cache/`.

```
external source ─┐
                 │ download once
                 ▼
        sky-cache/<master>           ─┐
                 │                    │ no ?w&h → stream master
                 │ Sharp resize       │
                 ▼                    │
        sky-cache/resized/<thumb>    ─┴─ with ?w&h → stream resized
```

---

## 2. External sources

| Source | URL pattern | Used for | Format |
|---|---|---|---|
| **CDS HiPS DSS2** | `alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS/P/DSS2/color&width=1920&height=1280&fov=…&ra=…&dec=…&projection=TAN&format=jpg` | Every catalog object (universal fallback) | JPEG |
| **NASA Hubble (Caldwell)** | Scraped from Hubble Caldwell catalog pages on the NASA CDN | C1–C109 (88 of 109 have imagery) | WebP |
| **Wikipedia REST summary** | `en.wikipedia.org/api/rest_v1/page/summary/<title>` (thumbnail URL inside response) | Catalog objects with a Wikipedia page (curated astrophotography) | JPEG |
| **NASA Image Library** | `images-api.nasa.gov/search?q=…&media_type=image` | Solar system objects (planets, moons, sun) | JPEG |
| **CDS Sesame name resolver** | `cdsweb.u-strasbg.fr/cgi-bin/nph-sesame/-ox/SNV?<name>` | RA/Dec resolution for objects not in the local OpenNGC catalog | XML (coords only, not an image) |

The server hits external services only during prefetch or on a cold cache miss. After that, every client request is a disk read.

---

## 3. On-disk cache layout

All paths under `DATA_DIR/sky-cache/`.

```
sky-cache/
├── hubble_<ID>.webp           ← NASA Hubble master (Caldwell objects)
├── wiki_<ID>.jpg              ← Wikipedia thumbnail master
├── <ID>_master.jpg            ← DSS2 master (1920×1280)
├── _sesame_cache.json         ← RA/Dec resolutions (not an image)
├── _geocode_cache.json        ← Reverse-geocode cache (unrelated)
└── resized/
    ├── <ID>_<W>x<H>.jpg          ← Sharp-resized thumbnail, aspect-preserving (default)
    └── <ID>_<W>x<H>_cover.jpg    ← Sharp-resized, center-cropped to fill exactly W×H (?fill=cover)
```

`<ID>` is normalized: uppercase, whitespace stripped, non-alphanumeric → `_`. Examples: `NGC4449`, `IC342`, `C21`, `M42`.

Three masters can coexist for the same object. The route picks them in priority order (Hubble → Wikipedia → DSS2). Resized thumbnails are source-agnostic — `<ID>_800x520.jpg` is whichever master got resized first. The `_cover` suffix marks variants generated with `fit: 'cover'` — they live in a separate cache slot from default `inside`-fit thumbnails so the two never collide.

**Constants** ([catalogPrefetch.ts](../server/lib/catalogPrefetch.ts)):

```ts
export const MASTER_WIDTH  = 1920;
export const MASTER_HEIGHT = 1280;
```

---

## 4. Setup & prefetch flow

Triggered from **Settings → Catalog & Display → Prefetch Catalog Images** (or the corresponding option in the onboarding wizard). Requires admin auth. The job is resumable — re-running skips items already on disk or already in the database.

### Scope: curated (default) vs full

`POST /api/catalog/prefetch/start?scope=curated` (default) or `?scope=full`.

| Scope | Phase 1 + 2 set | Object count | Disk usage |
|---|---|---|---|
| `curated` | Messier (110) + popular DSO list (~100) + every object in the user's library | ~250–600 typical | ~80–250 MB masters + ~60 MB thumbnails |
| `full` | Every entry in OpenNGC | ~14 000 | ~3–7 GB total |

Phase 3 (Caldwell) is always exactly the 109 Caldwell objects regardless of scope — small, well-defined, NASA Hubble imagery is high value.

The **popular DSO list** lives in [`popularDsoCatalog.ts`](../server/lib/popularDsoCatalog.ts) — a curated `Set<string>` of ~100 well-known NGC/IC objects that fall outside Messier and Caldwell coverage but show up on every "best DSO for smart telescopes" list (e.g. `NGC1499` California, `IC1805` Heart, `NGC7000` is Caldwell-covered so isn't in the list, etc.). Heavily biased toward narrowband-friendly emission nebulae and famous bright galaxies; deliberately excludes anything already pre-fetched as Messier or Caldwell to avoid redundant alasky hits.

Anything outside the curated set still works fine — it just does a single cold-cache live fetch on first view (~1–3 s) and is then cached forever. Curated keeps the install lightweight; full is for users who want a fully offline catalog.

### Three sequential phases ([`catalogPrefetch.ts`](../server/lib/catalogPrefetch.ts))

**Phase 1 — DSS2 masters.** For each in-scope entry:
1. Computes `fov` via `fovForEntry(majorAxisArcmin)` — scaled to object size, clamped to [0.3°, 3°].
2. Skips if `<ID>_master.jpg` already exists (still pre-warms thumbnails — idempotent).
3. Otherwise calls `prefetchSkyImage(id, { fov })` → fetches `1920×1280` JPEG from CDS HiPS, writes to `<ID>_master.jpg`.
4. **Pre-warms** all canonical thumbnail sizes from the master.
5. Concurrency: **3 workers** (alasky.cds.unistra.fr is slow).

**Phase 2 — Wikipedia.** Same iteration. For each:
1. Tries Wikipedia REST summary in this order: common name → catalog ID → spaced ID (e.g. "NGC 4274") → `Messier <n>`.
2. On a hit: stores extract + URL in the `catalogCache` SQLite table; if the summary includes a thumbnail URL, downloads it to `wiki_<ID>.jpg` and **pre-warms** thumbnails from it.
3. On miss: stores a `not_found` row so subsequent runs don't retry.
4. Concurrency: **5 workers**.

**Phase 3 — NASA Hubble Caldwell.** Iterates C1–C109 (109 objects). For each:
1. Scrapes the NASA Hubble Caldwell page for description, image URL, and canonical NGC/IC id.
2. Downloads the Hubble WebP and writes to **two paths**:
   - `hubble_<NGC-ID>.webp` (e.g. `hubble_NGC4449.webp`)
   - `hubble_C<num>.webp` (e.g. `hubble_C21.webp`)
3. **Pre-warms** thumbnails under both ids so the resize cache hits whether the client requests by NGC id or C-number.
4. Stores description in `catalogCache` under both ids.
5. Concurrency: **3 workers**.

### Pre-warming canonical thumbnail sizes

After every master is downloaded (or already exists on disk), Sharp generates the canonical thumbnail set into `sky-cache/resized/`:

| Size | Fit | Used by |
|---|---|---|
| 384×384 | inside | Web library / preview tiles |
| 600×400 | inside | iOS grids and planner sheets |
| 800×520 | inside | tvOS library tiles |
| 1920×1080 | **cover** | tvOS full-screen viewer (16:9, center-cropped from 3:2 master) |

Pre-warming is idempotent — if a size is already on disk it's skipped. Cost is small (~40–80 ms per master across all four sizes) and means the first user to render any view never pays the resize tax.

The `cover` variant is what makes Apple TV full-screen fill the screen edge-to-edge. The 3:2 master cropped to 16:9 loses ~100 px from the top and bottom — pure background sky, since the catalog object is centered in the frame by the FOV calculation.

### Status tracking
Persisted in the `catalogPrefetchStatus` SQLite row. Survives server restarts — a job killed mid-run is marked `cancelled` on next boot. Per-phase completion timestamps (`imagesCompletedAt`, `wikiCompletedAt`, `caldwellCompletedAt`) let the UI show partial progress.

---

## 5. Caldwell C-number aliasing

OpenNGC doesn't cross-reference C-numbers to NGC ids (except `C9` and `C41` which are natively stored as such). All other Caldwell objects appear in the user's library as `C21`, `C42`, etc.

[`caldwellToNgcId(id)`](../server/lib/caldwellCatalog.ts) returns the canonical NGC/IC equivalent or `null`:

```
C21  → NGC4449
C65  → NGC253
C80  → NGC5139   (Omega Centauri)
```

The `/:id/image` route resolves C-numbers once at the top of the handler. All cache lookups use the canonical NGC id, so there is exactly one master per object regardless of which alias the client requested.

---

## 6. Server request routing — `GET /api/catalog/:id/image`

Implemented in [`catalog.ts`](../server/routes/catalog.ts).

### Query parameters

| Param | Required | Effect |
|---|---|---|
| `w` | optional | Resized thumbnail width (clamped to 1920) |
| `h` | optional | Resized thumbnail height (clamped to 1920) |
| `fill` | optional | `cover` → center-crop the master to exactly W×H (used by tvOS full-screen for 16:9 fill). Anything else (or omitted) → default aspect-preserving `inside` fit. |
| `source` | optional | `hubble` \| `wiki` \| `dss2` → pin to a specific cached master, bypassing the default Hubble → Wikipedia → DSS2 priority. Used by the gallery image picker so users can choose which variant renders. Unknown values are ignored (default priority used). On a pinned-source cache miss, the server falls through to the rest of the priority list rather than returning 404. |
| `fov` | optional | Override DSS2 field of view (only used during cold-cache live fetch) |

**Without `?w=&h=`** → master mode. Streams the best master at its native resolution.

**With `?w=&h=`** → thumbnail mode. Returns a Sharp-resized JPG. Cache key is `<ID>_<W>x<H>.jpg` for `inside` fit (default) or `<ID>_<W>x<H>_cover.jpg` for `?fill=cover` — variants do not collide.

### Handler logic

```
1. Resolve Caldwell C-numbers to canonical NGC/IC id.

2. If thumbnail mode (?w&h):
     check sky-cache/resized/<ID>_<W>x<H>[_cover].jpg
     → if exists: stream + return  ✅ instant

3. Find best master:
     Default priority: hubble_<ID>.webp → wiki_<ID>.jpg → <ID>_master.jpg
     If ?source=X is set, that source is moved to the front of the
     candidate list; the others remain as fallbacks so a wiped pinned
     source still serves *something* rather than 404.

   For thumbnail mode: probe each candidate's intrinsic dimensions via
   `sharp(path).metadata()` and skip masters smaller than (w, h) in either
   axis. Prevents picking a tiny Wikipedia thumbnail when a 1920×1280 DSS2
   master is also available. Falls back to the smallest-known master only
   if nothing larger exists.

4. If no master found:
     live-fetch DSS2 at MASTER size (cold cache):
       - prefer DSO catalog RA/Dec
       - fall back to library DB
       - last resort: CDS Sesame name resolver
     write to <ID>_master.jpg
     master := <ID>_master.jpg

5. If still no master → 404 NOT_CACHED.

6. Master mode (no ?w&h):
     stream master verbatim + return.

7. Thumbnail mode (?w&h):
     await runResize(id, w, h, master.path, dest, fit):
       - acquires per-key in-flight lock (concurrent requests share one resize)
       - sharp(master.path)
           .resize(w, h, fit === 'cover'
             ? { fit: 'cover', position: 'centre' }
             : { fit: 'inside', withoutEnlargement: true })
           .jpeg({ quality: 85, mozjpeg: true })
           .toFile(sky-cache/resized/<ID>_<W>x<H>[_cover].jpg)
       - releases lock
       - schedules a throttled LRU prune of the resized cache
     stream resized file.
```

**`fit: 'inside'`** (default) preserves the master's full content — no cropping. The output may be smaller than the requested W×H in one dimension; clients should render with `.scaledToFit` (Swift) / `object-contain` (CSS) to letterbox the gap. This matters for astronomy: cropping to fill would chop off galaxy arms, nebulosity, and other real signal at the frame edges. Used by every grid/tile/preview.

**`fit: 'cover'`** (when `?fill=cover`) center-crops the master to exactly W×H. Used by tvOS full-screen so a 3:2 master fills a 16:9 TV without pillarbox bars. The catalog object sits in the center of the frame (FOV is computed around it), so the cropped strips are pure background sky. Cover variants get a `_cover` filename suffix and a separate cache slot.

**`withoutEnlargement: true`** (inside mode only) keeps small masters at their native size rather than upscaling and softening. A 300 px Wikipedia thumbnail asked for at 800×520 returns 300×whatever — clients render it as-is. Cover mode omits this — letterboxing a small master into a TV frame defeats the point of asking for a fill.

**`mozjpeg: true`** uses Mozilla's JPEG encoder for 5–15% smaller files at the same quality.

### Concurrency control — in-flight resize lock

Two simultaneous requests for the same novel `(id, w, h, fit)` share one Sharp invocation via `inflightResizes: Map<string, Promise<void>>`. The second caller awaits the first's promise. Without this, both would run Sharp in parallel and race on writing the output file — wasteful CPU and a potential corrupted-write hazard. The lock key includes the fit mode so `inside` and `cover` requests for the same `(id, w, h)` don't share the same in-flight slot.

### Resized-cache size cap

After every resize completes, `maybePruneResizedCache()` runs in the background (throttled to once per hour). If `sky-cache/resized/` exceeds **5 000 files** (~250 MB at typical thumbnail sizes), the oldest-accessed files are deleted until the count drops back under the cap. Uses `atimeMs` (last access time) so frequently-rendered tiles survive and rarely-touched test/debug sizes get evicted first.

### Negative cache
A 1-hour TTL `Map` (`negativeImageCache`) remembers IDs that returned `404` or `4xx` from CDS HiPS so we don't hammer the upstream service for known-missing objects. Network errors (timeouts) are not negative-cached — they're transient.

### `Cache-Control`
Every served image sets `Cache-Control: public, max-age=31536000, immutable`. Browsers and the iOS/tvOS image cache treat results as permanent.

---

## 6b. Per-source pinning — `GET /api/catalog/:id/sources` and `?source=`

The default master picker (`findMaster()`) walks Hubble → Wikipedia → DSS2 and returns the first hit. Most of the time that's exactly what you want — best quality available, automatic. But the gallery image picker exposes the choice to the user: a Caldwell object often has both a stunning Hubble portrait *and* a wider DSS2 plate, and the user may genuinely prefer one over the other for their library tile.

### Inventory endpoint

`GET /api/catalog/:id/sources` lists which masters are currently on disk for one object. C-numbers are canonicalized to NGC/IC ids first, same as the image endpoint.

```json
{
  "id": "NGC4449",
  "sources": [
    { "source": "hubble", "label": "NASA Hubble",     "sizeBytes": 248512, "width": 1280, "height": 1280 },
    { "source": "dss2",   "label": "CDS DSS2 Survey", "sizeBytes": 156890, "width": 1920, "height": 1280 }
  ]
}
```

Only sources that exist on disk are included — an empty array means nothing is cached yet for this object. Each entry has the dimensions Sharp read from the file header (no full decode), so the picker can show "1280×1280 · 245 KB" beneath each tile.

### Pinned image rendering

Once a source is chosen, the client renders `/api/catalog/:id/image?source=<source>&w=…&h=…`. The route's `findMaster()` moves the requested source to the front of the candidate list; the others remain as fallbacks so a wiped pinned source still serves *something* rather than 404.

### Persistence — sentinel encoding in `galleryImage`

The user's choice persists in the existing `galleryImage` column (no DB migration). Three valid forms:

| `galleryImage` value | Meaning | Render strategy |
|---|---|---|
| `null` | "Use catalog image" — server auto-picks best master | `getCatalogThumbnailUrl(id)` |
| `catalog-source:hubble` (or `wiki` / `dss2`) | User pinned a specific cached master | `getCatalogSourceThumbnailUrl(id, source)` → `?source=…` |
| `<folder>/gallery_<id>.<ext>` | **Custom upload** — written by the upload route at `<LIBRARY_DIR>/<folder>/gallery_<objectId>.{jpg,jpeg,png}`. Excluded from `getStackedImages()`, surfaced as a dedicated "Custom Upload" tile in the modal. | `getLibraryFileUrl(path)` |
| `<folder>/<file>.jpg` (other) | A telescope observation file the user picked from "Your Observations" | `getLibraryFileUrl(path)` |

The colon in `catalog-source:` makes it unambiguous against `LIBRARY_DIR` paths (which never contain colons). Client consumers (`ObjectPreview`, `ObjectDetail`, `GalleryImageModal`) call `parseSourceSentinel(galleryImage)` to discriminate; the server `gallery-image` route just passes the string through.

The two file-path forms (custom upload vs observation) are distinguished by the `gallery_` prefix — the modal uses `/\/gallery_/i.test(path)` to surface uploads as a separate tile rather than mixing them into the observations grid.

### Why sentinels and not a new column

Adding a `gallerySource` column would have been technically cleaner but required a schema migration, two migration paths (gallerySource vs galleryImage handling), and updates to every read path. The sentinel approach is one string-parse helper plus one URL-builder helper — small enough that adding a column would be over-engineering for the feature's scope.

### Edge case — auto-clear protection

The `gallery-image` GET route auto-clears `galleryImage` when `userSet=false` and a catalog image becomes available (self-heals stale fallback paths). Sentinels saved through the modal call `setGalleryImageUserChosen` which sets `userSet=true`, so this auto-clear never fires for pinned sources.

---

## 7. Sizing — what each client requests

The thumbnail size is a **per-platform constant**. Every grid/tile/preview on a given platform requests the exact same dimensions, so the resize cache hits on every render after the first.

### Web ([catalogImage.ts](../src/lib/catalogImage.ts))

```ts
export const CATALOG_IMAGE_WIDTH  = 384;
export const CATALOG_IMAGE_HEIGHT = 384;

getCatalogThumbnailUrl(id, fov?)  // → /api/catalog/:id/image?w=384&h=384[&fov=…]
getCatalogMasterUrl(id)           // → /api/catalog/:id/image
```

### iOS / tvOS ([APIClient.swift](../../seestar-apple/NebulisIOS/Services/APIClient.swift))

```swift
#if os(tvOS)
static let skySurveyThumbnailWidth  = 800
static let skySurveyThumbnailHeight = 520
#else
static let skySurveyThumbnailWidth  = 600
static let skySurveyThumbnailHeight = 400
#endif

skySurveyThumbnailURL(catalogId)   // → /api/catalog/:id/image?w=600&h=400  (iOS)
                                   // → /api/catalog/:id/image?w=800&h=520  (tvOS)
skySurveyURL(catalogId)            // → /api/catalog/:id/image  (master)
skySurveyFullscreenURL(catalogId)  // → /api/catalog/:id/image?w=1920&h=1080&fill=cover  (tvOS)
```

### Sizing rationale

| Platform | Use | Size | Fit | Reason |
|---|---|---|---|---|
| Web | Tile | 384×384 | inside | Square cards in library/gallery grids |
| iOS | Tile | 600×400 | inside | 3:2 landscape, fits all phone/iPad tile contexts at @2x |
| tvOS | Tile | 800×520 | inside | Matches the 400×260pt library tile at @2x |
| tvOS | Full-screen | 1920×1080 | **cover** | Center-cropped from the 3:2 master so it fills a 16:9 TV without bars |

Master is always native — no `?w&h` means the server streams whatever the source produced (Hubble webp at full res, Wikipedia at whatever Wikipedia gave us, DSS2 at 1920×1280). The iOS full-screen viewer keeps using the master with pinch-zoom; tvOS full-screen uses the cover variant since a TV can't pinch-zoom.

---

## 8. Per-client usage matrix

Where each call site lives and which URL helper it uses.

### Web

| File | Purpose | URL helper |
|---|---|---|
| `src/components/ObjectCard.tsx` | Library grid tile (400×400) | `getLibraryObjectThumbnailUrl` (server-resolved, see §9b) |
| `src/components/ObjectPreview.tsx` | Small object thumbnail (max-w-[192px]) | `getCatalogThumbnailUrl` |
| `src/components/GalleryImageModal.tsx` | "Sky Survey" option in the choose-image modal | `getCatalogThumbnailUrl` |
| `src/pages/ObjectDetail.tsx` | Header image (w-44 h-44) | `getCatalogThumbnailUrl` |

`ObjectCard` is the only web caller of the *object* thumbnail endpoint (`/api/library/objects/:id/thumbnail`); the rest hit the *catalog* endpoint directly. Web doesn't currently render a full-screen catalog image — `getCatalogMasterUrl` is exported for future use.

### iOS

| File | Purpose | URL helper |
|---|---|---|
| `Views/Object/ObjectDetailView.swift` (sky survey section, 200pt tall) | Object detail preview | `skySurveyThumbnailURL` |
| `Views/Object/ObjectDetailView.swift` (full-screen viewer) | Pinch-zoom full-screen | `skySurveyURL` (master) |
| `Views/Planner 2/PlannerTargetDetailSheet.swift` | Planner target sheet hero | `skySurveyThumbnailURL` |

### tvOS

| File | Purpose | URL helper |
|---|---|---|
| `Views/TVLibraryView.swift` (object tile) | Library grid tile | `libraryObjectURL(id, 800, 520, prefer)` — server-resolved object thumbnail |
| `Views/TVPlanetariumView.swift` | Planetarium hero (2048×2048) | `libraryObjectURL(id, 2048, 2048, prefer)` |
| `Views/TVSlideshowView.swift` | Slideshow item | `libraryObjectURL(id, 2048, 2048, prefer)` |
| `Views/TVObjectDetailView.swift` (hero, 700pt tall) | Object detail hero | `skySurveyURL` (master) |
| `Views/TVObjectDetailView.swift` (full-screen viewer) | Full-screen | `skySurveyFullscreenURL` (1920×1080 cover) |

iOS gallery list (`Views/Gallery/GalleryView.swift`, both grid card and list row) and every tvOS library/planetarium/slideshow tile go through `libraryObjectURL` — i.e. `/api/library/objects/:id/thumbnail` — so the **server's `resolveObjectImagePath`** is the single source of truth for which image represents an object. Earlier iOS bypassed this by reaching directly at `object.galleryImage` paths from the API payload, which silently broke for `catalog-source:` sentinels (treated as bogus file paths). See §9b for the resolver and §9c for the per-device source preference (`?prefer=…`).

---

## 9. Gallery image fallback (separate but related)

Each library object has an optional `galleryImage` column. Three valid forms (see §6b for full breakdown):

- `null` — "use the catalog image", server auto-picks best master
- `catalog-source:hubble` / `:wiki` / `:dss2` — user pinned a specific cached master
- `<folder>/<file>.jpg` — relative path to a specific observation or upload under `LIBRARY_DIR`

`GET /api/library/objects/:objectId/gallery-image`:

- If `galleryImage` is set → return as-is (the client discriminates path vs sentinel).
- If `galleryImage` is `null` and `hasCachedCatalogImage(id)` returns true → return `null` (UI renders the catalog thumbnail).
- If `galleryImage` is `null` and no catalog image exists → find the best observation file (telescope thumbnail → stacked frame → any image), persist it as `galleryImage`, return it. Triggers `prefetchSkyImage` in the background as a side-effect so future calls have a master available.

`hasCachedCatalogImage(id)` checks Hubble webp → Wikipedia jpg → DSS2 master in that order.

The user can override at any time via `GalleryImageModal`:
1. **Sky Survey → Auto** → sets `galleryImage = null` (UI shows catalog thumbnail, server auto-picks master).
2. **Sky Survey → NASA Hubble / Wikipedia / CDS DSS2** → sets `galleryImage = "catalog-source:<source>"` for whichever cached masters exist on disk for this object. One tile per source returned by `GET /api/catalog/:id/sources`.
3. **Custom Upload** → uploads file, stores as `<folder>/gallery_<objectId>.<ext>` and sets `galleryImage` to the relative path. The active upload (if any) is surfaced as a "Custom Upload" tile beside the upload button so the user can see and reselect it. Uploading again overwrites the file. **`userSet=true`** is set for uploads — the auto-clear logic in the gallery-image route (which clears non-user-set entries when a catalog image becomes available) will not touch them.
4. **Your Observations** → picks an existing telescope file in the object's folder. `gallery_*.{jpg,jpeg,png}` files are filtered out of this list — they belong to option 3.

### Library tile cache-busting

`getLibraryObjectThumbnailUrl(id, w, h, version?)` accepts a `version` argument that's appended as `?v=<version>` to the URL. `ObjectCard` passes **`object.galleryImageVersion`** (falling back to `object.galleryImage` for older payloads), so any change to the gallery selection — upload, source pin, observation pick, *or in-place overwrite of the same `gallery_<id>.jpg`* — changes the URL string and defeats the browser's `max-age=86400` cache on the thumbnail endpoint. The server ignores the `v` param — it exists purely so `<img src>` changes when the underlying source does.

`galleryImageVersion` is computed server-side in `getLocalObjects`: for real-file gallery images it returns `<path>@<mtimeMs>` so re-uploading bumps the mtime and the URL flips. For `catalog-source:` sentinels and null values, the bare `galleryImage` value is used (no file to stat).

---

## 9b. Object thumbnail resolver — `GET /api/library/objects/:id/thumbnail`

The endpoint that every web `ObjectCard`, every iOS gallery card, and every tvOS library/planetarium/slideshow tile hits. Distinct from the catalog endpoint in §6: catalog endpoint always serves a sky-survey image; this one serves whatever the user designated as the gallery image for the **library object** (which may *be* a sky-survey image, or a telescope capture, or a custom upload).

### Query parameters

| Param | Required | Effect |
|---|---|---|
| `w`, `h` | optional | Resize dimensions (clamped to [32, 1200], default 400×400) |
| `prefer` | optional | `sky` \| `seestar` — overrides the global `galleryImageSource` setting for this single request. iOS and tvOS pass this from their per-device toggle so each can independently prefer catalog vs telescope imagery without mutating shared server state. Unknown values fall back to the global default. |

### Resolver — `resolveObjectImagePath(objectId, prefer?)`

Priority, top to bottom:

1. **User-set per-object pick** (`row.userSet === 1` and `row.galleryImage` non-null). Wins regardless of `prefer` — explicit user choice on web is sticky.
   - If value matches `catalog-source:hubble|wiki|dss2`, resolve via `resolveCatalogSourceSentinel` to the corresponding cached master file (`hubble_<id>.webp`, `wiki_<id>.jpg`, `<id>_master.jpg`). Without this step, sentinels were silently dropped and the resolver fell through to default catalog priority — picker on web appeared to do nothing.
   - Otherwise treat as a relative path under `LIBRARY_DIR` and `existsSync`-check.
   - If neither resolves, log a warning (`[gallery] <id>: userSet galleryImage="…" did not resolve`) and continue down the chain so the user isn't shown a 404.
2. **Seestar preference branch** (`!preferSkySurvey && row.galleryImage`): same sentinel + path resolution as step 1, used when the device says `prefer=seestar` (or the global setting is `seestar`).
3. **Catalog priority** — `hubble_<id>.webp` → `wiki_<id>.jpg` → `<id>_master.jpg` from `sky-cache/`. First hit wins. Used when no per-object pick exists *or* when `prefer=sky`.
4. **Cold-cache live fetch** of DSS2 from CDS HiPS (one-time, persisted) if nothing was cached.
5. **Last-resort telescope fallback** — try `row.galleryImage` as a path again, even if sky-survey is preferred.

### Disk thumbnail cache key

```
sha = base64url("<srcPath>:<W>x<H>:<mtimeMs>")
```

`mtimeMs` is read from `fs.statSync(srcPath)` on every request. This matters for the in-place overwrite case — `gallery_<id>.jpg` keeps the same path forever, so without mtime in the key the same `.jpg` would be re-served indefinitely after a re-upload. With mtime, the key flips the moment the source bytes change.

`Cache-Control` on the response is `public, max-age=86400`, but Express's `sendFile` emits an ETag derived from the cached file. iOS's `ImageLoader` revalidates "permanent" images via `If-None-Match`, so a changed cached file produces a 200 (with new ETag) and triggers `[ImageLoader] 🔄 Permanent image updated for …, refreshing cache` — the device picks up the new image without a manual cache wipe.

---

## 9c. Per-device source preference — `?prefer=sky|seestar`

Web has the per-object `GalleryImageModal` for fine-grained picks. iOS and tvOS instead expose a single global toggle ("Sky Survey Thumbnails") because the apps are typically used on a single device by a single viewer who has one preference. The toggle is wired straight to the resolver via `?prefer=…` on every thumbnail request — there's no client-side override of which URL to fetch, just a hint to the server about which fallback to favor.

### Storage

| Platform | Property | UserDefaults key | Default |
|---|---|---|---|
| iOS  | `AppState.useSkySurveyThumbnail`   | `useSkySurveyThumbnail`    | `true` |
| tvOS | `TVAppState.useSkySurveyThumbnail` | `tv_useSkySurveyThumbnail` | `true` |

Separate keys → flipping iOS doesn't touch tvOS and vice versa. Neither writes to the server's `galleryImageSource` setting, so the web/global default is unaffected.

### Wire-up

Every tile that points at `/api/library/objects/:id/thumbnail` reads its platform's toggle and passes `prefer: useSkySurvey ? "sky" : "seestar"` through `libraryObjectURL`. Call sites:

- iOS: `ObjectGridCard.imageURL`, `ObjectListRow.imageURL` ([`Views/Gallery/GalleryView.swift`](../../seestar-apple/NebulisIOS/Views/Gallery/GalleryView.swift)).
- tvOS: `TVObjectTile.tileImageURL` ([`TVLibraryView.swift`](../../seestar-apple/NebulisTV/Views/TVLibraryView.swift)), and the `loadItems` builders in `TVPlanetariumView` and `TVSlideshowView`.

The toggle ID modifier (`.id("\(object.id)_\(useSkySurvey)")`) plus the changing URL ensures SwiftUI rebuilds the view when the toggle flips, so the new image appears immediately rather than after a cache eviction.

### Interaction with user picks

A per-object pick made on web (`userSet=1`, set via `setGalleryImageUserChosen`) wins regardless of `prefer`. The toggle only changes behavior for objects without an explicit pick — i.e. it controls the *fallback* lane, not the override lane. So users who curate specific images per object on web keep getting them on every device; users who don't curate get whatever their device-local toggle prefers.

---

## 10. Cache wipe & re-init

`DELETE /api/catalog/prefetch/cache` (admin-only) wipes:

- All `*.jpg` and `*.webp` files in `sky-cache/` (masters)
- All `*.jpg` files in `sky-cache/resized/` (thumbnails)
- The entire `catalogCache` SQLite table (Wikipedia extracts, NASA descriptions)

Leaves `_sesame_cache.json` and `_geocode_cache.json` alone — those are coordinate/location data, expensive to regenerate, and don't go stale.

The next prefetch run rebuilds masters from scratch. Resized thumbnails get regenerated on-demand the first time each client requests them.

---

## 11. End-to-end examples

### Example A — Cold install, curated prefetch, tvOS user opens M42

1. User runs curated prefetch from settings. Phase 1 downloads ~150 DSS2 masters including `M42_master.jpg` and pre-warms `M42_384x384.jpg`, `M42_600x400.jpg`, `M42_800x520.jpg`. Phase 2 downloads the Wikipedia thumbnail and pre-warms again. Phase 3 (Caldwell) doesn't touch M42 (not Caldwell).
2. User opens M42 detail. `TVObjectDetailView` requests `/api/catalog/M42/image` (master, no `?w&h`).
3. Server: master mode → finds `wiki_M42.jpg` (priority over DSS2) → streams. ~10 ms.

### Example B — Curated prefetch ran but user views NGC1234 (not in curated set)

1. NGC1234 isn't Messier, isn't Caldwell, isn't in user's library. No master on disk.
2. tvOS library tile uses `object.thumbnailUrl` (the SeeStar-pipeline thumbnail) — not affected.
3. User opens NGC1234 detail → `/api/catalog/NGC1234/image` (master mode).
4. Server: no master → cold-cache live fetch from CDS HiPS at 1920×1280 (~1.5 s) → writes `NGC1234_master.jpg` → streams.
5. User backs out, opens it again → master hit, instant.

### Example C — Web user views NGC4449 after curated prefetch

1. NGC4449 isn't curated by default… *unless it's in the user's library or someone added it as Caldwell C21.* Caldwell phase ran for C21 → wrote `hubble_NGC4449.webp` + `hubble_C21.webp` and pre-warmed thumbnails under both ids.
2. Web requests `/api/catalog/NGC4449/image?w=384&h=384`.
3. Server: thumbnail mode → `sky-cache/resized/NGC4449_384x384.jpg` exists (pre-warmed) → streams in ~5 ms.

### Example D — Two clients race on a novel size

1. Existing masters on disk for object X. No `X_900x600.jpg` cached.
2. iOS and tvOS both fire `/api/catalog/X/image?w=900&h=600` within 50 ms of each other.
3. Server: tvOS request enters first → resized cache miss → picks best master → calls `runResize(...)` → registers promise in `inflightResizes`.
4. iOS request: resized cache miss → picks best master → calls `runResize(...)` → finds the existing promise → awaits it.
5. Sharp runs once. When the file is written, both pipes unblock and stream the same on-disk file.
6. After completion, `maybePruneResizedCache()` schedules in the background — checks cap, no-ops if under 5 000 files or if pruned within the last hour.

### Example E — Master selection downgrades around a small Wikipedia thumbnail

1. Object Y has both `wiki_Y.jpg` (320×240) and `Y_master.jpg` (1920×1280).
2. tvOS requests `?w=800&h=520`.
3. Server: cache miss → `findMaster()` probes candidates:
   - `wiki_Y.jpg`: 320×240 — fails (320 < 800). Remembered as smallest fallback.
   - `Y_master.jpg`: 1920×1280 — passes both axes. Chosen.
4. Sharp resizes from the DSS2 master → 800×520 (fits inside 1920×1280) → caches → streams.
5. If only `wiki_Y.jpg` had been on disk (no DSS2), the fallback path returns it anyway and Sharp produces a 320×whatever output (no upscale). Better than nothing, honest about the source quality.

---

## 12. Function reference

| Function | File | Purpose |
|---|---|---|
| `prefetchSkyImage(id, opts)` | `server/routes/catalog.ts` | Download master from CDS HiPS / NASA. Writes to `<ID>_master.jpg`. |
| `imageCachePath(id)` | `server/lib/catalogPrefetch.ts` | Disk path for `<ID>_master.jpg` |
| `hubbleImagePath(id)` | `server/lib/catalogPrefetch.ts` | Disk path for `hubble_<ID>.webp` |
| `wikiImagePath(id)` | `server/lib/catalogPrefetch.ts` | Disk path for `wiki_<ID>.jpg` |
| `resizedImagePath(id, w, h)` | `server/lib/catalogPrefetch.ts` | Disk path for `resized/<ID>_<W>x<H>.jpg` |
| `hasCachedCatalogImage(id)` | `server/lib/catalogPrefetch.ts` | True if any master exists (Hubble/Wikipedia/DSS2) |
| `fovForEntry(arcmin)` | `server/lib/catalogPrefetch.ts` | Server-side FOV calculation (2.5× major axis, clamped) |
| `caldwellToNgcId(id)` | `server/lib/caldwellCatalog.ts` | C-number → NGC/IC alias |
| `POPULAR_DSO_IDS` | `server/lib/popularDsoCatalog.ts` | `Set<string>` of ~100 curated NGC/IC IDs added to the curated prefetch scope |
| `getCatalogThumbnailUrl(id, fov?)` | `src/lib/catalogImage.ts` | Web thumbnail URL builder |
| `getCatalogMasterUrl(id)` | `src/lib/catalogImage.ts` | Web master URL builder |
| `getCatalogSourceThumbnailUrl(id, source, w?, h?)` | `src/lib/catalogImage.ts` | Web thumbnail URL pinned to a specific cached master (`?source=…`) |
| `makeSourceSentinel(source)` | `src/lib/catalogImage.ts` | Build the `catalog-source:<source>` string stored in `galleryImage` |
| `parseSourceSentinel(value)` | `src/lib/catalogImage.ts` | Detect a `catalog-source:` prefix and return the source, else `null` |
| `getCatalogSources(id)` | `src/lib/api.ts` | Fetch the list of cached masters for one object (powers the gallery picker) |
| `fovForSize(arcmin)` | `src/lib/catalogImage.ts` | Client-side mirror of `fovForEntry` |
| `skySurveyThumbnailURL(id)` | `seestar-apple/NebulisIOS/Services/APIClient.swift` | iOS/tvOS thumbnail URL builder |
| `skySurveyURL(id)` | `seestar-apple/NebulisIOS/Services/APIClient.swift` | iOS/tvOS master URL builder |
| `skySurveyFullscreenURL(id)` | `seestar-apple/NebulisIOS/Services/APIClient.swift` | tvOS 16:9 full-screen URL builder (`?fill=cover`) |
| `resolveObjectImagePath(id, prefer?)` | `server/routes/library.ts` | Picks the source file for `/library/objects/:id/thumbnail` (userSet → preferred → catalog → fallback). See §9b. |
| `resolveCatalogSourceSentinel(value, resolvedId)` | `server/routes/library.ts` | Resolves `catalog-source:hubble\|wiki\|dss2` to the cached master file path, or `null`. |
| `getLibraryObjectThumbnailUrl(id, w, h, version?)` | `src/lib/api.ts` | Web object-thumbnail URL with `?v=<version>` cache buster (uses `galleryImageVersion`). |
| `libraryObjectURL(id, w?, h?, prefer?)` | `seestar-apple/NebulisIOS/Services/APIClient.swift` | iOS/tvOS object-thumbnail URL builder. `prefer="sky"\|"seestar"` toggles source preference per-device. |

---

## 13. Performance characteristics

| Operation | Latency | Notes |
|---|---|---|
| Master cache hit (any source) | ~5–15 ms | Disk read + stream |
| Resized thumbnail cache hit | ~5–10 ms | Disk read + stream |
| First-time resize from master | ~20–40 ms | Sharp `resize().jpeg()` |
| Cold cache live fetch (DSS2) | ~1–3 s typical, up to 60 s | CDS HiPS round-trip; alasky.cds.unistra.fr can be slow under load (timeout is 60 s) |
| Cold cache live fetch (NASA solar) | ~1–2 s | NASA API round-trip |
| Bulk prefetch (curated DSS2, ~250–600 objects) | 5–30 min typical | Concurrency 3; dominated by alasky response time |
| Bulk prefetch (full DSS2, ~14 000 objects) | 30–90 min | Concurrency 3, alasky is slow |
| Bulk prefetch (Wikipedia) | 5–15 min | Concurrency 5 |
| Bulk prefetch (Hubble Caldwell) | 1–3 min | 109 objects, concurrency 3 |

**Disk usage**

| Scope | DSS2 masters | Wikipedia thumbs | Hubble webp | Pre-warmed resized | Total |
|---|---|---|---|---|---|
| **curated** (default) | ~310 × ~250 KB ≈ 80 MB | ~210 × ~50 KB ≈ 10 MB | 88 × ~200 KB ≈ 20 MB | 4 sizes × ~310 × ~60 KB ≈ 75 MB | **~180–280 MB** |
| **full** | ~14 000 × ~250 KB ≈ 3.5 GB | ~10 000 × ~50 KB ≈ 500 MB | 88 × ~200 KB ≈ 20 MB | 4 sizes × ~14 000 × ~60 KB ≈ 3.4 GB | **~7–8 GB** |

Curated counts above assume Messier (110) + popular DSO list (~100) + a small library (~100). The resized-cache size grew when the tvOS 1920×1080 cover variant was added (3 sizes → 4); the cover variant is the largest pre-warmed size (~150 KB each), accounting for most of the resized growth.

Resized cache is capped at 5 000 files (~250 MB) regardless of scope — exceeded only if clients request many non-canonical sizes.
