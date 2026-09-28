# Nebulis User Guide

---

## Overview

**Nebulis** is an observatory and image library management platform for smart telescopes (ZWO Seestar S30/S50, DWARFLAB Dwarf II / Dwarf 3 / Dwarf Mini, and networked astronomy gear). It connects to your telescopes over your home network, imports your captured images and FITS data, and gives you a comprehensive suite of tools to browse, analyze, plan, calibrate, and archive your astronomy sessions.

### Key Benefits

- Browse all of your captured deep-sky objects in a visual gallery
- Review image quality metrics (HFR, FWHM, star count) for every sub-frame
- Maintain a dedicated **Calibration Library** for master darks, flats, bias, and flat-darks
- Seamlessly integrate with **PixInsight** via native PJSR connector and embedded update repository
- Track working **Processing Projects** and archives (`.xpsm` process icons, `.xisf` master stacks, Siril scripts)
- Plan future sessions with tonight's best observable targets and altitude curves
- Check weather and astronomical seeing forecasts before heading outside
- Upload your own processed images alongside raw originals
- Track every session with notes, ratings, and equipment logs
- Download or archive your data by object or session

### Typical Use Cases

- Reviewing last night's images after an observing run
- Checking which objects are worth imaging tonight
- Comparing image quality between sessions of the same object
- Automatically matching calibration frames and downloading ready-to-process WBPP workspaces in PixInsight
- Archiving post-processing workflows, process icons, and master stacks per object
- Keeping an observing log with notes, seeing conditions, and moon phase
- Maintaining a wishlist of targets you plan to image in the future
- Archiving and organizing years of astrophotography captures in one place

---

## Getting Started

### System Requirements

- A modern web browser (Chrome, Firefox, Safari, or Edge; current versions recommended)
- A supported smart telescope on your local network: a ZWO Seestar S30 or S50, or a DWARFLAB Dwarf II, Dwarf 3, or Dwarf Mini
- Nebulis running on a computer or server that can reach the telescope
- For Seestar: network file sharing (SMB) enabled on the device (enabled by default)
- For Dwarf: the telescope's Wi-Fi active. Dwarf models share their storage over FTP rather than SMB, so the computer running Nebulis must be joined to the telescope's own Wi-Fi, or on the same network as the telescope if you use station mode
- Optional: PixInsight ($\ge$ 1.8.9 or 1.9.x) for direct workspace integration and process icon sync

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

### Gallery

**What it does:** Displays all of your imaged deep-sky objects as a visual card grid. Each card shows the object's best image, name, type, constellation, and how many sessions you have for it.

**When to use it:** As your home screen, to get a quick overview of your entire library and navigate to any object.

**Step-by-step:**

1. Go to the home page (`/`). The Gallery loads automatically.
2. Use the **search bar** to find an object by name (for example, "M31" or "Andromeda").
3. Use the **filter panel** to narrow results by object type (Galaxy, Nebula, Star Cluster, etc.).
4. Click the **heart icon** on a card to mark it as a favorite. Click the favorites toggle to show only favorites.
5. Click any card to open the **Object Detail** page for that object.

---

### Object Detail

**What it does:** Shows everything about a single imaged object: all sessions, files, catalog information, quality scores, and your personal notes.

**When to use it:** After selecting an object from the gallery, when reviewing a specific target in depth.

**Step-by-step:**

1. Click any object card in the Gallery to open its detail page.
2. The top section shows the **object's best image**, catalog data (type, constellation, magnitude, distance), and any Wikipedia description.
3. Scroll down to see a list of all **imaging sessions** for this object, organized by date.
4. Click a session row to open the **Observation Detail** page for that session.
5. Use the **Notes** tab to read or add personal observing notes for this object.
6. Use the **Quality** tab to view an aggregated sub-frame quality dashboard.
7. Use the **Compare** tab to open a side-by-side comparison of images from different sessions.
8. Use the **Processing Project** tab to inspect, upload, and download working project files (`.xpsm` process icons, `.xisf` masters, Siril scripts, or `.zip` archives).
9. Use the **Calibrations** tab to review or attach matched calibration frames (darks, flats, bias) specific to this object.

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

### Image Gallery (Slideshow)

**What it does:** Displays your entire image library as a full-screen animated slideshow with crossfade transitions and Ken Burns zoom effects.

**When to use it:** To showcase your library, or simply to enjoy your images in a cinematic presentation.

**Step-by-step:**

1. Click **Image Gallery** in the navigation menu.
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

**What it does:** Calculates and ranks the best deep-sky objects to image **tonight**, based on your location, current sky conditions, and the Seestar's field of view. Also lets you manage a wishlist of future targets.

**When to use it:** Before an observing session, to decide what to point your telescope at.

**Step-by-step:**

1. Click **Planner** in the navigation menu.
2. Make sure your observer location is set in **Settings** (latitude, longitude, timezone). The planner requires this to calculate object positions.
3. The **Targets** tab shows tonight's best objects, ranked by a composite score that considers:
   - Maximum altitude above your horizon
   - Total visibility window (how long it is above your minimum altitude)
   - Brightness (magnitude)
   - How close to midnight transit the object peaks
   - Angular size fit for the Seestar's field of view
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

### Storage Dashboard

**What it does:** Shows a breakdown of how much disk space your library is using, organized by object, file type, and directory.

**When to use it:** To understand your disk usage and identify large objects or file types.

**Step-by-step:**

1. Click **Storage** in the navigation menu.
2. The dashboard shows total disk usage, broken down by object.
3. Each row shows file counts (images, FITS files, sub-frames) and the total size for that object.
4. System information includes the disk health status and data directory location.

---

### Calibration Library

**What it does:** Provides a central repository (`/calibrations`) to organize, inspect, and manage master calibration frames—Master Darks, Master Flats, Bias/Offset frames, and Flat-Darks. Displays vital acquisition metadata (camera model, exposure duration, sensor temperature, filter band, gain, binning) and allows attaching calibration sets directly to specific targets or making them available for automated matching across your entire library.

**When to use it:** When building up your calibration master library, inspecting calibration quality, downloading calibration bundles, or associating specific calibration frames with deep-sky objects.

**Step-by-step:**

1. Click **Calibrations** in the navigation menu (or navigate to `/calibrations`).
2. The page displays your calibration groups divided into:
   - **Master Darks**: Grouped by camera, exposure duration, gain, and sensor temperature ($\pm^\circ\text{C}$).
   - **Master Flats**: Grouped by camera, optical filter band (e.g., L, Dual-Band, Ha, OIII), gain, and binning.
   - **Master Bias / Offset**: Grouped by camera, gain, and binning.
   - **Flat Darks**: Grouped by camera, flat exposure duration, and gain.
3. Click any calibration group to expand and view its sub-files, FITS headers, mean ADU levels, and creation timestamps.
4. **Attaching to Objects**:
   - Open any deep-sky target's **Object Detail** page and navigate to the **Calibrations** tab.
   - Search or select compatible calibration masters from your library.
   - Click **Attach to Object**. Directly attached calibrations are prioritized with 100% confidence by external tools like the PixInsight Connector.
5. **Downloading Calibrations**:
   - Select individual or multiple calibration groups.
   - Click **Download Bundle** to stream a compressed ZIP archive structured with `darks/`, `flats/`, `bias/`, and `flatdarks/` subdirectories.

---

### Processing Projects & Archives

**What it does:** Manages working project files, process workflows, scripts, and archives stored in each object's dedicated `<objectFolder>/processing_project/` directory. Preserves your post-processing pipelines from PixInsight, Siril, AstroPixelProcessor, or Photoshop directly alongside your raw data.

**When to use it:** When saving processing states, backing up PixInsight process icons (`.xpsm`), storing final integrated `.xisf` or 32-bit TIFF stacks, sharing project files across workstations, or archiving complete post-processing sessions into downloadable `.zip` bundles.

**Step-by-step:**

1. Navigate to any object in the **Gallery** and open its **Object Detail** page.
2. Select the **Processing Project** tab.
3. The dashboard displays:
   - Discovered project files with file extensions, file sizes, and last modified dates.
   - Total folder size and file count.
4. **Uploading Project Files**:
   - Click **Upload Project File** to add PixInsight process icons (`.xpsm`), PixInsight projects (`.pxi`), master stacks (`.xisf`), or Siril scripts.
   - Drag and drop files directly onto the upload area.
5. **Project Archives**:
   - Click **Upload Project Archive** to upload a complete `.zip` archive containing your full workspace.
   - Click **Download Archive** to retrieve a snapshot of the current processing project.
6. Files in `processing_project/` are also directly synchronized via the PixInsight Connector script without opening the web browser.

---

### PixInsight Integration

**What it does:** Integrates PixInsight ($\ge$ 1.8.9 and 1.9.x) natively with your Nebulis server through an official embedded update repository and a standalone PJSR connector script (`NebulisConnector.js`). Features a streamlined 3-tab architecture (Library Download, Calibration Library, and Project Sync), real-time DSO screenshot previews, flat-to-target object linkage visibility, and two-way process icon synchronization. The plugin version is always synchronized with the Nebulis application version (currently `v2.1.0`).

**When to use it:** Whenever you process your raw subframes in PixInsight and want to automate data transfer, calibration acquisition, and workflow archiving without manual file copying.

**Step-by-step:**

1. **Add the Update Repository to PixInsight (One-Time Setup)**:
   - In PixInsight, go to **Resources → Updates → Manage Repositories**.
   - Click **Add** and enter your repository URL (remember the trailing slash):
     ```text
     http://<nebulis-host>:<port>/plugins/pixinsight/
     ```
     *(For example: `http://localhost:3002/plugins/pixinsight/` or `http://192.168.1.50:8080/plugins/pixinsight/`)*
   - Click **OK**, then navigate to **Resources → Updates → Check for Updates**.
   - PixInsight will detect **Nebulis Connector for PixInsight (v2.1.0)**. Click **Apply updates** and restart PixInsight.
   - *(Note: You can also visit `http://<nebulis-host>:<port>/plugins/pixinsight/` in your web browser for a live landing page with a one-click copy button and direct download options).*
2. **Launch the Connector**:
   - In PixInsight, go to **Script → Nebulis → Nebulis Connector**.
3. **Configure Connection in the Dedicated Settings Dialog**:
   - Click the **⚙ Settings** tool button in the top header bar or the **⚙ Settings & Preferences...** button at the bottom.
   - Enter your **Nebulis Server URL** (e.g. `http://localhost:3002`).
   - Enter your user-linked **API Key** (generated in Nebulis under **Settings → Account → API Keys**, prefixed with `neb-`).
   - Configure your local **Download Directory / Projects Root** (default: `~/AstroProjects`).
   - Click **Test Connection** to verify access, then click **Save Settings**.
4. **Tab 1: Library Download (Lights & Sessions)**:
   - Browse or filter your DSO targets with real-time DSO image previews and metadata (Catalog ID, Constellation, Type, Sessions, and Observatory folder path).
   - Review imaging sessions with subframe counts, optical filters (e.g. `H (180.0s)`), and telescope rig attribution.
   - Click **Download Light Subframes (Sessions)** to download raw light subframes directly into your local workspace.
5. **Tab 2: Calibration Library (Darks, Flats, Bias, Flat-Darks)**:
   - Browse your entire calibration library across all telescope rigs.
   - **Linked Target Object for Flats**: For Flats and Flat-Darks, the **Linked Object** column explicitly displays the target DSO and session date (e.g. `NGC 6888 (2026-09-11)`).
   - Filter by keyword or calibration type (*All*, *Darks*, *Flats*, *Bias*, *Flat-Darks*).
   - Expand any calibration group to inspect individual subframe files with file sizes and timestamps.
   - Select desired calibration bundles and click **Download Selected Calibrations** to download them into your local calibrations folder.
6. **Tab 3: Project Sync (Process Icons & Archives)**:
   - After processing, drag process instances onto the PixInsight workspace to create process icons for your workflow.
   - Switch to the **Project Sync** tab in the Nebulis Connector.
   - Click **Sync Process Icons (.xpsm) to Nebulis...** to save and automatically upload your workflow to the object's `processing_project/` folder on Nebulis.
   - Click **Upload Local File to Nebulis Project...** to upload your master integrated `.xisf` images or project archives.

---

### Backup / Import Status

**What it does:** Shows the progress and history of importing files from your telescope over the network.

**When to use it:** After connecting your telescope and triggering an import, to monitor progress.

**Step-by-step:**

1. Click **Backup** in the navigation menu.
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

**Telescope Connection**
- **Model:** Select your telescope (Seestar S30/S50, or Dwarf II / Dwarf 3 / Dwarf Mini). This sets sensible defaults for everything below.
- **Connection:** Choose **Wi-Fi** or **USB cable**. USB is faster and needs no network, but only works while the telescope's storage is plugged into the computer running Nebulis.
- **Hostname or IP:** The network address of the telescope (for example, `seestar.local` or `192.168.1.50`). For a Dwarf on its own Wi-Fi this is `192.168.88.1`; type it in yourself, it is shown as a placeholder hint but not filled in for you.
- **Share Name:** *Seestar only.* The SMB share name on the device (default: `EMMC Images`). Dwarf telescopes have no share name: they use FTP, and the right storage folder is detected for you.
- **Username / Password:** Network credentials (often blank for Seestar, and not needed for Dwarf, whose FTP server allows anonymous access).
- **Test Connection:** Verifies the telescope answers before you save. For a Dwarf it also reports which storage layout was found, which is the quickest way to catch a wrong model selection.

You can configure both Wi-Fi and USB for the same telescope. Nebulis then uses whichever is available, preferring the cable when it is plugged in.

**Observer Location**
- **Latitude and Longitude:** Your observing site coordinates (required for the Planner and Forecast).
- **Timezone:** Your local timezone.
- **Minimum Altitude:** Objects below this elevation (in degrees) are excluded from planner results. Increase this if you have obstructions on your horizon.
- **Custom Horizon Profile:** Optional. Define elevation limits per compass direction to account for trees, buildings, or terrain.

**Catalog & Display**
- **Catalog Source:** Use the built-in catalog (Messier, NGC, IC, and Sharpless objects) or point to a custom catalog URL.
- **Gallery Image Source:** Choose whether object cards display sky survey/Hubble images or your own captured images.

**Sync & Import**
- **Auto-Import:** Enable automatic syncing from your telescope on a schedule.
- **File Types:** Select which file types to import (JPG, FITS, thumbnails, sub-frames, videos).

**User Management** (Admin only)
- Create new user accounts, reset passwords, or remove users.

3. Click **Save** after changing any section.

---

## How-To Guides

---

### How to Import Images from Your Telescope

1. Ensure your telescope is powered on and connected to the same network as Nebulis.
2. Go to **Settings** and confirm the **Telescope Connection** fields are correct.
3. Navigate to **Backup** in the navigation menu.
4. Click **Start Import** (or **Sync Now**) to begin transferring files.
5. Monitor progress on the Backup page. Import time depends on the number and size of files.
6. When complete, your new objects and sessions will appear in the Gallery.

---

### How to Manage and Attach Calibration Frames

1. Navigate to **Calibrations** (`/calibrations`) in the main navigation menu.
2. Review your calibration library groups (Darks, Flats, Bias, Flat-Darks) and filter by frame type or camera.
3. To attach a calibration set to a specific deep-sky object:
   - Open the target's **Object Detail** page from the Gallery.
   - Click the **Calibrations** tab.
   - Search for compatible library groups or click **Attach Calibration**.
   - Select the desired master group and confirm. Directly attached calibrations will be flagged with 100% match priority when queried by external tools such as the PixInsight Connector.
4. To download a local archive of your calibrations, select one or more groups on the `/calibrations` page and click **Download Bundle**.

---

### How to Connect PixInsight to Nebulis

1. Ensure Nebulis is running and note your server address (e.g., `http://192.168.1.50:8080`).
2. In PixInsight ($\ge$ 1.8.9 or 1.9.x), go to **Resources → Updates → Manage Repositories**.
3. Click **Add** and paste your repository URL (be sure to include the trailing slash):
   ```text
   http://<nebulis-host>:<port>/plugins/pixinsight/
   ```
4. Click **OK**, then navigate to **Resources → Updates → Check for Updates**.
5. Select **Nebulis Connector for PixInsight (v2.1.0)**, click **Apply updates**, and restart PixInsight.
6. Launch the script from **Script → Nebulis → Nebulis Connector**.
7. Click the **⚙ Settings** button, enter your server URL and API Key (prefixed with `neb-`), set your download root directory, and click **Test Connection** followed by **Save Settings**.

---

### How to Download Lights and Calibrations in PixInsight

1. Launch **Script → Nebulis → Nebulis Connector**.
2. On the **Library & Download** tab, select your target object from the list to view its DSO screenshot, catalog metadata, and session subframe counts.
3. Click **Download Light Subframes (Sessions)** to download your raw session lights into your local workspace (`<DownloadDir>/<ObjectName>/lights/`).
4. Switch to the **Calibration Library** tab to browse available Darks, Flats, Bias, and Flat-Darks. Notice that for Flats, the linked target object is displayed.
5. Select the calibration bundles you need and click **Download Selected Calibrations** to download them into your calibrations folder (`<DownloadDir>/<ObjectName>/calibrations/` or dedicated folder).
6. Open **Script → Batch Processing → WeightedBatchPreprocessing (WBPP)** in PixInsight and add your downloaded lights and calibration files directly.

---

### How to Sync PixInsight Process Icons and Project Archives

1. Once you finish processing an image in PixInsight, save your workflow as process icons by dragging process instances onto the PixInsight desktop.
2. Open **Script → Nebulis → Nebulis Connector** and switch to the **Project Sync** tab.
3. Click **Sync Process Icons (.xpsm) to Nebulis...** to export your icons locally and upload them to Nebulis under `library/<ObjectName>/processing_project/`.
4. To upload master integrated `.xisf` images, processing scripts, or `.zip` archives, click **Upload Local File to Nebulis Project...**.
5. Stored files are immediately visible under the object's **Processing Project** tab in the Nebulis web interface.

---

### How to Add Notes to an Observation

1. Open the **Gallery** and click the object you observed.
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

### How to Add a Target to the Wishlist

1. Click **Planner** in the navigation menu.
2. Browse or search for the object in the **Targets** tab.
3. Click **Add to Wishlist** next to the target's name.
4. Set a priority (High, Medium, or Low) and add any notes.
5. Click **Save**. The target now appears in the **Wishlist** tab.

---

### How to Search for a Specific Object

1. Go to the **Gallery** (home page).
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

- From the **Gallery**: click the **heart icon** on the object's card.
- From the **Image Gallery slideshow**: click the **heart icon** on the current slide.
- To view all favorites, toggle the **Favorites** filter in the Gallery.

---

### How to Configure Your Horizon Profile

If your observing site has obstructions (trees, a rooftop, hills), you can set per-direction elevation limits so the Planner does not suggest objects that will be blocked.

1. Go to **Settings → Observer Location**.
2. Find the **Custom Horizon Profile** section.
3. Enter the minimum visible altitude (in degrees) for each compass direction. There are 36 direction buckets (every 10°).
4. Click **Save**. The Planner will now exclude objects blocked by your local horizon.

---

### How to Prefetch Catalog Images for Offline Use

Nebulis can download catalog images for all objects in advance, so they display instantly even without an internet connection.

1. Go to **Settings → Catalog & Display**.
2. Click **Prefetch Catalog Images**.
3. A background job will begin downloading DSS2/Hubble sky survey images and Wikipedia descriptions for your catalog.
4. Progress is shown in real time. You can cancel the job at any time.
5. Cached images are stored locally on the server.

---

## User Interface Overview

### Navigation Menu

The main navigation appears as a sidebar or top bar (depending on your screen size) and contains the following links:

| Menu Item     | Page                       | Purpose                                |
|---------------|----------------------------|----------------------------------------|
| Gallery       | Home (`/`)                 | Browse all imaged objects              |
| Observations  | Observations Calendar      | Timeline of all imaging sessions       |
| Calibrations  | Calibration Library        | Manage master darks, flats, bias, and attachments |
| Planner       | Planner                    | Tonight's best targets and wishlist    |
| Forecast      | Forecast                   | Weather and seeing forecast            |
| Image Gallery | Slideshow                  | Full-screen image presentation         |
| Storage       | Storage Dashboard          | Disk usage by object                   |
| Backup        | Import Status              | Telescope sync progress and history    |
| Settings      | Settings                   | App configuration and user management  |

### Key Screens

**Gallery (Home)**
- Object cards in a responsive grid
- Search bar at the top
- Filter panel (object type, favorites)
- Clicking a card opens Object Detail

**Object Detail**
- Header: best image, catalog info, Wikipedia description
- Tabs: Sessions, Notes, Quality, Compare, Processing Project, Calibrations
- Session list with dates, exposure details, and file counts
- Processing Project tab: inspect stored files, upload `.xpsm` / `.xisf` / `.zip`, download project archives
- Calibrations tab: view auto-matched calibration masters or attach specific calibration groups
- Clicking a session opens Observation Detail

**Calibrations Library (`/calibrations`)**
- Master calibration cards grouped by type (darks, flats, bias, flat-darks)
- Filter by camera model, gain, exposure time, and sensor temperature
- Group expansion with subframe statistics and ADU metrics
- Batch selection and bundle download controls

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
| Heart icon               | Gallery cards, slideshow | Toggle favorite on an object                |
| Download button          | Observation Detail    | Download session files as a ZIP                |
| Upload Processed Image   | Observation Detail    | Attach your own processed image to a session   |
| Stretch / Contrast sliders | FITS Viewer         | Adjust raw image display                       |
| Add to Wishlist          | Planner → Targets     | Save a target for a future observing run       |
| Attach Calibration       | Object Detail → Calibrations | Explicitly link a calibration master group to an object |
| Download Bundle          | Calibrations Library  | Download selected calibration masters as a ZIP |
| Upload Project File      | Object Detail → Processing Project | Upload `.xpsm`, `.xisf`, `.pxi`, or scripts |
| Export Workspace Icons   | PixInsight Connector  | Save active PixInsight process icons and sync to Nebulis |
| Download Workspace       | PixInsight Connector  | Stream light frames and auto-matched calibrations for WBPP |
| Sync Now / Start Import  | Backup                | Trigger a new import from your telescope       |
| Prefetch Catalog Images  | Settings              | Download catalog imagery for offline use       |

### Themes

Nebulis supports three display themes, selectable in Settings:

- **Light**: standard bright interface
- **Dark**: dark background for general nighttime use
- **Night**: deep red-tinted interface to preserve dark adaptation at the telescope

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

- **Monitor storage regularly.** FITS sub-frame files can consume significant disk space. Use the Storage Dashboard to identify objects with large footprints and archive or delete data you no longer need.

- **Set a meaningful minimum altitude.** The default minimum altitude may include objects that are technically above the horizon but hidden behind obstructions. Raise the minimum or use a custom horizon profile to get accurate planner recommendations.

---

## Troubleshooting

### Telescope not found / Import fails to start

**Possible causes:**
- The Seestar is powered off or not connected to Wi-Fi.
- The hostname or IP address in Settings is incorrect.
- Your computer and the Seestar are on different network segments.

**Steps to resolve:**
1. Confirm the Seestar is powered on and shows a network connection in its own app.
2. Try pinging the hostname from your computer (open a terminal and type `ping seestar.local`).
3. If the hostname does not resolve, try the IP address instead. Check your router's device list to find the Seestar's current IP.
4. Go to **Settings → Telescope Connection** and update the address, then try importing again.
5. Check the **Backup** page. The Telescope Status indicator will show whether the device is reachable.

---

### No objects appear in the Gallery after import

**Possible causes:**
- The SMB share name is incorrect (Seestar).
- The wrong Dwarf model is selected, so the app looked in the wrong storage folder.
- The telescope's directory structure differs from expected.
- The import completed with errors.

**Steps to resolve:**
1. Go to **Settings → Telescope Connection** and verify the **Share Name** field. The default for Seestar devices is `EMMC Images`. Dwarf telescopes have no share name.
2. For a Dwarf, press **Test Connection** and check the storage folder it reports. If it does not match your model, correct the model selection and save again.
3. Check the **Backup** page for any error messages in the import log.
4. If sessions exist on the device but are not appearing, contact support with the import log output.

---

### Forecast data is not loading

**Possible causes:**
- No internet connection on the server running Nebulis.
- Observer location is not set.

**Steps to resolve:**
1. Go to **Settings → Observer Location** and confirm latitude, longitude, and timezone are filled in.
2. Verify the server has an active internet connection.
3. Reload the Forecast page. If the issue persists, the external forecast services (7Timer, Open-Meteo) may be temporarily unavailable. Try again in a few minutes.

---

### PixInsight Update Repository fails to connect or verify

**Possible causes:**
- Missing trailing slash in repository URL (`http://<host>:<port>/plugins/pixinsight/`).
- Incorrect port or unreachable server IP.
- Local firewall blocking TCP traffic.

**Steps to resolve:**
1. In PixInsight, go to **Resources → Updates → Manage Repositories** and ensure the URL ends with a trailing slash (`/`).
2. Test the URL in a web browser. The interactive Nebulis PixInsight repository portal should display.
3. Check that your container or server is listening on the expected port (default `8080`).

---

### PixInsight Connector reports authentication or connection error

**Possible causes:**
- API Key authentication is enabled in Nebulis but missing or invalid in the connector.
- Server URL in the connector's **Settings & Connection** tab points to an unreachable IP.

**Steps to resolve:**
1. Open the connector dialog via **Script → Nebulis → Nebulis Connector**.
2. Switch to the **Settings & Connection** tab.
3. In Nebulis, navigate to **Settings → Account** to copy or generate an API key, then paste it into the connector's **API Key** field.
4. Click **Test Connection**. A confirmation popup will indicate successful authorization.

---

### Calibration frames not auto-matching in PixInsight or Object Detail

**Possible causes:**
- No calibration masters in the library match the camera model, binning, or gain of the light subframes.
- Sensor temperature or exposure time exceeds configured tolerances.

**Steps to resolve:**
1. Navigate to **Calibrations** (`/calibrations`) and verify that Master Darks/Flats exist for the target camera model.
2. In the PixInsight connector's **Settings & Connection** tab, check the **Sensor Temp Tolerance** (default $\pm 2.0^\circ\text{C}$) and **Dark Exposure Tolerance** (default $15\%$). Increase these tolerances if your dark library was captured under varying ambient temperatures.
3. Alternatively, open the target's **Object Detail** page, go to the **Calibrations** tab, and explicitly click **Attach to Object** to force a 100% priority match.

---

### Planner shows no targets

**Possible causes:**
- Observer location is not configured.
- Minimum altitude is set too high, filtering out all objects.
- Custom horizon profile is blocking all azimuths.

**Steps to resolve:**
1. Go to **Settings → Observer Location** and confirm all fields are set.
2. Lower the **Minimum Altitude** value (try 10° as a starting point).
3. If using a custom horizon profile, check that it is not setting unrealistically high limits across all directions.

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
A: Not for core features. Browsing your gallery, reviewing sessions, calibrating frames, downloading PixInsight workspaces, and managing notes all work completely offline on your local network. The Forecast feature, Wikipedia object descriptions, and initial online catalog images require an internet connection. You can prefetch catalog images in advance for offline field use.

**Q: Can multiple people use Nebulis at the same time?**
A: Yes. The administrator can create accounts for multiple users. Each user has their own login, favorites, and watermark presets. All users share the same image library and calibration repository.

**Q: What file formats does Nebulis support?**
A: FITS (`.fit`, `.fits`) for raw science subframes and calibration frames, standard images (JPG, PNG) for display and processed results, video files (MP4, AVI), PixInsight process icons (`.xpsm`), PixInsight project and image files (`.pxi`, `.xisf`), and `.zip` project archives.

**Q: Can I use Nebulis with telescopes other than the Seestar S30/S50?**
A: Yes! Nebulis natively supports ZWO Seestar (S30 and S50) via SMB network sharing as well as DWARFLAB Dwarf (Dwarf II, Dwarf 3, and Dwarf Mini) via FTP. You can also manually upload FITS files and session images from any camera or telescope using manual observation logging.

**Q: Where are my files stored?**
A: All imported files are stored on the computer running Nebulis, in its configured data directory. They are not uploaded to any cloud service unless you explicitly download and share them yourself.

**Q: What happens if I delete a file in Nebulis?**
A: Deleting a file removes it from Nebulis's library. Whether the original file is also removed from the telescope's memory card depends on your configuration. Review your import settings to understand whether files are copied or moved.

**Q: Can I access Nebulis from my phone or tablet?**
A: Yes. The interface is responsive and works smoothly on mobile and tablet browsers. Dedicated companion apps are also available for iOS and tvOS.

**Q: How do I move a session to a different object?**
A: Open the session in **Observation Detail**. Look for the **Move Session** option in the file management controls. Select the correct target object and confirm. This is useful if a session was attributed to the wrong catalog entry.

**Q: The image quality scores seem low even though my images look fine. Why?**
A: Quality scores are calculated from raw FITS header data (HFR, FWHM, star count). Scores can be affected by narrow-field objects with few stars, high atmospheric dispersion at low altitudes, or calibration differences between firmware versions. Use scores as a relative guide, not an absolute standard.

**Q: Can I run a manual observation without connecting to a smart telescope?**
A: Yes. Navigate to **Observations → New Observation** to create a session manually, upload your own images, and add notes. This lets you log observations from any camera or telescope.

---

## Glossary

| Term             | Definition                                                                                          |
|------------------|-----------------------------------------------------------------------------------------------------|
| **Bortle Scale** | A numeric scale (1–9) measuring the darkness of the night sky. Lower is darker.                     |
| **Calibration Masters** | Integrated calibration frames (Master Darks, Flats, Bias) used to subtract thermal noise, hot pixels, and optical vignetting from raw exposures. |
| **DSS2**         | Digitized Sky Survey 2: a catalog of sky survey images used as reference images in Nebulis.         |
| **FITS**         | Flexible Image Transport System: the standard file format for scientific astronomical image data.  |
| **FTP**          | File Transfer Protocol: the protocol Dwarf telescopes use to expose their storage over Wi-Fi.       |
| **FWHM**         | Full Width at Half Maximum: a measure of star sharpness. Lower values indicate sharper stars.      |
| **HFR**          | Half-Flux Radius: a measure of star size in image data. Lower values indicate tighter, sharper stars. |
| **Integration time** | The total accumulated exposure time from all sub-frames combined in a session.                  |
| **Magnitude**    | A measure of an astronomical object's brightness. Lower numbers are brighter.                       |
| **mDNS**         | Multicast DNS: a protocol that allows devices to be found by name (e.g., `nebulis.local`) on a local network without manual IP entry. |
| **Moon illumination** | The percentage of the moon's visible face that is lit. High illumination increases sky glow and reduces contrast. |
| **NGC**          | New General Catalogue: a major catalog of deep-sky objects (galaxies, nebulae, clusters).          |
| **PJSR**         | PixInsight JavaScript Runtime: PixInsight's native automation scripting environment.               |
| **RA / Dec**     | Right Ascension and Declination: the celestial coordinate system used to locate objects in the sky. |
| **Seeing**       | A measure of atmospheric steadiness. Poor seeing causes stars to twinkle and appear blurry.         |
| **SMB**          | Server Message Block: a network file-sharing protocol used by Seestar to expose its storage.       |
| **Station mode** | A Dwarf setting that joins the telescope to your home Wi-Fi instead of it broadcasting its own.    |
| **Sub-frame**    | A single, unprocessed exposure captured by the telescope. Multiple sub-frames are later combined (stacked). |
| **Transparency** | A measure of atmospheric clarity (absence of haze, dust, and humidity). High transparency improves contrast. |
| **Transit**      | The moment when an object crosses the meridian and reaches its highest point in the sky.            |
| **WBPP**         | Weighted Batch Preprocessing: PixInsight's standard calibration, registration, and stacking pipeline. |
| **Wishlist**     | A personal list of targets you plan to image in a future observing session.                         |
| **XPSM**         | XML Process State Module: PixInsight's standard format for serialized process icons and pipelines.  |
| **XRI**          | XML Repository Information: PixInsight's official update repository specification.                 |

---

## Support

### Getting Help

- **In-app feedback:** If your administrator has set up a feedback channel, use it to report issues or request features.
- **Application issues:** Report bugs or feature requests at the project's issue tracker. *(Contact your administrator for the link.)*
- **Community:** The smart telescope and astrophotography user community is an excellent resource for questions about telescope operation, imaging techniques, and Nebulis usage.

### Contacting Your Administrator

If you are using Nebulis on a shared server managed by someone else, they are your first point of contact for:
- Account creation and password resets
- Network configuration and telescope connectivity
- Storage and import settings

---

## Assumptions

The following assumptions were made while writing this guide, based on the application code and structure. If any of these do not match the actual application behavior, the relevant sections may need revision.

1. **Import trigger:** It is assumed there is a "Start Import" or "Sync Now" button on the Backup page. The exact label may differ in the final UI.
2. **File deletion scope:** The behavior of file deletion (whether it removes files from the telescope's storage or only from the local library) was not confirmed in the code and is labeled as configuration-dependent.
3. **Move session UI label:** The "Move Session" option is described based on backend route functionality. The exact UI label may differ.
4. **Custom horizon profile:** The profile uses 36 azimuth buckets of 10° each, based on the data model. The UI for entering this data may present it differently (sliders, a graph, or a table).
5. **Prefetch option location:** The catalog prefetch option is placed under Settings → Catalog & Display based on logical grouping; its exact placement in the UI may differ.
6. **Port number:** The default port in production and Docker containers is 8080. The example URLs reflect this default.
7. **Video playback:** Video files are noted as stored but playback capability was not verified; browser support language was used as a caveat.
