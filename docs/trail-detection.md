# Satellite Trail Detection & Identification

End-to-end reference for how a sub-frame goes from a raw FITS file on disk to "this trail is probably Starlink-1234, crossing at 22:14:38 UTC, moving 0.78°/s".

The pipeline is two independent halves that talk through a single REST endpoint:

1. **Trail detection**: image processing on the raw pixels. Says "yes there's a trail" and where it is.
2. **Satellite identification**: orbital mechanics against a TLE catalog. Says "here are the satellites that could have been there at that moment."

Either half can run alone. The web client uses both together when you click **Scan Trails** on a session.

---

## Plain English walkthrough

When you ask the server to scan a sub-frame:

1. **It looks at the picture for streaks.** The server reads the FITS file, removes the sky glow and any nebulosity (so only sharp features remain), masks out the stars, and then asks: "is there a long, thin, bright line anywhere in this image?" If yes, it records the line's angle, length, and position.

2. **It reads the FITS header for metadata.** When was the exposure taken? How long was it? Where was the camera pointing? Where on Earth was the telescope? What's the field of view? This information sits in standard FITS keywords (`DATE-OBS`, `EXPTIME`, `RA`, `DEC`, `OBS-LAT`, `OBS-LONG`, etc.). SeeStar fills these in automatically.

3. **It loads a snapshot of every known satellite.** The server keeps a local copy of the public TLE catalog from Celestrak (Starlink, ISS, OneWeb, weather sats, military, etc.), about 12,000 objects. For accuracy, it tries to use the catalog snapshot from the night the photo was taken, not today's. Older photos pull from a dated archive.

3. **It fast-forwards each satellite to the moment of the exposure.** For every satellite in the catalog, the server uses standard orbital mechanics (SGP4) to figure out exactly where that satellite was in the sky from the observer's location at the moment the shutter opened.

4. **It throws out everything that obviously couldn't have been there.** Below the horizon? Skip. In Earth's shadow (so it can't reflect sunlight)? Skip. Geosynchronous (way too far away to streak through a 0.7° field)? Skip. Too far from where the camera was pointing? Skip.

5. **For everything left, it simulates the actual exposure.** Steps every 0.2 seconds across the exposure window plus a small buffer. Records the satellite's path. If the path crosses the camera's field of view at some point during the exposure, this satellite is a candidate.

6. **It scores and ranks the candidates.** Lower score is better: passes closer to the center of the image, and crossings that fall *inside* the actual exposure window beat crossings that fall in the buffer. If a trail angle was detected in step 1, candidates whose direction of travel doesn't match (within 45°) are rejected entirely.

7. **It returns the top 10.** Plus, if nothing actually crossed the FOV but something passed within 5°, it returns those as "near-miss" candidates with a flag (useful when the satellite was technically off-frame but TLE drift could explain a real trail being a close uncatalogued object).

The result gets cached to disk so re-opening the modal is instant.

---

## How the pieces fit together

```
                       ┌─────────────────────────────┐
  POST /api/satellite/detect                         │
  { filePath }                                       │
                       │                             │
                       ▼                             │
  ┌────────────────────────────┐                     │
  │ readFile (local) or SMB    │                     │
  └────────────┬───────────────┘                     │
               │                                     │
               ▼                                     │
  ┌────────────────────────────┐                     │
  │ trailDetector.detect()     │  trailDetector.ts   │
  │   - parseFitsPixels        │                     │
  │   - downsample → 512       │                     │
  │   - subtractBackground     │                     │
  │   - createStarMask         │                     │
  │   - findTrailAngle         │                     │
  │   - validateTrail          │                     │
  └────────────┬───────────────┘                     │
               │                                     │
       trailDetected = false → return early          │
               │                                     │
       trailDetected = true                          │
               ▼                                     │
  ┌────────────────────────────┐                     │
  │ parseFitsHeader            │                     │
  │   DATE-OBS, EXPTIME,       │                     │
  │   RA, DEC, OBS-LAT/LONG,   │                     │
  │   FOCALLEN, XPIXSZ, NAXIS  │                     │
  └────────────┬───────────────┘                     │
               │                                     │
               ▼                                     │
  ┌────────────────────────────┐                     │
  │ satelliteCatalog           │  satelliteCatalog.ts│
  │ .loadCatalogForDate(obs)   │                     │
  │   nearest dated archive    │                     │
  │   (within ±7d) → 12k TLEs  │                     │
  └────────────┬───────────────┘                     │
               │                                     │
               ▼                                     │
  ┌────────────────────────────┐                     │
  │ satelliteTracker           │  satelliteTracker.ts│
  │ .identifySatelliteTrail()  │                     │
  │   for each TLE:            │                     │
  │     SGP4 propagate         │                     │
  │     horizon / shadow /     │                     │
  │       distance filters     │                     │
  │     0.2s path sampling     │                     │
  │     FOV cross check        │                     │
  │     trail angle match      │                     │
  │     score                  │                     │
  └────────────┬───────────────┘                     │
               │                                     │
               ▼                                     │
   { trailDetected, angle, length, endpoints,        │
     candidates: [...], nearMissFallback }    ───────┘
```

---

## Deep technical view

### Trail detection: `server/lib/trailDetector.ts`

The detector is **projection-based**, not edge-based. Edge detectors pick up nebulosity, star halos, and noise; a projection method targets the specific signature of a trail (long, thin, bright) directly.

#### 1. FITS parsing: `parseFitsPixels()`

Standard FITS reader: walks 2880-byte header blocks until it finds `END`, extracts `NAXIS1`, `NAXIS2`, `BITPIX`, `BZERO`, `BSCALE`. Decodes pixel data into a typed array based on `BITPIX`:

| BITPIX | Decode | Output type |
|---|---|---|
| 8 | unsigned byte × `BSCALE` + `BZERO` | `Uint8Array` |
| 16 | int16 BE × `BSCALE` + `BZERO` | `Float64Array` |
| 32 | int32 BE × `BSCALE` + `BZERO` | `Float64Array` |
| -32 | float32 BE × `BSCALE` + `BZERO` | `Float32Array` |
| -64 | float64 BE × `BSCALE` + `BZERO` | `Float64Array` |

SeeStar S30/S50 frames are typically `BITPIX = 16` integers with `BZERO = 32768` to encode unsigned via signed.

#### 2. Downsample: `downsample()`

Box-filter to ≤ 512 pixels on the longer side. For a 1920×1080 SeeStar frame this is **3.75× linear / 14× area reduction**. This isn't just performance: averaging the 3.75×3.75 box per output pixel improves S/N, and a real trail at ~3-5 px wide in source space becomes ~1 px in downsampled space, still clearly resolved as a peak in the perpendicular projection.

#### 3. Background subtraction: `subtractBackground()`

Tiled median: 64×64 px tiles, median per tile, bilinear interpolation back to full resolution, subtract. Removes nebulosity, gradients, and any large-scale structure, leaving small-scale features (stars, trails, noise).

Key property: tiles are large enough that a thin trail occupies < 5% of any tile's pixels (well below the median's 50% threshold), so the trail's brightness doesn't pull the local background up enough to suppress itself.

#### 4. Star masking: `createStarMask()`

This is the tricky step. A naive "mask everything > 5σ" approach also masks the trail (which is also > 5σ). The current implementation uses **connected-component shape analysis**:

1. Flood-fill (4-neighbor) every pixel above 5σ into connected components.
2. For each component, measure:
   - **Aspect ratio** = `max(bbW, bbH) / min(bbW, bbH)`
   - **Fill ratio** = `pixels / (bbW * bbH)`
3. Apply the shape filter:

| Component shape | Aspect | Fill | Action |
|---|---|---|---|
| Saturated star | ~1:1 | ~0.5–0.8 | Mask + brightness-proportional padding (3–12 px) |
| Diffraction spike pattern | ~1.5:1 | ~0.4 | Mask |
| **Satellite trail** | **≥ 6:1, often 20:1+** | **≤ 0.2** | **Skip: leave in residual** |
| Cosmic ray / hot pixel | tiny (< 4 px) | n/a | Skip |

The thresholds (`aspect ≥ 4` AND `fill ≤ 0.35`) sit comfortably between the star and trail regimes.

> Historical note: an earlier implementation masked every bright pixel and dilated by `intensity / sigma` radius. That fattened the trail's own pixels into mask blobs, erasing the trail before the projection search ran. Detection rate was effectively zero for typical Seestar trails. This was the single biggest correctness fix in the trail pipeline.

#### 5. Angle search: `findTrailAngle()`

Radon-like projection. For each angle θ ∈ [0°, 180°) in 1° steps:

1. Compute the perpendicular unit vector `(cos θ, sin θ)`.
2. For every **unmasked, positive-residual** pixel, project onto the perpendicular axis: `proj = (x − cx) * perpX + (y − cy) * perpY`.
3. Bin into 1-pixel bins. Each bin = mean residual brightness across all pixels at that perpendicular distance.
4. A trail at this angle would pile its light into one narrow bin. Compute the bin distribution's median and σ (via MAD). The peak's height above the median, divided by σ, is the **strength of evidence for a trail at this angle**.

Best angle wins. Below 5σ peak strength → no trail.

The 1° step is sufficient because trails are not infinitely thin: a real trail's projection peak spreads ±2–3° around the true angle, so a 1° search guarantees a bin within the peak.

#### 6. Validation: `validateTrail()`

Once we have a candidate angle, prove the trail is real:

1. Build the perpendicular profile (same projection, finer detail).
2. Find the **narrowest peak** above 2σ, *not* the tallest. M42's halo would be tall but wide; we want thin.
3. Measure FWHM of that peak.
   - **FWHM > 12 px** in the downsampled frame → reject. (Real Seestar trails downsample to FWHM 2–6 px.)
4. Project pixels within ±FWHM of the peak onto the line direction.
5. Find the longest contiguous run above background + 2σ. That's the trail length.
   - **Length < 10% of image diagonal** → reject. (Eliminates noise and small artifacts.)
6. Convert endpoints back to original-image coordinates (un-downsample by `1/scale`).
7. Compute confidence:
   ```
   confidence = clamp01(0.4 * lengthRatio + 0.3 * thinness + 0.3)
       where lengthRatio = trailLength / diagonal
             thinness    = max(0, 1 − fwhm/8)
   ```

#### Output shape

```ts
{
  trailDetected: true,
  angleDegrees: 47,
  lengthPixels: 1240,        // in original image coordinates
  midpoint: { x: 980, y: 712 },
  endpoints: [{ x: 580, y: 320 }, { x: 1380, y: 1104 }],
  confidence: 0.82,
  profileWidth: 3.4          // FWHM in downsampled coords
}
```

---

### Satellite identification: `server/lib/satelliteTracker.ts`

Given an observation (when, where, where-was-the-camera-pointing) and an optional trail angle, return the satellites that could have caused a trail.

Inputs (`ObservationParams`):

```ts
{
  timestamp: string;          // ISO UTC, from FITS DATE-OBS
  exposureSeconds: number;    // FITS EXPTIME
  observerLat: number;        // degrees, FITS OBS-LAT or SITELAT
  observerLon: number;        // degrees, FITS OBS-LONG or SITELONG
  imageCenterRA: number;      // degrees, FITS RA or OBJCTRA
  imageCenterDEC: number;     // degrees, FITS DEC or OBJCTDEC
  fovWidthDeg: number;        // computed from NAXIS × XPIXSZ / FOCALLEN
  fovHeightDeg: number;
  detectedTrailAngle?: number; // degrees, optional
}
```

#### Pipeline per TLE record

For every TLE record (typically ~12,000), run filters in order. Filters short-circuit: if any rejects, the candidate is discarded immediately (the cheap filters are first).

| Order | Filter | Threshold | Why |
|---|---|---|---|
| (a) | Parse TLE | `satellite.twoline2satrec()` | Skip malformed records |
| (b) | **Period** | period ≤ 130 min | Excludes geosync (~1436 min) and high-MEO/HEO; keeps LEO satellites that move fast enough to streak |
| (c) | SGP4 propagate to `observationDate` | non-zero position | TLEs occasionally fail to propagate |
| (d) | **Above horizon** | elevation ≥ 0 | Below-horizon satellites don't show up |
| (e) | **Sunlit** (`isIlluminated`) | not in Earth's shadow cone | A satellite in shadow can't reflect sunlight; you can't photograph it |
| (f) | **Angular distance pre-filter** | within `min(fovDiag/2 + 1.2°/s × duration, 15°)` of image center | Cheap great-circle test; skip far-away satellites before doing the expensive path sampling |
| (g) | **FOV cross check** (path sampling) | actually crosses the FOV rectangle at some point | Sample every 0.2s across `[exposure − 5s, exposure + 5s + duration]`; LEO moves ~1°/s, so 0.2s gives ~0.2° resolution |
| (h) | **Velocity** | ≥ 0.3°/s | Slower than that won't make a visible trail at typical exposure lengths |
| (i) | **Trail angle match** *(if trail angle was detected)* | difference ≤ 45°, mod 180° | The satellite's direction of motion must roughly match the trail's angle in the image |

The 5-second buffer on either side of the exposure window catches satellites that entered or exited the FOV partly during exposure (the FITS timestamp is the *start*, but the trail captures everything from open to close, so the buffer covers small TLE drift errors and clock skew).

#### Coordinate frames

This is the part that tripped me up for hours. Three frames in play:

- **ECI** (Earth-Centered Inertial): non-rotating, X axis toward vernal equinox. `satellite.propagate()` returns this.
- **ECEF** (Earth-Centered Earth-Fixed): rotates with Earth. Used to compute look angles from the observer's geodetic position.
- **Topocentric RA/DEC**: what we see from the ground. This is what we compare against the image center.

Conversion path:

```
satrec ──propagate──► ECI(sat)        ─┐
                                        │  obsEcf − rotate(gmst)
geo(obs) ──geodeticToEcf──► ECEF(obs) ──┴─► ECI(obs)
                                        
ECI(sat) − ECI(obs) → topocentric vector → atan2 → RA, DEC
```

Implemented in `eciToTopoRaDec()`. `gstime(date)` gives GMST (Greenwich Mean Sidereal Time) for the rotation.

Distance is great-circle (haversine), in `angularDistance()`.

#### Sun position & illumination: `getSunPositionECI()` and `isIlluminated()`

Low-precision solar position (~1° accuracy is plenty here): mean longitude + equation of center → ecliptic longitude → ECI x/y/z. Then for each satellite:

1. Angle between satellite vector and Sun vector (from Earth center).
2. If satellite is on the Sun-facing hemisphere (angle < 90°), it's lit.
3. Otherwise, check if it's outside Earth's shadow cone:
   ```
   shadow_angle  = π − asin(R⊕ / |Sun|)
   sat_radius    = asin(R⊕ / |sat|)
   illuminated  ⟺ angle < shadow_angle − sat_radius
   ```

This matters operationally: at 03:00 local during a Seestar session, half the sky is full of satellites that are physically there but unlit and therefore invisible. Skipping them dramatically narrows the candidate list and avoids false matches.

#### Scoring

```
matchScore = closestDist * 2
           + (withinExposure ? 0 : 5)
```

Lower is better. Two components:

- **Closest approach to image center**: strongest signal that this satellite was actually photographed. Doubled to dominate the tiebreaker.
- **+5 penalty if the closest approach falls outside the actual exposure window**: picks up satellites that crossed *during* the buffer instead of *during* the shutter open.

Sorted ascending, top 10 returned.

#### Near-miss fallback

If zero satellites cross the actual FOV but some come within 5° of the FOV center, return up to 5 of those with `nearMissFallback: true`. Use case: TLEs are typically accurate to a few hundred meters at the satellite's altitude, but for high-mileage ISS or very-recently-launched Starlinks the error can grow to a few arc-minutes after a few days. A genuine trail in your image might be from an object whose TLE was 0.5° off at that moment.

The UI shows these as "no confirmed match: these satellites passed nearby" rather than "Trail is X" so users don't over-interpret.

---

### TLE catalog management: `server/lib/satelliteCatalog.ts`

#### Sources

14 Celestrak GP API endpoints, one per group:

```
NORAD GROUP                 Reason
──────────────────────────  ────────────────────────────────────────
starlink                    The big one — most trails are Starlinks
stations                    ISS, Tiangong, etc.
oneweb                      Other LEO constellation
visual                      Naked-eye-visible bright sats
weather, resource, science  Imaging satellites, often bright
amateur, engineering        Cubesats and experimental
military                    Spy sats — often unannounced launches
geo                         Sanity coverage; mostly filtered by period
last-30-days               Recent launches not yet in groups
sup-gp.php?FILE=starlink   Supplemental Starlink (most-recent)
SPECIAL=gpz                Unclassified pre-launch
```

The `active` group is intentionally not used: Celestrak returns 403 on it.

After fetch, dedup by NORAD ID (a record can appear in multiple groups), write to `DATA_DIR/tle-catalog.json`, archive a dated gzip copy to `DATA_DIR/tle-archive/YYYY-MM-DD.json.gz`.

#### Cache lifecycle

- **Fresh cache**: 24h, re-read disk, no fetch.
- **Stale cache**: > 24h, fetch all groups, on success update cache + archive, on failure fall back to stale disk read.
- **Eager load on boot**: `loadCatalog()` runs on startup so the first user request doesn't pay the fetch cost.

#### Date-aware loading: `loadCatalogForDate(targetDate)`

Why it matters: TLEs drift. A Starlink TLE from yesterday won't accurately predict where it was three months ago. The propagation error grows roughly linearly with time-since-epoch, and after a few weeks can be many degrees off.

Logic:

```
if |now − target| < 3 days:
    return loadCatalog()                    // current TLE is fine
else:
    find archive file with min |archive_date − target_date|
    if min diff > 7 days: return null       // too stale, caller will warn user
    decompress and return
```

The route handler receives `null` as a signal that no archive within ±7 days exists, falls back to the current catalog, and sets `tleArchiveUnavailable: true` in the response so the UI can show "TLE accuracy may be degraded for this date."

Archives older than 1 year are pruned (`pruneArchives()`), keeping disk footprint bounded at ~365 × ~3 MB ≈ 1.1 GB worst-case.

---

## Failure modes and tuning

| Symptom | Likely cause | Where to look |
|---|---|---|
| Trail detector finds zero trails on a frame with obvious trails | Star mask was eating the trail before connected-component fix landed | `createStarMask()` aspect/fill thresholds |
| Trail detector reports false positives in heavy nebulosity (M42, M31) | Tile median doesn't fully suppress wide-field nebulosity; long thin nebula features can fool the projection | Tune `tileSize` in `subtractBackground()` or raise the line peak/σ threshold in `findTrailAngle()` |
| Trail detected, no candidates returned | Missing FITS headers (`DATE-OBS`, `RA`, etc.) or observation older than archive coverage | Modal shows `missingHeaders` array; check FITS file with `fitsverify` |
| Trail detected, only near-miss candidates | Satellite probably real but TLE drift > FOV/2 | Acceptable. UI labels these clearly |
| All candidates are wrong direction | TLEs are stale relative to the observation date | Archive coverage gap; modal sets `tleArchiveUnavailable: true` |
| Specific satellite known to have caused trail not in candidate list | Period filter (>130 min), velocity filter (<0.3°/s), or shadow filter at fault. Test by removing one filter at a time | Filter chain in `evaluateSatellite()` |

### Tuning knobs

If you find the detector misses a class of trail or scores wrongly:

- `MAX_DIM` in `downsample()`: higher = slower but better S/N for very faint trails
- Aspect/fill thresholds in `createStarMask()`: relax for very wide trails (long satellites with extended panels)
- Peak σ in `findTrailAngle()` (currently 5): drop to 4 for fainter trails, raise for fewer false positives
- FWHM cap in `validateTrail()` (currently 12 px in downsampled frame): raise for blurred / out-of-focus trails
- Velocity floor in `evaluateSatellite()` (currently 0.3°/s): drop for higher-altitude objects
- Trail angle tolerance (currently 45°): tighten for fewer candidates, loosen if PA conventions cause genuine matches to be rejected

---

## API surface

`POST /api/satellite/detect`

```ts
// Request
{
  filePath: string;           // relative to LIBRARY_DIR (or SMB absolute)
  skipCache?: boolean;        // default false — re-run even if cached
  identifyOnly?: boolean;     // default false — skip image processing,
                              //   use this for re-identifying after a TLE refresh
}

// Response (trail detected, full)
{
  trailDetected: true,
  angleDegrees: 47,
  lengthPixels: 1240,
  midpoint: { x: 980, y: 712 },
  endpoints: [{ x: 580, y: 320 }, { x: 1380, y: 1104 }],
  confidence: 0.82,
  profileWidth: 3.4,
  exposureStart: '2026-04-22T03:14:33Z',
  exposureSeconds: 30,
  candidates: [
    {
      satellite: 'STARLINK-31234',
      noradId: 58234,
      crossingTimeUTC: '2026-04-22T03:14:38.412Z',
      angularDistanceFromCenter: 0.18,
      velocityDegPerSec: 0.78,
      matchScore: 0.36,
      duringExposure: true,
      track: [/* RA/DEC samples every 0.2s */]
    },
    /* ... up to 10 ... */
  ],
  nearMissFallback: false,
  missingHeaders: undefined,        // populated if any required header was absent
  tleArchiveUnavailable: undefined  // populated if observation > 7d outside archive coverage
}

// Response (no trail)
{ trailDetected: false }
```

Other endpoints:

- `POST /api/satellite/results`: bulk fetch cached results by file paths
- `GET  /api/satellite/catalog/status`: TLE catalog freshness info
- `POST /api/satellite/catalog/refresh`: force re-fetch from Celestrak
- `DELETE /api/satellite/cache`: clear the per-file detection cache

---

## Why this architecture

A few decisions worth documenting:

**Projection > edge detection.** Edge detectors (Canny, Hough) are tuned for pixel-level transitions. Astrophotography is dominated by *gradients* (nebulosity, star halos, gradient gradients, scope optics) that these algorithms latch onto as "edges". A projection method targets the actual signature (long, thin, bright) directly.

**Connected-component star mask, not threshold mask.** The previous threshold-and-dilate approach is what most published tutorials describe and is exactly what you'd write first. It's also wrong for our use case because trails *are* bright. Shape-aware masking is the principled fix.

**SGP4 for propagation, not VSOP/JPL.** SGP4 is the standard model for TLE-based satellite tracking and is what every public tracker uses. Sub-arcminute accuracy is achievable for fresh TLEs; that's well below our FOV/2 of ~0.35°.

**Date-aware TLE archive.** Tracking a recent trail against today's TLEs works fine. Tracking last month's trail against today's TLEs gives wrong answers, sometimes confidently. The dated archive turns "what's overhead" into "what was overhead", which is the question we actually need to answer.

**Per-filter logging in `evaluateSatellite`.** The route doesn't return the per-filter stats, but the function tracks how many records were rejected by each filter. Add `console.log({belowHorizon, tooFar, periodFiltered, ...})` in `filterVisibleSatellites` if you're debugging "I expect satellite X to match but it doesn't show up": it'll tell you which filter killed it.
