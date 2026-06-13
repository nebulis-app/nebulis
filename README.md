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
- Import frames into a managed local library; combine and process sub-frames
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

## License

[GNU Affero General Public License v3.0](LICENSE)
