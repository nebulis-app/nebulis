# Nebulis: User Guide

---

## Overview

**Nebulis** is a self-hosted library and observing companion for smart telescopes and imaging rigs. It connects to your equipment over your home network or a USB cable, imports your captured images and data, and gives you a full set of tools to browse, analyze, plan, and archive your astronomy sessions.

Nebulis reads the folder layouts of **ZWO Seestar S30 and S50** (including the Pro models), **DWARFLAB Dwarf II, Dwarf 3, and Dwarf Mini**, and **ZWO ASIAIR**. It can also watch any folder shared over SMB or FTP, so captures from other rigs can join the same library.

### Key Benefits

- Browse all of your captured deep-sky objects in a visual gallery
- Review image quality metrics for every sub-frame you capture
- Plan future sessions with tonight's best observable targets
- Check weather and astronomical seeing forecasts before heading outside
- Upload your own processed images alongside the originals
- Track every session with notes, ratings, and equipment logs
- Download or archive your data by object or session

### Typical Use Cases

- Reviewing last night's images after an observing run
- Checking which objects are worth imaging tonight
- Comparing image quality between sessions of the same object
- Keeping an observing log with notes, seeing conditions, and moon phase
- Maintaining a wishlist of targets you plan to image in the future
- Archiving and organizing years of smart-telescope captures in one place

---

## Getting Started

### System Requirements

- A modern web browser (Chrome, Firefox, Safari, or Edge; current versions recommended)
- A supported device: a ZWO Seestar S30 or S50 (including the Pro models), a DWARFLAB Dwarf II, Dwarf 3, or Dwarf Mini, or a ZWO ASIAIR. Nebulis can also read any folder shared over SMB or FTP, or a USB-mounted drive
- Nebulis running on a computer or server that can reach the device
- **Seestar:** network file sharing (SMB) enabled on the device (enabled by default)
- **Dwarf:** the telescope's Wi-Fi active. Dwarf models share their storage over FTP rather than SMB, so the computer running Nebulis must be joined to the telescope's own Wi-Fi, or on the same network as the telescope if you use station mode
- **ASIAIR:** reach its storage over SMB, or plug its USB drive into the computer running Nebulis. ASIAIR has no FTP server

> **Note:** Nebulis is a self-hosted application. It runs on a computer you control, not in the cloud. Your images never leave your local network unless you choose to download and share them yourself.

### Accessing the Application

1. Open your web browser.
2. Navigate to the address of the computer running Nebulis (for example, `http://192.168.1.100:8080` or a hostname such as `http://nebulis.local:8080`).
3. The address will be provided by whoever set up the application on your network. If you set it up yourself, check the terminal or server log for the URL.

### Creating an Account / Signing In

**First-time setup:**

When no user account exists yet, Nebulis runs in open mode and lets you get started immediately. An onboarding prompt will appear, guiding you to create the first (admin) account.

1. Enter your **email address**, **username**, **display name**, and a **password**.
2. Click **Create Account**.
3. Your account is now the administrator account.

**Signing in (returning users):**

1. Click **Sign In** on the login screen.
2. Enter your **username** and **password**.
3. Click **Sign In**. You will remain signed in for 30 days before needing to log in again.

**API key access:** If your administrator has configured an API key for automated access, you do not need a personal account. Contact your administrator for details.

---

## Main Features

---

### Library

**What it does:** Displays all of your imaged deep-sky objects as a visual card grid. Each card shows the object's best image, name, type, constellation, and how many sessions you have for it.

**When to use it:** As your home screen, to get a quick overview of your entire library and navigate to any object.

**Step-by-step:**

1. Go to the home page (`/`) or click **Library** in the navigation menu. The object gallery loads automatically.
2. Use the **search bar** to find an object by name (for example, "M31" or "Andromeda").
3. Use the **filter panel** to narrow results by object type (Galaxy, Nebula, Star Cluster, etc.).
4. Click the **heart icon** on a card to mark it as a favorite. Click the favorites toggle to show only favorites.
5. Click any card to open the **Object Detail** page for that object.

---

### Object Detail

**What it does:** Shows everything about a single imaged object: all sessions, files, catalog information, quality scores, and your personal notes.

**When to use it:** After selecting an object from the gallery, when reviewing a specific target in depth.

**Step-by-step:**

1. Click any object card in the Library to open its detail page.
2. The top section shows the **object's best image**, catalog data (type, constellation, magnitude, distance), and any Wikipedia description.
3. Scroll down to see a list of all **imaging sessions** for this object, organized by date.
4. Click a session row to open the **Observation Detail** page for that session.
5. Use the **Notes** tab to read or add personal observing notes for this object.
6. Use the **Quality** tab to view an aggregated sub-frame quality dashboard.
7. Use the **Compare** tab to open a side-by-side comparison of images from different sessions.

---

### Observation Detail

**What it does:** Provides a full inspection of a single imaging session, including every file captured, image quality metrics, weather data, and your session log.

**When to use it:** After an observing run, to review what you captured, check quality, add notes, or manage individual files.

**Step-by-step:**

1. Open an object, then click a session date to enter Observation Detail.
2. The **file list** shows every image, FITS file, and thumbnail from that session.
3. Click any image to open the **FITS viewer**, where you can adjust stretch and contrast to inspect the raw data.
4. The **Quality** panel shows per-file scores (Excellent, Good, Fair, Poor, Bad) based on HFR, FWHM, and star count.
5. The **Weather** panel shows cloud cover, seeing, and transparency logged for that night.
6. Click **Add Notes** to write a session log: record the Bortle class, seeing, transparency, moon phase, equipment used, and freeform comments.
7. Use the **Upload Processed Image** button to attach your own processed version (from PixInsight, Photoshop, etc.) to this session.
8. Use the **Download** button to download the session's files as a ZIP archive.
9. Use the **Delete** icon on individual files to remove unwanted sub-frames.

---

### Gallery (Slideshow)

**What it does:** Displays your entire image library as a full-screen animated slideshow with crossfade transitions and Ken Burns zoom effects.

**When to use it:** To showcase your library, or simply to enjoy your images in a cinematic presentation.

**Step-by-step:**

1. Click **Gallery** in the navigation menu.
2. The slideshow starts automatically. Each image is displayed for approximately 9 seconds with a 2.5-second crossfade.
3. Use the **shuffle** button to randomize the order.
4. Click the **heart** icon on any slide to favorite that object.
5. Use the **zoom** controls to adjust the image display size.
6. Hover over an image to see its **metadata overlay** (object name, type, constellation, session date).

---

### Observations Calendar

**What it does:** Displays a chronological timeline of all your imaging sessions, organized by object and date.

**When to use it:** To see what you observed on a specific date, or to review your observation history over time.

**Step-by-step:**

1. Click **Observations** in the navigation menu.
2. Browse the calendar or timeline to find sessions by date.
3. Click any session entry to open its **Observation Detail** page.
4. Use the date navigation controls to move between months or weeks.

---

### Planner

**What it does:** Calculates and ranks the best deep-sky objects to image **tonight**, based on your location, current sky conditions, and your telescope's field of view. Also lets you manage a wishlist of future targets.

**When to use it:** Before an observing session, to decide what to point your telescope at.

**Step-by-step:**

1. Click **Planner** in the navigation menu.
2. Make sure your observer location is set in **Settings** (latitude, longitude, timezone). The planner requires this to calculate object positions.
3. The **Targets** tab shows tonight's best objects, ranked by a composite score that considers:
   - Maximum altitude above your horizon
   - Total visibility window (how long it is above your minimum altitude)
   - Brightness (magnitude)
   - How close to midnight transit the object peaks
   - Angular size fit for your telescope's field of view
   - Moon illumination impact
4. Click any target row to see its rise/set times, current altitude, and an altitude curve graph.
5. Objects you have already imaged are flagged; wishlist items are highlighted.
6. Switch to the **Wishlist** tab to view, add, or remove saved targets.
   - Click **Add to Wishlist** on any target.
   - Set a **priority** (High, Medium, or Low) and add personal notes.
   - Remove items when you have imaged them.

---

### Forecast

**What it does:** Shows a multi-day weather and astronomical seeing forecast for your location, including hourly and nightly visibility ratings.

**When to use it:** To decide whether tonight (or the next few nights) is worth going out to observe.

**Step-by-step:**

1. Click **Forecast** in the navigation menu.
2. Review the **nightly summary** for each of the next three days. Each night is rated: Ideal, Great, Good, Fair, Poor, or Bad.
3. Expand a night to see **hourly breakdowns** showing:
   - Cloud cover percentage
   - Astronomical seeing (scale of 1–5, where 5 is best)
   - Atmospheric transparency
   - Moon illumination and phase
4. The forecast draws data from 7Timer (seeing/transparency) and Open-Meteo (weather). An internet connection is required for forecast data.

> **Tip:** "Seeing" refers to atmospheric steadiness, not cloud cover. A clear night with poor seeing will still produce blurry stars. Aim for nights rated 3 or above on the seeing scale.

---

### Quality View

**What it does:** Provides an aggregated sub-frame quality dashboard for a specific object, showing grading distributions and average performance across all sessions.

**When to use it:** To understand which sessions produced the best data, and to identify sessions worth re-imaging.

**Step-by-step:**

1. Open an object's detail page.
2. Click the **Quality** tab.
3. Review the **grade distribution chart**: the proportion of Excellent, Good, Fair, Poor, and Bad sub-frames.
4. Each session is listed with its average HFR, FWHM, star count, and overall grade.
5. Click a session to drill down to per-file quality scores in Observation Detail.

**Quality grades:**

| Grade     | Score Range | What it means                          |
|-----------|-------------|----------------------------------------|
| Excellent | 90–100      | Exceptional sharpness and clarity      |
| Good      | 80–89       | Above-average quality, keep            |
| Fair      | 70–79       | Acceptable, use if needed              |
| Poor      | 50–69       | Noticeably degraded, consider removing |
| Bad       | 0–49        | Reject: likely cloud, wind, or trail  |

---

### Storage

**What it does:** Shows where your library lives on disk and helps you reclaim space.

**When to use it:** To understand your disk usage, move the library, or remove files you no longer need.

**Step-by-step:**

1. Go to **Settings → Storage**.
2. **Location** shows the data directory and library location, and lets you move the library to another disk.
3. **Cleanup** shows sub-frame usage by object and can purge sub-frames you no longer need. Stacked images and thumbnails are kept.
4. **Archive** moves older captures to an external disk, and **DB Backups** manages database snapshots.

---

### Backup / Import Status

**What it does:** Shows the progress and history of importing files from your telescope or imaging rig over the network or from USB.

**When to use it:** After connecting your telescope and triggering an import, to monitor progress.

**Step-by-step:**

1. Click the sync indicator in the top bar, then **Open backup status**.
2. If an import is in progress, you will see:
   - Objects completed vs. total
   - Files transferred vs. total
   - Current transfer speed and estimated time remaining
3. The **Import History** log shows past imports with timestamps and file counts.
4. The **Telescope Status** indicator shows whether Nebulis can currently reach your device on the network.

---

### Settings

**What it does:** Configures how Nebulis connects to your telescope, calculates sky positions, displays data, and manages users.

**When to use it:** During initial setup, and any time you need to update your connection details or preferences.

**Step-by-step:**

1. Click **Settings** in the navigation menu (or the gear icon).
2. Configure each section:

**Telescopes** (Settings → Telescopes)
- **Model:** Select your device — Seestar S30, S50, or their Pro versions; Dwarf II, Dwarf 3, or Dwarf Mini; ASIAIR; or **Other** for a generic SMB share on a NAS or another computer. This sets sensible defaults for everything below.
- **Connection:** Choose **Wi-Fi** or **USB cable**. USB is faster and needs no network, but only works while the device's storage is plugged into the computer running Nebulis. Dwarf uses FTP when on Wi-Fi; Seestar, ASIAIR, and Other use SMB.
- **Hostname or IP:** The network address of the device (for example, `seestar.local` or `192.168.1.50`). For a Dwarf on its own Wi-Fi this is `192.168.88.1`; type it in yourself, it is shown as a placeholder hint but not filled in for you.
- **Share Name:** *Seestar, ASIAIR, and Other.* The SMB share name on the device (default: `EMMC Images`); ASIAIR publishes the same share, read-only. For Other, enter the share name on its own, or `share/folder` to start inside a subfolder. Dwarf telescopes have no share name: they use FTP, and the right storage folder is detected for you.
- **Username / Password:** Network credentials (often blank for Seestar, `guest` for ASIAIR, and not needed for Dwarf, whose FTP server allows anonymous access).
- **Test Connection:** Verifies the device answers before you save. For a Dwarf it also reports which storage layout was found, which is the quickest way to catch a wrong model selection.

You can configure both Wi-Fi and USB for the same telescope. Nebulis then uses whichever is available, preferring the cable when it is plugged in.

**Observing Sites** (Settings → Sky → Observing sites)
- **Name, Latitude, and Longitude:** Add each place you observe from. These are required for the Planner and Forecast.
- **Minimum Altitude:** Objects below this elevation (in degrees) are excluded from planner results. Increase this if you have obstructions on your horizon.
- **Imaging window:** Choose the darkness type (astronomical or nautical) and how early or late the window starts and ends.
- **Set sky:** Mark the parts of the sky your site can see. See [How to Configure Your Horizon Profile](#how-to-configure-your-horizon-profile).

**Sky → Catalog data**
- Download catalog packs, sky imagery, and descriptions for offline use.

**Library** (Settings → Library)
- **Display:** Choose whether object cards show catalog imagery or your own captures.
- **Slideshow, Organization, and Processing:** How the slideshow plays, how objects are named and grouped, and what Nebulis does with frames after they arrive.

**Per-telescope import options** (Settings → Telescopes → your device)
- **Auto-import:** Keep this device in the scheduled sync, or turn it off and import manually.
- **File types:** Choose which captures to import — JPG, FITS, sub-frames, and videos.

**Users** (Settings → Account → Users, admin only)
- Create new user accounts, reset passwords, or remove users.

3. Click **Save changes** after changing a section.

---

## How-To Guides

---

### How to Import Images from Your Telescope

1. Ensure your telescope is powered on and connected to the same network as Nebulis (or its storage is plugged in over USB).
2. Go to **Settings → Telescopes** and confirm the connection fields are correct.
3. Click the sync indicator in the top bar and choose **Sync all** (or the sync button for one device).
4. Open **Backup status** from the same panel to watch progress; import time depends on the number and size of files.
5. When complete, your new objects and sessions will appear in the Library.

---

### How to Add Notes to an Observation

1. Open the **Library** and click the object you observed.
2. Click the session date in the session list.
3. In the Observation Detail page, find the **Notes** section.
4. Click **Add Notes** or **Edit Notes**.
5. Fill in any of the fields: Bortle class, seeing, transparency, moon phase, equipment, and freeform text.
6. Click **Save**.

---

### How to Upload a Processed Image

1. Open the **Observation Detail** page for the relevant object and session.
2. Click **Upload Processed Image**.
3. Select the image file from your computer (JPG or PNG).
4. Add a **title** and optional **notes** describing the processing done.
5. Click **Upload**. The image will appear in the session and may become the gallery card image for the object.

---

### How to Download Session Files

1. Open the **Observation Detail** page for the session you want to download.
2. Click the **Download** button.
3. Choose whether to download all files, images only, or FITS files only.
4. A ZIP archive will be prepared and downloaded to your computer.

---

### Explore: finding something to photograph

Open **Explore** in the top bar.

1. Type any name or catalog number in the search box (for example `Pelican`, `M42`, `NGC 7000`, `Caldwell 14`). Matches appear as you type. Click **+** to add one to your wishlist, or click the row to open it.
2. Under **Browse by kind**, click a tile (Galaxies, Emission nebulae, and so on) to see the best objects of that kind from your observing site. Use **Up tonight**, **Visible from here** or **Everything** to filter, and the sort buttons to reorder.
3. Tick **Fits my scope** to keep only objects that fit one frame of your telescope. Each card also shows **Fits**, **Tight**, **Tiny** or **Mosaic** for your current field of view (set under Settings -> Telescopes or in the Framing tool).
4. Each card shows when the object can be seen: **Up tonight**, **Best Oct to Dec**, **Low from here** or **Never rises here**.
5. On a card, **Wishlist** saves it and **Plan tonight** puts a block in tonight's plan. Open the object and choose **Plan a night** to pick from the next 30 nights.

Explore works without internet. The browse tiles are part of the app. Pictures of objects are saved on the server the first time they are shown and are never deleted, and running **Download catalog images** (Settings) while online saves the best-ranked objects in every category ahead of time.

**Planner, Explore and Wishlist work together.** Everywhere, "Best tonight" blends how well a target is placed with how rewarding it is to shoot. In the Planner, the **Order** menu above the target list switches to **Best conditions** (the planner score alone), and the compass button opens Explore on the night you are planning, showing what is up then. On an Explore card, the crosshair button opens the Planner on that night with the object searched for. On a Wishlist card, hover to get the same Planner button and a compass button that opens the Explore tile the object belongs to.

Use the site picker at the top right to see Explore from another observing site. This only changes Explore, not your active site.

### How to Add a Target to the Wishlist

1. Click **Planner** in the navigation menu.
2. Browse or search for the object in the **Targets** tab.
3. Click **Add to Wishlist** next to the target's name.
4. Set a priority (High, Medium, or Low) and add any notes.
5. Click **Save**. The target now appears in the **Wishlist** tab.

---

### How to Search for a Specific Object

1. Go to the **Library** (home page).
2. Type the object's name or catalog designation into the **search bar** (for example, "M42", "NGC 891", or "Orion Nebula").
3. Matching results appear in real time. Click a card to open the object.

> Catalog designations from the Messier (M), NGC, IC, and Sharpless (Sh2) catalogs are all supported.

---

### How to Compare Images from Two Sessions

1. Open the **Object Detail** page for the object.
2. Click the **Compare** tab.
3. Select the two sessions you want to compare using the dropdowns.
4. The images appear side-by-side. Use the controls to zoom or adjust the view.

---

### How to Favorite an Object

- From the **Library**: click the **heart icon** on the object's card.
- From the **Gallery** slideshow: click the **heart icon** on the current slide.
- To view all favorites, toggle the **Favorites** filter in the Library.

---

### How to Configure Your Horizon Profile

If your observing site has obstructions (trees, a rooftop, hills), you can mark the parts of the sky you cannot see, so the Planner does not suggest objects that will be blocked.

1. Go to **Settings → Sky → Observing sites**.
2. Open your site and click **Set sky**.
3. Click or drag across the sky map to toggle the patches of sky you can see. The map has 36 compass wedges (10° each) and 8 altitude bands (10° each) from the horizon up to 80°; above 80° is treated as zenith and always visible.
4. Use **Mirror N to S** or **Mirror E to W** to copy one side onto the other.
5. Click **Save sky map**. The Planner will now exclude objects hidden by your local horizon.

---

### How to Download Catalog Images for Offline Use

Nebulis can download catalog images for all objects in advance, so they display instantly even without an internet connection.

1. Go to **Settings → Sky → Catalog data**, then find **Offline catalog data**.
2. Turn on the packs you want, or click **Download everything** for the entire catalog.
3. A background job downloads the catalog packs, sky images, and descriptions for your catalog and library.
4. Progress is shown in real time. You can cancel the job at any time, and it resumes where it left off.
5. Cached images are stored locally on the server.

---

## User Interface Overview

### Navigation Menu

The main navigation appears as a sidebar or top bar (depending on your screen size) and contains the following links:

| Menu Item     | Page                       | Purpose                                |
|---------------|----------------------------|----------------------------------------|
| Library       | Home (`/`)                 | Browse all imaged objects              |
| Gallery       | Image Gallery (`/image-gallery`) | Full-screen image presentation   |
| Observations  | Observations Calendar      | Timeline of all imaging sessions       |
| Forecast      | Forecast                   | Weather and seeing forecast            |
| Planner       | Planner                    | Tonight's best targets and wishlist    |
| Explore       | Explore                    | Browse the sky by kind; wishlist and plan nights |
| Catalogs      | Catalogs                   | Curated catalog boards and your targets |
| Calibrations  | Calibration Library        | Dark, flat, and bias frames            |
| Settings      | Settings                   | App configuration, storage, and user management |
| Help          | Help                       | In-app help                            |

Storage lives in **Settings**, and the **Backup status** page opens from the sync indicator in the top bar. The order and visibility of the navigation items can be changed in **Settings → General → Navigation**.

### Key Screens

**Library (Home, the object gallery)**
- Object cards in a responsive grid
- Search bar at the top
- Filter panel (object type, favorites)
- Clicking a card opens Object Detail

**Object Detail**
- Header: best image, catalog info, Wikipedia description
- Tabs: Sessions, Notes, Quality, Compare
- Session list with dates and file counts
- Clicking a session opens Observation Detail

**Observation Detail**
- File list with quality icons
- FITS viewer (click any image)
- Notes panel (add/edit session log)
- Weather panel
- Download and upload controls

**Planner**
- Targets tab: ranked list of tonight's objects
- Wishlist tab: saved future targets
- Altitude curve shown per object on click

**Forecast**
- Nightly summary cards with visibility rating
- Hourly breakdown expandable per night

### Important Controls

| Control                  | Location              | What it does                                   |
|--------------------------|-----------------------|------------------------------------------------|
| Heart icon               | Library cards, slideshow | Toggle favorite on an object               |
| Download button          | Observation Detail    | Download session files as a ZIP                |
| Upload Processed Image   | Observation Detail    | Attach your own processed image to a session   |
| Stretch / Contrast sliders | FITS Viewer         | Adjust raw image display                       |
| Add to Wishlist          | Planner → Targets     | Save a target for a future observing run       |
| Sync all                 | Top bar sync indicator | Trigger an import from every connected device |
| Download everything      | Settings → Sky → Catalog data | Download catalog imagery for offline use |

### Themes

Nebulis supports four display themes, selectable in Settings:

- **Light**: bright interface for daytime use
- **Dark**: dim navy, for indoor use
- **Space**: deep violet, for a dark room
- **Night**: red light, to preserve dark adaptation at the telescope

---

## Tips and Best Practices

- **Set your observer location first.** The Planner and Forecast are both location-dependent. Without accurate coordinates and timezone, altitude calculations and forecasts will be incorrect.

- **Use the Planner before every session.** The ranking algorithm accounts for moon phase, visibility window, and transit time, not just whether an object is up. Objects near their peak altitude produce sharper images.

- **Check the Forecast for seeing, not just clouds.** A perfectly clear sky with poor seeing (1–2 out of 5) will produce bloated, unsharp stars. Prioritize nights with seeing 3 or better.

- **Review quality grades before stacking.** Use the Quality tab to identify and delete poor or bad sub-frames before integrating your data in external software. Even a few bad frames can degrade a final stack.

- **Upload your processed images.** Attaching a finished, processed image to each session makes your gallery much more visually rewarding. The processed image becomes the card thumbnail for that object.

- **Keep your wishlist current.** Add objects as you think of them, with priority and notes. The Planner highlights wishlist items so they are easy to spot when conditions align.

- **Use the Night theme at the telescope.** The red-tinted interface is designed to protect your eyes' dark adaptation during observing sessions.

- **Run imports after each session, not before.** Import your new data after returning indoors; you will have the freshest data ready for review while your memory of the session is fresh.

- **Monitor storage regularly.** FITS sub-frame files can consume significant disk space. Use **Settings → Storage → Cleanup** to identify objects with large footprints and archive or delete data you no longer need.

- **Set a meaningful minimum altitude.** The default minimum altitude may include objects that are technically above the horizon but hidden behind obstructions. Raise the minimum or set a visible sky map to get accurate planner recommendations.

---

## Troubleshooting

### Telescope not found / Import fails to start

**Possible causes:**
- The device is powered off or not connected to the network.
- For a Dwarf, the computer running Nebulis is not joined to the telescope's Wi-Fi.
- The hostname or IP address in Settings is incorrect.
- Your computer and the device are on different network segments.

**Steps to resolve:**
1. Confirm the device is powered on and shows a network connection in its own app.
2. For a Dwarf on its own Wi-Fi, join the telescope's network first; try pinging its address (open a terminal and type `ping 192.168.88.1`). For a Seestar, try `ping seestar.local`.
3. If the hostname does not resolve, try the IP address instead. Check your router's device list to find the device's current IP.
4. For an ASIAIR, remember it has no FTP server: use its SMB share, or plug its USB drive into the server.
5. Go to **Settings → Telescopes** and update the address, then try importing again.
6. Open **Backup status** from the top bar. The Telescope Status indicator will show whether the device is reachable.

---

### No objects appear in the Library after import

**Possible causes:**
- The SMB share name is incorrect (Seestar, ASIAIR, or Other).
- The wrong Dwarf model is selected, so the app looked in the wrong storage folder.
- The device's directory structure differs from expected.
- The import completed with errors.

**Steps to resolve:**
1. Go to **Settings → Telescopes** and verify the **Share Name** field. The default for Seestar and ASIAIR devices is `EMMC Images`; for **Other**, enter the share name on its own. Dwarf telescopes have no share name.
2. For a Dwarf, press **Test Connection** and check the storage folder it reports. If it does not match your model, correct the model selection and save again.
3. Open **Backup status** from the top bar and check for any error messages in the import log.
4. If sessions exist on the device but are not appearing, contact support with the import log output.

---

### Forecast data is not loading

**Possible causes:**
- No internet connection on the server running Nebulis.
- No observing site is set.

**Steps to resolve:**
1. Go to **Settings → Sky → Observing sites** and confirm latitude, longitude, and timezone are filled in.
2. Verify the server has an active internet connection.
3. Reload the Forecast page. If the issue persists, the external forecast services (7Timer, Open-Meteo) may be temporarily unavailable. Try again in a few minutes.

---

### Planner shows no targets

**Possible causes:**
- No observing site is configured.
- Minimum altitude is set too high, filtering out all objects.
- The site's visible sky map is hiding too much of the sky.

**Steps to resolve:**
1. Go to **Settings → Sky → Observing sites** and confirm all fields are set.
2. Lower the **Minimum Altitude** value (try 10° as a starting point).
3. If you set a visible sky map, check that it is not hiding most directions.

---

### Images appear blank or very dark in the FITS Viewer

FITS raw image data often has a very narrow range of values that renders dark by default.

**Steps to resolve:**
1. In the FITS Viewer, use the **Stretch** slider to apply a histogram stretch (try Log or Auto-stretch).
2. Adjust the **Contrast** slider to bring out detail.
3. This is normal behavior: raw FITS data requires stretching to display usefully.

---

### "Unauthorized" error / Cannot access the application

**Possible causes:**
- Your session has expired (tokens expire after 30 days).
- Your account was removed by an administrator.

**Steps to resolve:**
1. Click **Sign Out** and sign back in with your credentials.
2. If you no longer have credentials, contact your administrator to reset your password or create a new account.

---

### Quality scores are missing for some files

**Possible causes:**
- The files are standard JPG images without embedded FITS metadata.
- The FITS headers do not contain HFR/FWHM data (this depends on Seestar firmware version).

**Resolution:** Quality scores are only available for FITS sub-frame files that contain the relevant header data. JPG images and stacked outputs do not produce quality scores. This is expected behavior.

---

## FAQ

**Q: Do I need an internet connection to use Nebulis?**
A: Not for core features. Browsing your gallery, reviewing sessions, and managing notes all work offline. The Forecast feature, object descriptions, and online catalog images require an internet connection. You can download catalog images in advance for offline use.

**Q: Can multiple people use Nebulis at the same time?**
A: Yes. The administrator can create accounts for multiple users. Each user has their own login, favorites, and watermark presets. All users share the same image library.

**Q: What file formats does Nebulis support?**
A: FITS (`.fit`, `.fits`) for raw sub-frames and science data, and JPG/PNG for processed and stacked images. Video and SER/AVI files are stored and offered as downloads, but are not previewed in the browser.

**Q: Which telescopes and rigs can Nebulis import from?**
A: Nebulis reads the folder layouts of the ZWO Seestar S30 and S50 (including the Pro models), the DWARFLAB Dwarf II, Dwarf 3, and Dwarf Mini, and the ZWO ASIAIR. It can also watch any folder shared over SMB or FTP, or ingest a USB-mounted drive, so images from almost any astrophotography setup can join the library. Other setups use that generic path rather than a dedicated device profile.

**Q: Where are my files stored?**
A: All imported files are stored on the computer running Nebulis, in its configured data directory. They are not uploaded to any cloud service unless you explicitly download and share them yourself.

**Q: What happens if I delete a file in Nebulis?**
A: Deleting a file removes it from Nebulis's library. Whether the original file is also removed from the telescope's memory card depends on your configuration. Review your import settings to understand whether files are copied or moved.

**Q: Can I access Nebulis from my phone?**
A: Yes. The interface is designed to be responsive and works on mobile browsers. For the best experience navigating catalogs and session data, a tablet or larger screen is recommended.

**Q: How do I move a session to a different object?**
A: Open the object that currently owns the session, open its **More actions** menu, and choose **Reclassify object**. Pick the correct catalog object and confirm. This is useful when a capture was matched to the wrong catalog entry.

**Q: The image quality scores seem low even though my images look fine. Why?**
A: Quality scores are calculated from raw FITS header data (HFR, FWHM, star count). Scores can be affected by narrow-field objects with few stars, high atmospheric dispersion at low altitudes, or calibration differences between firmware versions. Use scores as a relative guide, not an absolute standard.

**Q: Can I run a manual observation without connecting a telescope?**
A: Yes. Navigate to **Observations → New Observation** to create a session manually, upload your own images, and add notes. This lets you log observations from any camera or telescope.

---

## Glossary

| Term             | Definition                                                                                          |
|------------------|-----------------------------------------------------------------------------------------------------|
| **Bortle Scale** | A numeric scale (1–9) measuring the darkness of the night sky. Lower is darker.                     |
| **DSS2**         | Digitized Sky Survey 2: a catalog of sky survey images used as reference images in Nebulis.    |
| **FITS**         | Flexible Image Transport System: the standard file format for scientific astronomical image data.  |
| **FWHM**         | Full Width at Half Maximum: a measure of star sharpness. Lower values indicate sharper stars.      |
| **HFR**          | Half-Flux Radius: a measure of star size in image data. Lower values indicate tighter, sharper stars. |
| **Integration time** | The total accumulated exposure time from all sub-frames combined in a session.                  |
| **Magnitude**    | A measure of an astronomical object's brightness. Lower numbers are brighter.                       |
| **mDNS**         | Multicast DNS: a protocol that allows devices to be found by name (e.g., `seestar.local`) on a local network without manual IP entry. |
| **Moon illumination** | The percentage of the moon's visible face that is lit. High illumination increases sky glow and reduces contrast. |
| **NGC**          | New General Catalogue: a major catalog of deep-sky objects (galaxies, nebulae, clusters).          |
| **RA / Dec**     | Right Ascension and Declination: the celestial coordinate system used to locate objects in the sky. |
| **Seeing**       | A measure of atmospheric steadiness. Poor seeing causes stars to twinkle and appear blurry.         |
| **SMB**          | Server Message Block: a network file-sharing protocol used by Seestar, ASIAIR, and many NAS devices to expose storage. |
| **FTP**          | File Transfer Protocol: the protocol Dwarf telescopes use to expose their storage over Wi-Fi. Dwarf models do not offer SMB. |
| **Station mode** | A Dwarf setting that joins the telescope to your home Wi-Fi instead of it broadcasting its own. In station mode the telescope's address comes from your router rather than being `192.168.88.1`. |
| **Sub-frame**    | A single, unprocessed exposure captured by the telescope. Multiple sub-frames are later combined (stacked). |
| **Transparency** | A measure of atmospheric clarity (absence of haze, dust, and humidity). High transparency improves contrast. |
| **Transit**      | The moment when an object crosses the meridian and reaches its highest point in the sky.            |
| **Wishlist**     | A personal list of targets you plan to image in a future observing session.                         |

---

## Support

### Getting Help

- **In-app feedback:** If your administrator has set up a feedback channel, use it to report issues or request features.
- **Application issues:** Report bugs or feature requests at the project's issue tracker. *(Contact your administrator for the link.)*
- **Community:** The manufacturer communities for your device (ZWO Seestar and ASIAIR forums, DWARFLAB groups, Cloudy Nights, and Reddit) are excellent resources for questions about telescope operation and imaging techniques.

### Contacting Your Administrator

If you are using Nebulis on a shared server managed by someone else, they are your first point of contact for:
- Account creation and password resets
- Network configuration and telescope connectivity
- Storage and import settings

---

## Known limitations

- **Deleting files:** Deleting a file removes it from the Nebulis library. Whether the original on the device is also affected depends on your device's storage and your import settings, so check before deleting.
- **Horizon map:** The sky map covers the horizon up to 80°; anything above 80° is treated as zenith and always visible.
- **Video:** Video and SER/AVI files are stored and offered as downloads, but are not previewed in the browser.
- **Offline catalog:** **Download everything** is roughly 1–2 GB and runs in the background. You can cancel it, and it resumes where it left off.
- **Port number:** The example URL `http://nebulis.local:8080` uses the Docker and Windows installer default. The Node server defaults to port 3002 in development; set `PORT` to change it.
