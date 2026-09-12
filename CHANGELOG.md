# Changelog
## Unreleased
### Fixes
- ZWO ASIAIR (Beta): light frames captured on a real ASIAIR were not recognized, because of how the device writes exposure time, temperature, and camera angle into the filename. Every frame from an affected import landed on a single undated, oddly-named object instead of being grouped by night. Filenames from a real ASIAIR are now read correctly.
- ZWO ASIAIR (Beta): an object with a multi-word name (for example IC 5146) did not match its catalog entry, because the name read from the filename kept underscores where the catalog expects spaces. It now matches correctly.

## 2.0.1 (254) - September 7th, 2026
### New
- Sky Forecast: the "Upcoming Nights" outlook now covers three nights instead of two. The third night is about three days out, so its card is dimmed to show it is less certain.
- macOS and Windows: "View Logs" in the menu bar (macOS) or taskbar (Windows) opens a live log viewer. Follow the server log as it's written, clear it, or save a copy to send with a support request. On Windows the viewer now opens right away and stays responsive while a large log streams in, reads and parses off the UI thread, and no longer re-checks the log path (which meant launching a helper process) on every refresh.
- Docker: set the `LIBRARY_DIR` environment variable to keep your image library on a separate disk or mount, apart from the database and settings. While it is set, the library location is fixed by the deployment and cannot be changed from the app. See the Docker README.

### Fixes
- Library location: added "Reset to default folder". If the drive or path your library lived on is gone for good, this points the library back at its built-in folder. Before this, a database copied from another machine could leave the library pointing at a path that does not exist on the new machine, with no way to fix it from the app.
- macOS: the app no longer opens the web UI window on its own every time the server starts.
- Observation location maps were blank in 2.0.0. They switched to Esri tiles, but the server's security policy still blocked that tile host. 
- System Log: the next and previous page arrows did nothing. Paging through the log works now.
- System Log: a settings change listed every setting name each time you saved, even the ones you didn't touch. It now lists only what changed.
- A telescope reached by name (for example seestar.local) that was powered off could hang status checks for up to half a minute and stall page changes while it did. Name lookups are now capped at 2 seconds, the last known address is reused, and only one check runs per telescope at a time.
- Saving Settings could hang when the service that names a location from its coordinates was slow or unreachable. It's capped at 5 seconds now and never holds up the save.
- The import history table grew without limit. Every background scan added a row per object even when nothing was imported. Empty scans no longer add rows, the old ones are cleared once on upgrade (real imports are kept), and anything past a year is trimmed nightly.
- Catalog image downloads from Wikipedia and NASA had no timeout, so one stalled server could freeze catalog prefetch until a restart. Each download is now capped at 20 seconds.
- A corrected catalog image pack could not fix an already-downloaded picture. When a pack is reissued with a fixed image, that image now replaces the old one instead of being skipped because a file was already there.

## 2.0.0 (253) - September 4th, 2026
### Important
- The Forecast menu bar item is now hidden by default as you can open the forecast from the Planner page no. You can re-add it Settings -> Navigation Bar.

### New
- Added ZWO ASIAIR support (beta): pick "ZWO ASIAIR (Beta)" when adding a telescope and connect over its network share or by plugging in its USB stick or microSD card. Autorun, Plan, and Live captures all land on one library object; darks, flats, and biases go to the archive, not the library.
- Added support for the Seestar S30 Pro and new Seestar S50 Pro.
- Added Sharpless to the Catalog library.
- New more comprehensive Help page with guides and screenshots and new About page (Settings -> About).
- System log for admins (Settings -> System Log): a searchable history of sign-ins, user changes, telescope/device changes, syncs, and settings changes.
- Guided Tour: Launches automatically on a new install. Replay it anytime from Help -> Start The Guided Tour.
- Dwarf: Archive viewer (Settings -> Telescopes) browses archived calibration folders and their aggregate size/count, with a path you can copy into external stacking tools.
- Dwarf: combined "RESTACKED" images now import as regular library objects, added automatically as processed images.
- Dwarf: Star Trails captures now import as their own library object.
- Gallery: added a telescope filter, matching Library.
- Database backups: Nebulis now snapshots its database automatically just before applying an update, so you can roll back without losing data. Manage backups, or make one yourself, at Settings -> Storage -> Backups; restore steps are in DOWNGRADE.md and a RESTORE.txt saved alongside them.


### Updated
- Planner: redesigned around picking a night. A two-week strip shows each night's forecast rating, Moon phase, and plan status; the schedule reads the weather forecast with a rating strip and per-hour popups, shows twilight/Moon shading and a live time marker, and turns empty stretches into fillable gaps.
- Planner: add a target with one tap and it's placed at its best free time automatically. Scheduled blocks now show the object's photo.
- Planner: now works properly on phone and tablet, with separate Targets and Schedule tabs. On iOS and Android the schedule's top block is a single quiet line (date, dark window, Moon, site) instead of a heavy floating card.
- Settings (iOS and Android): reorganized. Appearance is now one "Theme" menu, Observing Sites moved into Location, and the separate Gallery section is gone (its toggle lives in Library). Toggle explanations now sit behind (i) buttons instead of blocks of text.
- Object page: "more actions" now includes "Sync all sub-frames" (pulls every night's raw frames) and exporting all sub-frames into a single flat "lights" folder for tools like Siril.
- Object page: now centers on your best photo, with totals (observations, last shot, integration time, frames, processed versions), a Tonight panel (worth setting up? peak altitude, best months), and the ability to star a favorite.
- Sky Forecast: rebuilt around tonight: one score, the Moon at its real phase, a night ribbon covering twilight/clouds/Moon-up hours/visibility, a "best window" readout, and a cloud-cover trend for upcoming nights.
- Sky Forecast (iOS and Android): the hero leads with the current hour's score and verdict, falling back to tonight's outlook, and the best-window card now folds in Moon phase, illumination, and sunset/sunrise. Removed the rating legend, source credit, Moon rise/set line, stat cards, and the duplicated Moon percentage.
- Catalogs: more curated entries, search now matches any of an object's alternate catalog names, and descriptions come from one place, so Messier, Caldwell, and Herschel 400 all show a write-up right after import, even offline, instead of sometimes staying blank.
- Observations: opens on nights out, objects, and a clickable year chart. The calendar opens on your most recent night with each day's photo; removed the duplicate list that used to sit under it.
- Session page: now built around the photo you took, with object, sky conditions, and location shown directly instead of behind a Details tab. Adding an observation now opens in a popup instead of a separate page.
- Session page: a night that captured only video (lunar/planetary timelapse) now plays that video instead of showing "No images captured"; its card on the object page marks it as video instead of borrowing the object's photo.
- Star Trails sessions: hid actions that don't apply to them (Compare, Combine, constellation).
- Backup Status: rebuilt with a cleaner banner showing whether your library is current, last sync time, reachable telescopes, and recent activity, plus live progress/rate/time-left while syncing; each telescope card shows its last sync and whether it syncs on its own.
- Backup Status: a failed or cancelled sync gets its own panel with the full error. "Files left on the telescope" has an info button listing filenames a page at a time; "files belonging to deleted sessions" links to a restore list so the next sync brings them back.
- Image viewer: now matches the rest of the app (black stage in every theme, arrows on the image itself), sized to the picture instead of the screen, and shows processed images (not just raw frames) with more reliable FITS handling.
- Satellite trail detection and identification: now works correctly on wide-field and non-SeeStar rigs (ASIAIR, generic SMB telescopes), using the image's real plate scale and orientation from its FITS WCS header instead of assumptions sized for a SeeStar's narrow field, and searching the whole exposure instead of just its first instant.
- Maintenance: nightly maintenance is now one on/off switch, with a manual "run now" (Settings -> General).
- Library, Gallery, Catalogs, Observations, Planner, Sky Forecast, and Backup Status banners now have a deep-sky photography hero image behind them.
- Light mode reworked for better contrast throughout.
- Settings: completely redesigned, with better grouping, descriptions, and organization.

### Fixes
- The observation section tabs (Images, Subframes, Processed) no longer show a stray scrollbar to the right of the row.
- A FITS thumbnail that had not finished rendering, or failed to render, could stretch an invisible click target across the page and swallow clicks on other controls.
- An observation whose location was missing from the server response took the whole page down instead of showing no location.
- The top navigation bar's background was being painted behind other navigation regions on the page, including the changelog's version list.
- The sync details popup on the Backup Status page (the "i" icon on a sync history row) rendered as a broken full-screen black overlay instead of the standard dialog.
- The Southern Ring Nebula artwork was NASA's two-panel instrument comparison, so a white divider ran down the middle of any banner using it. It's now the NIRCam panel on its own.
- Some declination values (like -05° 23′ 28″) lost their arcminutes and arcseconds when displayed, showing -05° 00′ 0.0″ instead. Fixed on both the object and observation pages.
- The Moon on the Sky Forecast page drew every phase as its complement, so a 4% crescent showed as an almost-full disk. It now matches the reported illumination at every phase.
- The Observations year chart showed back/forward arrows even with nowhere to go. They now appear only when they lead somewhere.
- The telescope filter's icon overlapped its own label in Safari, which clamps padding on a native dropdown. The control no longer relies on that.
- The Moon's rise and set times were cut off on the Planner and Sky Forecast panels ("Sets 10:12 PM" showed as "sets 10:1"). They now have room and wrap instead of truncating.
- A new Moon was drawn with almost no edge, so it disappeared into the panel behind it on Planner and Forecast. It now carries a visible rim and sphere shading at every phase.
- An observation could show the wrong telescope (for example a SeeStar night labeled Dwarf). It's now read from the imported files themselves, which each record the scope that captured them, instead of a single per-night value that could go stale; existing mislabeled nights self-correct the next time the object is opened.
- The "Download" button on an object page now goes through a signed, expiring link instead of an open URL, so a whole-object export can no longer be pulled by anyone on the network without signing in.
- Planner (iOS and Android): the schedule used the phone's current GPS location instead of the observing site you set up, so the same night could differ by device. It now uses the site as the source of truth, matching web and Sky Forecast; GPS is only a fallback when no site has coordinates.
- The Sky Forecast could get stuck on "forecast unavailable" for up to an hour, most often right after the server started or woke from sleep, because an empty weather result was being cached and served to every client. Empty forecasts are no longer cached, the fetch retries quickly, and Retry now recovers immediately.
- Sky Forecast (iOS and Android): the hero's second line read "Tonight averages 72" with no unit (72 was the visibility score, not a temperature). It now shows the overnight temperature range and average cloud instead, and forecast temperatures throughout the app follow the Temperature Unit setting.
- The observation location map (Session page and Observations world map) showed a tile watermarked "API KEY REQUIRED" instead of the actual map, because the tile provider (CARTO) had locked its free basemap CDN behind a paid API key. Map tiles now come from Esri, which is free and requires no key.
- The satellite catalog download from CelesTrak timed out constantly. It was fetching about 20 separate lists on every server start, several of which CelesTrak rejects, which is the exact pattern CelesTrak blocks a server's IP address for (once blocked, every request silently times out for days). It now makes a single request, stops immediately if CelesTrak declines it, backs off for hours instead of retrying in a tight loop, and shows the reason in Settings -> Catalogs. A recent snapshot of the catalog now ships with the app, so trail identification works out of the box and keeps working through an outage.


## 1.5.2 (211) - August 9th, 2026
### Updated
- Folder picker: wider, shows more folders at once, no longer cuts off long paths.
- New Star and Comet filter chips, plus an Unknown chip for objects with no resolved type.
- Editing an object's type now suggests types already in your library as you type. You can still enter a new one.
- Deleted objects and observations are listed in Settings -> Storage -> Trash, where you can restore them to re-enable syncing.
- A processed image now becomes an observation's primary picture automatically (object page, calendar, observation page) instead of requiring manual selection. Applies only to browser-displayable formats (JPG, PNG, TIFF); XISF/FITS/PSD still show the stacked image.
- Gallery page: processed images now appear alongside raw ones (sparkle badge), with a "Processed only" toggle. Planetarium mode has the same toggle next to Favorites. Settings -> General can default either to on.

### Fixes
- Stacked images with long file names, most often from DWARF sessions, failed to load in the viewer with "This image could not be loaded."
- The image viewer's thumbnail strip now shows as many tiles as fit the screen, instead of a fixed count with a "+N" button.
- Objects typed "Star" were incorrectly filed under the Solar System filter.
- Editing an object's details didn't update the library grid or type filters until the next import.
- Objects that Wikipedia and SIMBAD can't resolve were looked up again on every server start and import, forever. Failed lookups now wait before retrying.
- The server no longer trusts a client-supplied IP header by default, which could bypass rate limiting and login lockout on the common setup with no reverse proxy in front. Opt in with `TRUST_PROXY=1` only if you run one.
- Two endpoints used for sub-frame download ZIPs skipped login entirely.
- Telescope online/offline status and cached file listings could bleed between two configured devices when one went offline.
- A folder import interrupted mid-copy (crash, power loss) could leave a stuck partial file that later imports mistook for a real one.
- A disk cleanup pass could delete a file an import was still writing, if the two overlapped.
- A one-off failure listing a telescope's files no longer aborts the whole import; it retries once first.
- Several actions failed silently with no feedback: deleting an object or observation, archiving/deleting/syncing a telescope, and saving or deleting a watermark preset. They now show an error message.
- The nightly catalog-pack and app auto-update checks could each run twice at once, risking a corrupted partial download. Both now run at most once at a time.
- Boot-time library repairs no longer delay the server from accepting connections.
- The admin API key is now encrypted at rest instead of stored in plain text.
- `GET /auth/me` now rejects a revoked device token or a token issued before a password change, matching every other authenticated endpoint.
- Reassigning a telescope's sessions to another one could leave the Gallery showing stale data.
- USB imports were capped at the same low concurrency tuned for SeeStar's weak SMB server. A locally mounted drive now downloads faster.
- A Dwarf session folder with an unparseable name silently became a garbage-named library object. It now logs a warning instead.

## 1.5.1 (208) - August 5th, 2026
### New
- Cancel a manual import or an automatic backup while it is running.
- TIFF images now get thumbnails and previews, so a Dwarf's img_stacked_all.tif appears in the grid instead of only as a download card.
- Sub-frame sync says "Already up to date" when every frame for the session is downloaded. It used to report no sub-frames found.

### Updated
- The SMB share name field accepts a folder inside the share, for example "Server/MyWorks". Windows, macOS, and Docker read it the same way.
- Folder uploads no longer need room for two copies. Each file leaves the temporary area as soon as it lands in your library.
- Import checks free disk space before it starts and says how much is needed, instead of filling the disk and failing partway through.
- Settings -> Storage shows how much space unfinished uploads are holding, with a button to free it (this is temporary for cleanup and will be removed in a future release)
- The subframes tray fills the row and says how many of the session's frames it is showing, instead of stopping mid-row with a "+N" tile.
- API endpoints are now rate limited.

### Fixes
- Observations: a session stored with one folder per session showed your default site as its location, on both the observation page and the map, even when the images recorded where they were taken. Imports since 1.5.0 use that folder layout, so most recent sessions were affected.
- Observations: conditions were fetched for your default site rather than where the images were actually taken. Affected sessions correct themselves the next time weather is refreshed.
- Observations: the location picker only offered saved observing sites, so an image taken somewhere you have not set one up looked like it came from a site you never chose. It now offers "From image data" and uses it when the images carry a location. Picking a site still overrides it, and you can switch back.
- Observations: the place name under the map showed only the city the first time you opened a location, then "City, State" on every later visit.
- Sub-frames are FITS only. A Dwarf writes a preview JPG beside every frame and both were counted.
- Sub-frame sync into a session-folder library saved a second copy of each frame at the object root instead of in the session folder. It also found nothing for objects whose catalog id differs from the telescope's folder name, for example "C 5" against IC342.
- Planner: an object your horizon profile blocks all night was reported visible from dusk.
- Folder import: two folders that resolved to the same name collapsed into one entry in the review step, so the session dates you chose for one of them were ignored.
- Device pairing: an approved pairing code stayed redeemable indefinitely instead of expiring.
- Gallery image and catalog paths are now checked for traversal, and slow filename matching patterns were tightened.
- Connection errors on a custom SMB share called it a telescope and gave advice about power and Wi-Fi, which does not apply to a NAS or a PC. They now say server and point at the address, the machine being on, and SMB sharing being enabled.
- The Hostname / IP Address field accepted anything, so "10.0.1.5/SeeStar/" saved without complaint and then failed every connection. It now takes a hostname or IP with an optional port and says which half belongs in which field. The server enforces the same rule, so onboarding and the API get it too.
- A cancelled or failed folder upload left its files behind for 24 hours, in one reported case 125 GB on the system drive. The space is freed right away now, and the unattended cleanup runs hourly against a 6 hour cutoff.
- Dwarf FTP logs in as "anonymous" with no password by default.
- Telescope connections read "Wi-Fi" or "USB" everywhere. A DWARF showed "FTP" on the Settings page and "Wi-Fi" on Backup Status for the same connection.
- The connection tag stayed lit after a telescope stopped responding, because it showed whether an address had been saved rather than whether the telescope answered. It now dims when the telescope goes offline.
- A DWARF with both Wi-Fi and USB listed only "1 USB" on its Settings row. Both are counted.
- Pasting a full smb:// address into the share name field reported "not reachable on the network", pointing at the telescope address when the share name was the problem. It now says which part belongs in which field and blocks saving until it is fixed.
- Windows: a share name that included a folder was rejected with "Path traversal detected" even when the folder was inside the share.
- macOS: a share that was already mounted, for example one you opened in Finder, failed with "SMB connection failed". Nebulis looked for the existing mount by an address that included the password, which the system mount list never contains. Mounts Nebulis did not create are also no longer unmounted at shutdown.
- macOS: connection errors say what went wrong. A missing folder, an already-mounted share, and a real network failure all reported "Connection failed".
- macOS: the SMB password was written to the server log in plaintext when a mount failed, because the system tool echoes its command line in the error. Passwords are removed before logging now. Delete logs/server.log if you would rather not keep the older entries.

## 1.5.0 (201) - August 2nd, 2026
### New
- DWARF telescopes can now import over Wi-Fi via their built-in FTP server.
- Observations: added a Map view showing where each observation was taken, from FITS GPS and manual site tagging.
- Moved .fit rendering for mobile clients server-side, for better performance.
- Processed Images now accepts XISF, FITS, PSD, XCF, and camera RAW alongside JPG/PNG/TIFF. Formats a browser can't preview get a download-only card. Upload limit raised to 2 GB.
- Observing Sites: define multiple locations, each with its own coordinates, minimum altitude, and sky mask. Switch sites from the Planner and Forecast pages, manage them in Settings, and retag past observations. Available on web, iOS, and Android. (Settings -> Sky -> Observing Sites)
- Import: added an "Archive everything" option that copies every file on the device as-is, folder structure and all, including sub-frames, rejected frames, logs, and unrecognized types. Files Nebulis can't display are still stored and downloadable (Settings -> Hardware -> Add/Edit Telescope).
- Library: new imports now give each session its own folder and keep the file names your telescope gave them, instead of sharing one folder per object with names rewritten to avoid collisions. A "Reorganize library" button converts existing objects to the new layout; files are moved, never deleted (Settings -> Storage -> Folder layout).

### Updated
- Observations: added a List view alongside Calendar and Map, showing every observation in one sortable table of object name, catalog id, and date. Unlike the calendar it is not limited to a single month.
- Observations: Share now matches whichever view you're on. Calendar still shares a branded month card; List shares the table as it's currently sorted (as an image or plain text); Map shares an image of the map you're looking at, tiles and site markers in the same place, size, and color as on screen.
- Observation page redesigned around tabs (Images, Subframes, Processed, Details) instead of stacked stat tiles and split panels. Images and Subframes now use the full page width, and capture info, conditions, and location live together under Details.
- Telescope sync now shows what it left behind and why (import settings, rejected frames, deleted sessions, unreadable Dwarf folders), live during the sync and saved to Sync History.
- Import no longer creates objects from non-observation folders (CALI_FRAME, DWARF_DARK, RESTACKED, etc.); the review screen shows how many were skipped.
- Object ZIP downloads now include your uploaded processed images, under a processed/ folder.
- Image viewer: zoom now works in real image pixels, so the percentage means what it says and a new 1:1 button shows one image pixel per screen pixel. Scroll wheel and trackpad pinch zoom toward the pointer, double-click toggles fit and 1:1, and the image can no longer be dragged off screen.
- Image viewer: added keyboard shortcuts (F to fit, 1 for actual size, + and - to zoom, Home and End for first and last, D to download) alongside the existing arrow keys and Escape.
- Image viewer: the header now shows what the frame actually is (object, sub count, exposure, filter, capture time, file size) with the filename underneath, instead of just the filename.
- Image viewer: images either side of the current one are loaded ahead of time, and the grid thumbnail fills the frame while the full image arrives, so navigating no longer shows an empty pane.
- Image viewer: the toolbar now wraps to its own row on phones instead of overflowing, and the thumbnail strip's "+N" markers are buttons that jump through long sub-frame lists.

### Fixes
- Compare and Download All now include every variant of an object (for example a Mosaic captured on a different night). Previously both only looked at the base object, so Compare could show the same observation on both sides and Download All could silently skip dates that only existed under a variant.
- Image viewer: deleting a processed image left it on screen with a dead thumbnail until you closed the viewer.
- Image viewer: deleting sub-frames down to the last remaining FITS file closed the viewer instead of showing that file.
- Image viewer: deleting a file did not refresh object file counts elsewhere in the app.
- Image viewer: arrow keys moved between images instead of adjusting the FITS stretch slider when it was focused.
- Image viewer: Escape closed the whole viewer while a delete confirmation was open, instead of dismissing the confirmation.
- Image viewer: the page behind the viewer scrolled, Tab moved focus into it, and screen readers were not told a dialog had opened.
- Image viewer: the "use arrow keys" hint sat permanently over the thumbnail strip and was unreadable in light mode. It now appears briefly and goes away.
- Sharing an image no longer opens a mail draft containing a network address that only works on your own network. It uses the system share sheet where available and copies the image or link otherwise.

## 1.4.2 (193) - July 18th, 2026
### New
- Import Files: choose "Folder on this computer" to import straight from a folder on the same machine running Nebulis, no browser upload needed.
- Import Files: drag in a folder that already lives on the computer running Nebulis and it's detected automatically. The primary action switches to importing it in place with no upload, and uploading the files stays available as a fallback.
- Added a setting to control how sessions that cross local midnight are grouped (Settings -> General -> Group sessions by observing night). An 11pm-1am session now counts as one night on the calendar by default; turn it off to go back to splitting by calendar date.
- Gallery: customize which filter chips show on the top row. Pick any object type or curated group to pin, or clear back to defaults.

### Updated
- Object page: when a session has a stacked FITS file but no stacked JPG, the stacked FITS now renders in the main image slot instead of showing "No stacked image".
- Folder import now reports how many files were skipped and why, instead of just showing a lower file count than expected.
- Imports run noticeably faster: downloads now pipeline instead of running one at a time, thumbnail generation happens in the background instead of blocking each file, and local/USB copies stream directly instead of loading the whole file into memory first.
- Enhanced Debugging (Settings -> Danger -> Debug Logging) now also captures telescope profile and import settings for easier troubleshooting.
- Import: Stacked FITS now selected to import by default, you can always disable on your telescope if you do not want pre-stacked FITs files imported from your telescope. 

### Fixes
- MacOS MenuBar App: fixed a red "Bootstrap failed: 5: Input/output error" message that could linger next to the green "Running" dot after an update. The service was actually running fine; the error was left over from a startup retry and now clears itself once the service is confirmed up. 
- Planner: sessions planned from Android could sort out of order compared to ones planned on web or iOS; timestamps now sort correctly regardless of which device created them.
- Planner: "Plan My Night" could mix a partial location override (latitude without longitude, or vice versa) with your saved location and place the plan at the wrong spot; it now requires both together.
- Import: one unreadable Dwarf session folder no longer stops the rest of that import run. The failure is logged against that object and the run continues.
- Import: closing the sub-frame sync dialog no longer cancels a different, unrelated import that happened to be running or waiting at the same time.
- Import: fixed the import lock getting stuck as "in use" after a failed import, which required a restart before you could import again. A watchdog now also clears any lock left stuck for more than 6 hours.
- Import: fixed a bug where certain import paths could overwrite session/telescope tags or bring back deleted sessions for objects the run never touched.
- Import: importing a single object without explicitly choosing a telescope no longer fails with "No telescope was selected" when the object already has one attached.
- Import: hardened file and path handling, a literal "%" in a filename or a malformed response from the telescope could previously cause an import to fail or write a file to the wrong folder.
- Telescope status: the "connected" indicator no longer turns green for a custom SMB share that answers on the network but can't actually be read. The indicator now reflects whether the last real access to the share succeeded, not just whether the host is reachable, so it stays consistent with what a sync will actually do.
- Import: a sync that fails to reach or read a share now writes the error to the normal log instead of only appearing with debug logging turned on. Previously an import could quietly pull nothing with no error in the log or an obvious sign of what went wrong.

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
