# Changelog
## 1.4.1 (180) - July 11th, 2026
### New
- Added functionality to move Library to a Network Share via UNC path. (Settings -> Storage)
- Added Option to use Catalog Naming Scheme for on-disk folder structure, for example creating folder for C5 when running an import instead of IC342. This setting is NOT retroactive (Settings -> General -> Prefer Caldwell Naming).
- Import Files and New Observation windows now let you choose which telescope the files were captured with, so those sessions show up correctly in the calendar right away.

### Updated
- Added km/h option under Settings for Wind Speed (Settings -> General)
- Removed "Include FITS files" from library import option, stacked/processed FITS files are always imported. User has option to select import subframes from Import window.
- No longer rename Dwarf subframes if they are properly formatted. Those that do not contain a date field will be renamed to prevent conflicts.
- Enhanced Debugging (Settings -> Danger -> Debug Logging)

### Fixes
- Resolved bug where post upgrade "Install and relaunch" would only relaunch menu bar app and not back-end Node.js app, which caused pairing and connectivity issues.
- Async filesystem bug that locked Node process for 1+ minutes if mounted drive or Seestar was unavailable.
- Library mover process would fail at verifying migration due to Apple hidden ._DS file(s)
- New Observation was wiping the telescope tag off an object's other sessions every time you logged a new one.

## 1.4.0 (177) - July 3rd, 2026

### New
- Catalog — Review the entire Messier, Caldwell, and Herschel catalogs and track your progress through them. One-click button to create a plan for unimaged catalog items.
- QR code device pairing — connect a new Android or iOS device by scanning a QR code for easier setup.
- Planner: Share your plan — export tonight's schedule as an image card or copy a plain-text summary to paste anywhere.
- Planner: Copy from previous night — reuse last night's plan as a starting point for tonight.
- Added ability in Settings -> Appearance to toggle most top menu items on/off. 
- Added ability to share directly form an opened image.


### Updated
- Planetarium: music toggle — mute or unmute background music without leaving the slideshow.
- Planner: Plan My Night — Two-step wizard that picks objects based on tonight's visibility window, schedules them, and lets you preview the result before saving.
- .fit files rendering now in color!
- Sub-frame download filter — when combining and exporting subframes, you can now choose which type of subframe to export (LP Filter, IRCUT, etc).
- Planner has a fresh new look with updated colors and a cleaner layout.
- Added ability to pan within a zoomed in image using click/drag (before was only trackpad)
- Cleaned up some objects on the Oservation and Library Page (Moved Compare Function).

### Fixes
- Gallery type filters (Nebula, Galaxy, Cluster, etc.) now correctly show all matching objects — "Dark Nebula" appears under Nebula, "Spiral Galaxy" under Galaxy, and so on. 
- Re-importing an object no longer overwrites a custom folder name or brings back a previously deleted session.
- Fixed bug on Account/User page where admin could remove theirselves from being an admin. 
- Bug fixes, performance, and security updates



## 1.3.2 (157) - June 17, 2026

### Heads-up: your library object count may go down
- This release recognizes when the same target was captured under different catalog names and **merges them into a single object**. For example C30 and NGC 7331, SH2‑298 and NGC 2359, or "Lunar" and "Moon" used to appear as separate cards in some scenarios, now they're combined. As a result, your total object count can drop after updating.

- **Nothing is deleted.** All observations from the merged entries are combined under the one object, and their image files are moved into the canonical object's folder automatically on first launch (you'll see "moved … to …" lines in the server log). Folder names are also normalized (e.g. "NGC 7331" → "NGC7331"). This runs once at startup; if you don't see it take effect, fully quit and relaunch the app.

### New
- Cross-catalog object merging — the same object imported under different designations (Messier ↔ NGC/IC ↔ Caldwell ↔ Sharpless, plus Moon/Lunar and Sun/Solar) is now combined into one library entry instead of showing duplicate cards.
- "Also known as" — an object's detail page now lists its other catalog designations (e.g. NGC7000 shows C20, Sh2‑117).
- Smarter library search — searching a catalog name like "Messier", "Caldwell", or "Sharpless" lists every object you own in that catalog (so "Messier" now includes M81 even though it's named "Bode's Galaxy"); "messier 81" also works. Searching any single designation (e.g. C30) finds the object under its primary name (NGC7331) and vice‑versa.
- Planner timeline expanded - Timeline now spans sunset→sunrise (full dark window), with the astronomical dark period shown as markers rather than clipping to it.
- Timezone handling overhaul — Timezone data now flows consistently through planner, forecast, and all date/time displays.

### Bug Fixes
- Library/processed images — Processed images now move along with their observation when the observation is moved; per-session counts are cleaned up properly.
- Planner timeline precision — Snap interval reduced from 15 min → 10 min; default block duration changed to 60 minutes.
- Planner timeline width — Enforced a 10‑hour minimum timeline width so short dark windows don't compress the view into unusability.
- Planner object overlap — snapToGrid simplified by removing the unused nightStart parameter (part of the overlap fix).
- Weather forecast timezone — Forecast times now display in the observer's configured timezone (not the server's), derived from the Open‑Meteo API response instead of app-level settings.
- High-latitude / midnight sun — When astronomical darkness never occurs (e.g. northern summer), falls back to nautical twilight for forecast conditions and planner dark‑window calculations.
- SunCalc edge case — Guard against Invalid Date from SunCalc when computing forecast astronomical conditions.

## 1.3.1 (149) - June 12, 2026

### New
- Nightly Maintenance (Settings, General): the server runs upkeep tasks each night at a time you choose. Pre-caches Planner thumbnails for tonight's visible objects, checks for catalog pack updates, clears junk files from the library, and pre-warms the weather forecast. Each task has its own on/off toggle.
- "Run now" button next to the scheduled time to run the enabled tasks immediately.

### Updated
- Planner timeline extends across the full dark window and scales to your screen height for a clearer view of when objects are up.
- Favoriting an object now updates instantly instead of waiting on the server.

### Bug Fixes
- When the telescope or network share is offline, file operations now fail fast instead of hanging. Previously a bulk import against an offline host could stall on a timeout for every file.
- Planner objects no longer overlap the displayed time.

## 1.3.0 (142) - June 3, 2026

### New
- Planner tool: Object sky traversal simulation. Select an object in planner (click on i), hover across elevation to see how the object moves throughout sky.
- Library and Gallery: sort dropdown (Name, Latest/Oldest observation, Most sessions, Recently imported) with localStorage persistence.
- Dwarf Mini telescope support across the full stack (kind detection, walker, USB enumeration, FITS defaults, presets).
- Thumbnail pre-generation with concurrency and warmingThumbnails progress exposed to UI.
- Satellite catalog: 8 new Celestrak constellation groups (Kuiper, Qianfan, Planet, Iridium NEXT, Spire, cubesat, Globalstar, Orbcomm).
- Satellite catalog: archive range tracking (oldest/newest TLE snapshots) with UI status card in Settings.
- macOS Legacy Build (12.x).
- macOS Intel Build (13+).

### Updated
- Light*_.jpg files are no longer imported when "Sync sub-frames" is checked under telescope configuration on Seestar telescopes. *note* temporarily added option under Settings -> Danger to find and automatically delete pre-existing Light_*.jpg's.
- Re-arranged some menu items (Satellite TLE Data, Delete Database) for clarity.
- Backup status page: shows thumbnail generation progress.
- SMB transport validation: isDwarfKind() prevents adding SMB to Dwarf profiles (USB only); fixed missing profile variable in transport update route.
- Starlink TLE fetch: removed dead Celestrak URL (returns 403).

### Bug Fixes
- Folders with more than 2,000 items would fail to upload on the 2,001st item.
- On manual uploads/imports, do not import video files.
- Files larger than 200MB failed to upload.
- PlanCalendar: sessions grouped by calendar date, not evening key.
- Settings Danger section: text confirmation replaced with proper modal dialog.
- Fixed Planetary_Photo import parser bug. Individual planetary photos are now extracted into their own object folder.
- Fixed "Popular" catalog (bumped to v4) to fix "Moon" catalog entry which had Saturn as reference image.
- Fixed date parsing bug on images manually stacked in Seestar app.

## 1.2.1 (121) - May 31, 2026

### New
- Added link to full release notes on "version update" popup.

### Bug Fixes
- Fix Solar and Lunar imports from Seestar. They will now import correctly into library.
- Catalog pack now downloads automatically on first server startup.
- Fixed onboarding screen layout on low-resolution screens. Configuration elements no longer go off-screen. Restructured telescope setup screen for initial onboarding to optimize vertical screen real estate.

## 1.2.0 (104) - May 23, 2026

### (New) Choose where your library is stored
- Pick a folder on any connected drive (internal, USB, or external) to hold your imported images and sub-frames. Set it during first-time setup or later in Settings, Storage. The default location is unchanged.
- Moving an existing library copies every file to the new drive, verifies the copy, then switches over. Your original files are never deleted. After it finishes, the app shows the old location so you can remove that copy yourself once you have checked the new one.

### (New) In-app updates
- Check for and install updates from the menu bar (macOS), system tray (Windows), or Settings, General (web UI).

### (New) Pre-built catalog image packs
- Hubble, Caldwell, and popular DSS2 reference images are downloaded automatically after installation. No longer scraped one by one on first use, so catalog images appear immediately rather than filling in over time.
- Added Sharpless (SH2) catalog pack.

### (New) Import Process
- Importing from main library page now does a much better job at auto-discovering directory structure and auto mapping to sky object. New process is click import -> point to directory -> review mappings, complete import.

### (New) User account recovery
- Process to recover username/password if you have local access to the server. Documentation coming soon.

### (Fixes)
- SMB connection stability improvements.
- Dwarf telescope label was showing incorrect model.
- No longer rename FITS files on import from DWARF.
- Windows installer desktop .lnk creation versus .bat file launcher.
- FITS file thumbnails on observation page are now resized to actual thumbnails to reduce loading time.
- You can now set a processed image as the "primary" image for an observation.
- Satellite Identification for DWARF3 should default to using current location (LAT/LONG), versus trying to use OBS-LAT/OBS-LONG header from FITS file which is only available on Seestar.
- Added logic to hide "Seestar" section under Settings->Storage unless you have a Seestar added as a telescope.

## 1.1.0 - May 18, 2026

### (Updated) Planner Tool!
- Drag/Drop objects onto a timeline.
- Alerts for objects close to moon during observation period.
- Ability to configure visible sky to track object observability.
- Plan out future days.

### (Updated) Telescope management
- Moved library functions (what to import) under each telescope configuration in hardware.
- Seestar via USB support. Added selector for SMB and USB on telescope creation.
- Track Seestar with UUID written to .nebulis.dat file on root of Seestar drive. Allows for automatically linking a single telescope via USB AND SMB. Can be disabled in settings, but linking SMB and USB telescope will not be supported.
- Condensed telescope settings.

### (Updated) Backup Process
- Backup process now states which devices it is syncing from, and via what method (SMB or USB).
- Backup history reflects what device an object was synced from and via what method (SMB or USB).

## 1.0 (14) - May 14, 2026

### Library & Images
- Browse and search library of imaged astronomical objects.
- Object detail with catalog data, imaging history, and multiple processing variants.
- Filter by object type and constellation.
- Mark objects and images as favorites.
- Side-by-side image comparison with interactive slider.
- FITS file viewer with stretch/scaling controls.
- Image editor with crop, rotate, and brightness/contrast.
- Upload and store custom gallery images.
- Merge sessions from multiple nights into one observation.
- Download sessions as ZIP files.

### Import & Telescope
- Connect to ZWO SeeStar telescopes via SMB.
- Import from local folders or file uploads.
- Automatic background import on a configurable interval.
- Selective sync (JPGs, FITS, sub-frames, videos, thumbnails).
- Multiple telescope profiles (SeeStar S50/S30, Dwarf, custom).

### Observation Planning
- Tonight's targets sorted by altitude and visibility window.
- Real-time altitude curves for any object.
- Wishlist with priority levels and notes.
- Moon phase, twilight, and darkness window display.
- Custom horizon profile (36-point azimuth mask).
- Filter by constellation, type, and minimum altitude.

### Weather & Forecast
- 3-day hourly cloud cover, seeing, and transparency forecast.
- Night quality score with breakdown.
- Moon rise/set and usable darkness hours per night.

### Catalog
- Browse and search full Messier, NGC, IC, Sharpless, and Caldwell catalogs.
- Background prefetch of Wikipedia descriptions and sky survey images.
- Cross-reference between catalog and your library.

### Satellite Trail Detection
- Automatic satellite trail detection in FITS images.
- Per-image result caching with manual re-scan option.
