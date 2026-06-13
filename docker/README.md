# Nebulis

Self-hosted astrophotography planning & telescope control server. Runs the
Nebulis web app (single-page UI + REST API) from one container — plan deep-sky
targets, browse the sky map, manage observation notes, and connect to telescopes
(Dwarf, Seestar, and RTSP/SMB sources) on your local network.

- **Image:** `ghcr.io/nebulis-app/nebulis`
- **Architectures:** `linux/amd64`, `linux/arm64`
- **Source / docs:** https://github.com/nebulis-app/nebulis

## Supported tags

| Tag       | Description                                         |
| --------- | --------------------------------------------------- |
| `latest`  | Newest stable release                               |
| `X.Y.Z`   | Specific immutable release (e.g. `1.3.1`)           |
| `X.Y.Z-beta` | Pre-release builds (no `latest` pointer)         |

---

## Quick start

```bash
docker run -d \
  --name nebulis \
  -p 8080:8080 \
  -p 47890:47890/udp \
  -v nebulis-data:/app/data \
  ghcr.io/nebulis-app/nebulis:latest
```

Open **<http://localhost:8080>** and create the first admin account.

### Docker Compose

```yaml
services:
  nebulis:
    image: ghcr.io/nebulis-app/nebulis:latest
    container_name: nebulis
    restart: unless-stopped
    ports:
      - "8080:8080"        # HTTP — SPA + API (change left 8080 to any free host port)
      - "47890:47890/udp"  # LAN discovery
    volumes:
      - nebulis-data:/app/data
      # Optional: expose plugged-in Dwarf USB drives to the container.
      # macOS host: add /Volumes under Docker Desktop → Settings → Resources →
      # File Sharing first. Linux host: use /media or /mnt instead of /Volumes.
      - /Volumes:/media:ro
    environment:
      - PORT=3002
      - NODE_ENV=production
      # - ADVERTISED_HOST=192.168.1.50   # see "LAN discovery" below

volumes:
  nebulis-data:
```

```bash
docker compose up -d
```

---

## Ports

| Port        | Proto | Purpose                                             |
| ----------- | ----- | --------------------------------------------------- |
| `8080`      | TCP   | HTTP — serves the SPA and the REST API. Map to any host port you like. |
| `47890`     | UDP   | LAN auto-discovery (so clients find the server)     |

The image serves **HTTP only**; terminate TLS at a reverse proxy if you need
HTTPS.

## Volumes

| Path         | Purpose                                                          |
| ------------ | --------------------------------------------------------------- |
| `/app/data`  | SQLite database, settings, observation notes, and auto-generated `.jwt-secret` / `.data-key`. **Persist this** to keep your data and logins across restarts/upgrades. |
| `/media` (ro)| Optional. Bind-mount the host volume where USB telescope drives appear so Dwarf detection can find them. |

> Keep `/app/data` on a named volume or host bind-mount. If you delete it, the
> auto-generated encryption key and JWT secret are lost — stored telescope
> credentials can no longer be decrypted and all users are logged out.

## Environment variables

| Variable          | Default            | Description                                                            |
| ----------------- | ------------------ | --------------------------------------------------------------------- |
| `PORT`            | `8080`             | HTTP listen port.                                                     |
| `NODE_ENV`        | `production`       | Leave as `production`.                                                |
| `ADVERTISED_HOST` | _(auto LAN IP)_    | Set to the host's LAN IP so UDP discovery returns a reachable address (see below). |
| `SERVER_HOSTNAME` | _(OS hostname)_    | Override the advertised hostname.                                     |
| `DATA_DIR`        | `/app/data`        | Where the DB, secrets, and notes live. Change only if you remap the volume. |
| `LOGS_DIR`        | `{DATA_DIR}/logs`  | Log output directory.                                                 |
| `LOG_LEVEL`       | `info`             | `trace`, `debug`, `info`, `warn`, or `error`.                        |
| `JWT_SECRET`      | _(auto-persisted)_ | Auth signing secret. Auto-generated into `/app/data/.jwt-secret` if unset. Set explicitly for fixed multi-instance deployments. |
| `DATA_KEY`        | _(auto-persisted)_ | Base64-encoded **32 bytes** used to encrypt stored telescope passwords. Auto-generated into `/app/data/.data-key` if unset. If you set it, keep it stable — changing it makes existing credentials undecryptable. |

### LAN discovery in Docker

Containers can't see the host's external IP, so UDP discovery may advertise an
unreachable address. If clients can't find the server automatically, set
`ADVERTISED_HOST` to the host machine's LAN IP:

```bash
-e ADVERTISED_HOST=192.168.1.50
```

---

## Health check

The image ships a built-in healthcheck against:

```
GET http://127.0.0.1:3002/api/v1/health
```

Check status with `docker ps` (look for `healthy`) or `docker inspect`.

---

## Updating

```bash
# Compose
docker compose pull && docker compose up -d

# Plain docker
docker pull ghcr.io/nebulis-app/nebulis:latest
docker stop nebulis && docker rm nebulis
# re-run the `docker run …` command above
```

Because `/app/data` is a persistent volume, your database, settings, logins, and
telescope credentials survive the upgrade.
