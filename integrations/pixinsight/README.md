# Nebulis PixInsight Connector

The **Nebulis PixInsight Connector** is an official PJSR (PixInsight JavaScript Runtime) script that integrates PixInsight directly with your Nebulis astrophotography library.

It enables browsing catalog objects, selecting imaging sessions, automatically detecting and matching compatible calibration frames (Master Darks, Flats, Bias, and Flat-Darks), downloading ready-to-process workspace bundles, and synchronizing PixInsight process icons (`.xpsm`) and project archives back to Nebulis.

---

## Features

- **Object & Session Browser (Tab 1: Library & Download)**:
  - Live search and filter across your entire Nebulis library by object name (e.g., *M42*, *NGC 7000*, *IC 1805*), catalog identifier, constellation, or object type.
  - Live DSO image preview thumbnail fetched and rendered directly in PixInsight.
  - View session dates, subframe counts, filter bands with exposure duration (e.g. `H (180.0s)`), and telescope rig attribution.
  - One-click download of raw light subframes directly into your local workspace.

- **Calibration Library Browser (Tab 2: Calibration Library)**:
  - Browse your entire calibration library (Master Darks, Flats, Bias, and Flat-Darks) across all telescope rigs.
  - **Linked Target Object for Flats**: For Flats and Flat-Darks, the **Linked Object** column displays which DSO target and session date the flat is attached to (e.g. `NGC 6888 (2026-09-11)`).
  - Search and filter by calibration type (*All*, *Darks*, *Flats*, *Bias*, *Flat-Darks*) or keyword.
  - Expand calibration sets to inspect individual FITS subframe files, sizes, and timestamps.
  - Select and batch download calibration bundles into your local calibrations directory.

- **Project & Workflow Synchronization (Tab 3: Project Sync)**:
  - One-click export and upload of your active PixInsight workspace process icons (`.xpsm`) directly to the target object's `processing_project/` folder on Nebulis.
  - Upload `.xisf` master stacks, process scripts, or `.zip` project archives.
  - Inspect and restore previous project files stored on the server.

- **Dedicated Settings Dialog (`NebulisSettingsDialog`)**:
  - Callable via the `⚙ Settings` tool button in the main window header or bottom bar.
  - Configures server URL, user API key (`neb-` prefix) with instant connection testing, projects root download directory, and download acceleration.

- **Cross-Platform & Native PJSR**:
  - Compatible with PixInsight $\ge$ 1.8.9 and PixInsight 1.9.x on macOS (ARM64/Apple Silicon and Intel), Linux, and Windows.
  - Version strictly aligned with the Nebulis application version (currently `v2.1.0`).
  - High-performance transfer mode with automatic system `curl` accelerator via `ExternalProcess`.

---

## Installation

### Method 1: PixInsight Update Repository (Recommended & Automatic Updates)

Nebulis hosts an official PixInsight update repository adhering to PixInsight's `updates.xri` specification. Adding this repository once ensures you always have the latest version of the connector without manual file copies:

1. Launch PixInsight.
2. In the top menu, navigate to:
   **`Resources` $\to$ `Updates` $\to$ `Manage Repositories`**
3. Click **`Add`**.
4. Enter the Nebulis repository URL (with the trailing slash):
   ```text
   http://<your-nebulis-host>:<port>/plugins/pixinsight/
   ```
   *(For example: `http://localhost:3000/plugins/pixinsight/` or `https://nebulis.local/plugins/pixinsight/`)*
5. Click **`OK`**, then **`OK`** again to close the dialog.
6. Check for updates:
   **`Resources` $\to$ `Updates` $\to$ `Check for Updates`**
7. PixInsight will find **`Nebulis Connector for PixInsight`**. Click **`Apply updates`** and restart PixInsight when prompted.
8. The script is now available in **`Script` $\to$ `Nebulis` $\to$ `Nebulis Connector`**.

*(You can also visit `http://<your-nebulis-host>:<port>/plugins/pixinsight/` in any web browser for a quick copy button, installation walkthrough, and direct downloads).*

### Method 2: Feature Script (Manual Copy)

1. Copy or clone the `integrations/pixinsight/` directory to your local machine (e.g. `~/PixInsight/scripts/nebulis/`).
2. Launch PixInsight.
3. In the PixInsight top menu, navigate to:
   **`Script` $\to$ `Feature Scripts...`**
4. In the Feature Scripts dialog, click **`Add...`**.
5. Select the folder containing `NebulisConnector.js`.
6. PixInsight will scan and notify you:
   > *1 additional feature script(s) were found.*  
   > *Title: Nebulis Connector (Script > Nebulis > Nebulis Connector)*
7. Click **`Done`**.
8. The script is now available in PixInsight via **`Script` $\to$ `Nebulis` $\to$ `Nebulis Connector`**.

### Method 3: Direct Execution via Script Editor

1. In PixInsight, open **`File` $\to$ `Open...`** and select `NebulisConnector.js`.
2. Press **`F9`** (or click **`Execute` $\to$ `Compile & Run`**).

---

## Workspace Directory Structure

When downloading an object with calibrations, the connector organizes the destination folder as follows:

```text
<DownloadDir>/
└── <ObjectName>/
    ├── sessions_bundle.zip         # Raw lights and session files
    ├── calibrations_bundle.zip     # Matched darks, flats, bias
    ├── calibrations/
    │   ├── darks/                  # Matched master darks
    │   ├── flats/                  # Matched master flats (per filter)
    │   ├── bias/                   # Matched master bias
    │   └── flatdarks/              # Matched flat darks
    └── processing_project/         # PixInsight project files & .xpsm icons
        └── <ObjectName>_workflow.xpsm
```

This layout can be loaded directly into PixInsight's **WeightedBatchPreprocessing (WBPP)** script:
- Lights $\to$ Directory or File list
- Darks $\to$ `calibrations/darks/`
- Flats $\to$ `calibrations/flats/`
- Bias $\to$ `calibrations/bias/`

---

## Configuration & Settings

Open the **Settings & Preferences** sub-window by clicking the **`⚙ Settings`** tool button in the connector header or bottom bar:

| Setting | Default | Description |
| :--- | :--- | :--- |
| **Nebulis Server URL** | `http://localhost:3002` | Address of your Nebulis instance (e.g. `http://localhost:3002` or `https://nebulis.local`). |
| **API Key** | *(empty)* | User-linked API key generated under Nebulis **Settings → Account → API Keys** (prefixed with `neb-`). |
| **Download Directory / Projects Root** | `~/AstroProjects` | Base local directory where object folders and light subframes are saved. |
| **Store in Shared Calibration Folder** | `Disabled` | Toggle to save calibration frames in a central shared library instead of per-object folders. |
| **Shared Calibration Directory** | `~/AstroProjects/Calibrations` | Dedicated directory for Master Darks, Flats, and Bias when shared storage is enabled. |
| **Lights Subfolder Name** | `lights` | Subfolder name for light frames inside the object workspace. |
| **Calibrations Subfolder Name** | `calibrations` | Subfolder name for calibrations when stored inside the object workspace. |
| **Project Subfolder Name** | `processing_project` | Subfolder name for PixInsight project files and `.xpsm` process icons. |
| **Sensor Temp Tolerance** | `2.0 °C` | Acceptable temperature difference when matching dark frames ($\pm^\circ\text{C}$). |
| **Dark Exposure Tolerance**| `15%` | Acceptable exposure duration difference when matching dark frames. |
| **Fast Download Mode** | `Enabled` | Uses system `curl` via `ExternalProcess` for accelerated transfers when available. |

Click **Test Connection** to verify server connectivity and permissions, then click **Save Settings**.

---

## Workflows

### 1. Downloading Lights for an Object

1. Launch **Nebulis Connector** from **`Script` $\to$ `Nebulis` $\to$ `Nebulis Connector`**.
2. On the **`Library & Download`** tab, select your target object from the list.
3. The connector displays:
   - Target details and live DSO image preview thumbnail.
   - Available imaging sessions with filter, exposure, subframe counts, and telescope rig.
   - Local destination lights path.
4. Click **`Download Light Subframes (Sessions)`**.

### 2. Browsing & Downloading Calibrations

1. Switch to the **`Calibration Library`** tab (or click **`Go to Calibration Library ➔`** from the object tab).
2. Browse your available Darks, Flats, Bias, and Flat-Darks.
   - For Flats, the **`Linked Object`** column shows which target and session date the flat is attached to (e.g. `NGC 6888 (2026-09-11)`).
3. Select the calibration bundles you need and click **`Download Selected Calibrations`**.
4. The files are downloaded into your configured calibrations directory.

---

## Calibration Auto-Matching Algorithm

The connector includes an intelligent multi-criteria scoring and filtering engine (`CalibrationMatcher`) designed to select optimal calibration masters from your Nebulis library:

### 1. Attachment Precedence
- **Directly Attached Calibrations**: If calibration frames or groups were explicitly linked to the object in the Nebulis web interface, they are awarded **100% confidence** and automatically prioritized.

### 2. Multi-Criteria Scoring for Library Masters
For unattached calibration masters stored in the Nebulis Calibration Library, the engine evaluates compatibility across multiple dimensions:

| Dimension | Rule & Scoring | Incompatibility Criterion |
| :--- | :--- | :--- |
| **Camera Model** | Exact or substring match awards **+40 points**; generic camera awards **+20 points**. | If camera models conflict, the frame is rejected. |
| **Binning** | Matching binning (e.g. `1x1`, `2x2`) awards **+15 points**. | Different binning rejects the frame. |
| **Gain / Offset** | Matching gain (within $\pm 0.1$) awards **+15 points**. | Conflicting gain rejects the frame. |
| **Dark Exposure** | Exposure duration within `expTolerance` (default 15% or $< 0.5\text{s}$) awards **+20 points**. | Difference $> 15\%$ rejects the dark. |
| **Sensor Temperature** | Sensor temperature within `tempTolerance` (default $\pm 2.0^\circ\text{C}$) awards **+10 points**. | Temperature delta $> 2.0^\circ\text{C}$ rejects the dark. |
| **Flat Filter** | Optical filter match (e.g. `Ha`, `OIII`, `L`, `Dual-Band`) awards **+30 points**. | Filter mismatch rejects the flat. |
| **Bias / Offset** | Standard zero-length offset frame awards **+20 points**. | Camera/gain/binning must match. |

A dark frame must achieve a composite score $\ge 50$ to be recommended. All matched items display human-readable justification badges in the connector UI (e.g., `Camera match (ASI585MC), Exposure 10s, Gain 100`).

---

## Project Synchronization & Workflow Archiving

Nebulis provides a dedicated `processing_project/` folder for every deep-sky object in your library. The PixInsight connector facilitates two-way synchronization:

### Exporting Process Icons (`.xpsm`)
1. Create process icons in your active PixInsight workspace representing your workflow pipeline (e.g. DynamicBackgroundExtraction, BlurXTerminator, StarXTerminator, GeneralizedHyperbolicStretch, ColorCalibration).
2. Switch to the **Project Sync** tab in the connector dialog.
3. Click **`Export Current Active Workspace Icons (.xpsm)...`**.
4. The connector saves the icon set locally and uploads it via base64 streaming directly to `<object>/processing_project/<ObjectName>_workflow.xpsm` on your Nebulis server.

### Archiving Project Files & Masters
- Click **`Upload Local File to Nebulis Project...`** to upload:
  - Final integrated `.xisf` master stacks.
  - PixInsight project files (`.pxi`).
  - PJSR processing automation scripts (`.js`).
  - Full `.zip` project archives containing process history and masks.
- Previous project files stored on the server are displayed in the Project Sync file tree with file size and modification timestamps, allowing easy team collaboration and multi-workstation continuity.

---

## Troubleshooting

### Repository Update Fails in PixInsight
- **Symptom**: PixInsight reports `Error: Repository update failed` or cannot locate `updates.xri`.
- **Solution**:
  1. Verify the URL includes the trailing slash: `http://<host>:<port>/plugins/pixinsight/`.
  2. Open the URL in a web browser to confirm the server is reachable and `updates.xri` downloads correctly.
  3. Ensure no local firewall or proxy is intercepting port `8080` (or your configured HTTP port).

### Connection Fails / NetworkTransfer Error
- **Symptom**: "Failed to connect to Nebulis server" or "Connection refused".
- **Solution**:
  1. Check **Settings & Connection** in the connector. Verify the server hostname or LAN IP (e.g., `http://192.168.1.50:8080`).
  2. If authentication is enabled in Nebulis, generate an API key in **Settings → Account** and paste it into the **API Key** field in PixInsight.
  3. Click **Test Connection** to validate credentials.

### SSL / HTTPS Certificate Warnings
- **Symptom**: SSL handshake errors or untrusted certificate warnings when using HTTPS.
- **Solution**:
  - PixInsight enforces strict SSL/TLS certificate verification. If you are using a self-signed HTTPS certificate, either import your CA certificate into your operating system's trust store or connect via plain HTTP on your local home network.

### Slow Workspace Downloads
- **Symptom**: Large session archives take a long time to download.
- **Solution**:
  - Ensure **Fast Download Mode** is enabled in the connector settings. On systems with `curl` available in the system PATH, the connector delegates binary file streaming to `ExternalProcess`, significantly accelerating transfers.

### Script Not Showing in PixInsight Menu
- **Symptom**: After updating, **`Script > Nebulis > Nebulis Connector`** does not appear.
- **Solution**:
  1. Restart PixInsight completely.
  2. Go to **`Script` $\to$ `Feature Scripts...`**, click **`Add`**, and select PixInsight's `src/scripts/Nebulis/` folder. Click **`Done`**.

---

## Backend API Endpoints Utilized

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/api/v1/library/objects` | `GET` | Retrieve library object catalog. |
| `/api/v1/library/objects/:id/sessions` | `GET` | List imaging sessions for selected object. |
| `/api/v1/library/objects/:id/files` | `GET` | List individual subframe files. |
| `/api/v1/library/download/objects/:id` | `GET` | Stream zip archive of session light frames. |
| `/api/v1/library/calibrations` | `GET` | Query calibration library groups. |
| `/api/v1/library/calibrations/attachments` | `GET` | Query calibrations directly attached to the object. |
| `/api/v1/library/calibrations/download/link` | `POST` | Generate calibration bundle token. |
| `/api/v1/library/calibrations/download/:id` | `GET` | Stream matched calibration zip bundle. |
| `/api/v1/library/objects/:id/processing-project` | `GET` | Inspect remote project files on Nebulis. |
| `/api/v1/library/objects/:id/processing-project/file` | `POST` | Upload process icon (`.xpsm`) or project file. |
| `/api/v1/library/objects/:id/project-archives` | `POST` | Upload full project zip archive. |

---

## Automated Testing

Unit tests for the PixInsight connector and its matching engine are located in `tests/backend/pixinsightPlugin.test.ts`. Run them via:

```bash
npx vitest run tests/backend/pixinsightPlugin.test.ts
```
