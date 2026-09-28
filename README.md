# Nebulis

**Your universe. Captured. Beautifully organized.**

A full image library, observation planner, and sky forecast for your smart telescope. Self-hosted, runs on your own hardware, accessible from any browser on your network.

**[nebulis.app](https://nebulis.app)** — macOS, Windows, iOS, tvOS, and Android apps also available.

**Supported telescopes:** ZWO SeeStar S30 / S50, DWARFLAB Dwarf II / Dwarf 3 / Dwarf Mini

---

![Library view](https://nebulis.app/screenshots/library.png)

---

## Features

- Import imaging sessions and sub-frames directly from your telescope's network share
- Native FITS viewer with header inspection and per-frame satellite trail detection
- Astronomical catalog enrichment: Messier, NGC, IC, Sharpless, Caldwell
- Observation planner with altitude charts for 5,000+ deep-sky objects, drag-and-drop scheduling
- Sky forecast combining cloud cover, humidity, atmospheric seeing, and lunar phase
- Dedicated Calibration Library managing master darks, flats, bias, and flat-darks with automatic object matching
- Processing project tracking & archives for PixInsight and Siril workflows
- Native PixInsight Integration via official update repository (`/plugins/pixinsight/`): automated workspace downloads ready for WBPP, calibration auto-detection, and two-way process icon (`.xpsm`) sync
- Multi-user auth with device pairing (iOS / tvOS companion app)
- Light and dark theme

![Planner view](https://nebulis.app/screenshots/planner.png)

---

## Docker Compose

```yaml
services:
  nebulis:
    image: ghcr.io/nebulis-app/nebulis:latest
    container_name: nebulis
    restart: unless-stopped
    ports:
      - "8080:8080"        # Web interface
      - "47890:47890/udp"  # LAN discovery (optional)
    volumes:
      - nebulis-data:/app/data
    environment:
      - ADVERTISED_HOST=192.168.1.50  # your server's LAN IP

volumes:
  nebulis-data:
```

```bash
docker compose up -d
```

Open **http://localhost:8080** (or your server IP) and complete the onboarding.

---

## Environment Variables

| Variable          | Default        | Description |
| ----------------- | -------------- | ----------- |
| `PORT`            | `8080`         | HTTP listen port inside the container |
| `ADVERTISED_HOST` | _(auto)_       | LAN IP advertised to the iOS app for auto-discovery. Set this if the app can't find the server automatically. |
| `LOG_LEVEL`       | `info`         | `trace`, `debug`, `info`, `warn`, or `error` |
| `JWT_SECRET`      | _(auto-saved)_ | Auth signing secret. Auto-generated on first start and saved to `/app/data/.jwt-secret`. |
| `DATA_KEY`        | _(auto-saved)_ | Encryption key for stored telescope passwords. Auto-generated and saved to `/app/data/.data-key`. Keep this stable — changing it makes existing credentials unreadable. |

---

## Volumes

| Path              | Purpose |
| ----------------- | ------- |
| `/app/data`       | Database, settings, secrets, thumbnail cache. Keep this on a persistent volume. |
| `/media` (optional, read-only) | Bind-mount the path where USB telescope drives appear for direct SD card access. |

---

## Updating

```bash
docker compose pull && docker compose up -d
```

Your data and logins survive the update as long as `/app/data` is on a persistent volume.

---

## Setup

1. Open the web interface after starting the container.
2. Complete the onboarding: set your location, units, and theme.
3. Go to **Settings → Hardware** and add your telescope. Choose SeeStar or Dwarf, then enter its IP address and network share path, or point to a locally mounted USB path.
4. Create an admin account under **Settings → Account**.

---

## PixInsight Integration

Nebulis includes an official PixInsight JavaScript Runtime (PJSR) connector script and hosts an embedded PixInsight update repository, enabling seamless integration between your observatory library and PixInsight (versions $\ge$ 1.8.9 and 1.9.x on macOS, Linux, and Windows). The connector version is always synchronized with the Nebulis application version (currently **`v2.1.0`**).

### Adding the Update Repository to PixInsight

Nebulis serves an official PixInsight update repository directly from your server. Adding this repository once ensures automated installation and future updates:

1. Launch PixInsight and navigate to:  
   **Resources → Updates → Manage Repositories**
2. Click **Add** and enter your Nebulis repository URL:
   ```text
   http://<nebulis-host>:<port>/plugins/pixinsight/
   ```
   *(e.g., `http://192.168.1.50:8080/plugins/pixinsight/` or `http://localhost:3002/plugins/pixinsight/`)*
3. Click **OK**, then check for updates via:  
   **Resources → Updates → Check for Updates**
4. PixInsight will detect **Nebulis Connector for PixInsight (v2.1.0)**. Click **Apply updates** and restart PixInsight when prompted.
5. Launch the connector anytime from:  
   **Script → Nebulis → Nebulis Connector**
6. Authenticate using your user-linked **API Key** (generated in Nebulis under **Settings → Account → API Keys**, prefixed with `neb-`).

> **Tip:** You can visit `http://<nebulis-host>:<port>/plugins/pixinsight/` in any desktop browser to view the interactive repository portal, copy the URL with one click, or download standalone `.js`, `.tar.gz`, and `.zip` packages.

### Integration Capabilities

- **Library Download**: Search and inspect deep-sky objects with live DSO screenshot previews, session breakdowns (subframe counts, optical filters, exposure durations), and one-click download of raw light subframes.
- **Calibration Library Browser**: Full browser for all Master Darks, Flats, Bias, and Flat-Darks. For Flats, the linked target object (e.g. `NGC 6888`) is explicitly displayed. Batch download calibration bundles directly into your local calibrations folder.
- **Two-Way Project & Icon Sync**: Export active PixInsight workspace process icons (`.xpsm`) or upload `.zip` project archives and master stacks directly into the target object's `processing_project/` folder on Nebulis.
- **Dedicated Settings Dialog**: Configure server URL, user API key, local download directory, and download acceleration from a dedicated modal sub-window callable via the `⚙ Settings` icon.

---

## Calibration Library & Processing Projects

- **Calibration Library (`/calibrations`)**: Maintain dedicated libraries for master darks, flats, bias, and flat-darks. Inspect sensor metadata, exposure times, and temperatures, and attach specific calibration sets to objects or allow library-wide automatic matching.
- **Processing Projects**: Store and track working project files (`.xpsm` icon sets, `.xisf` master stacks, Siril scripts, and `.zip` archives) directly with each deep-sky object in its `processing_project/` directory. Accessible directly from the object detail view and via the PixInsight connector.

---

## License

[GNU Affero General Public License v3.0](LICENSE)
