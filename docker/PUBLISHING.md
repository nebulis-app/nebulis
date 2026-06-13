# Publishing Nebulis to GHCR

Images are published automatically to the GitHub Container Registry when a version tag is pushed.

- **Registry:** `ghcr.io/nebulis-app/nebulis`
- **Workflow:** `.github/workflows/docker-publish.yml`
- **Architectures:** `linux/amd64`, `linux/arm64`

---

## Releasing a new version

### 1. Bump the version

Update the `version` and `buildNumber` fields in `package.json`.

### 2. Commit and push the version bump

```bash
git add package.json
git commit -m "chore: bump version to X.Y.Z"
git push
```

### 3. Push a version tag

The publish workflow triggers on any tag matching `v*.*.*`:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

GitHub Actions will build both architectures and push:

```
ghcr.io/nebulis-app/nebulis:X.Y.Z
ghcr.io/nebulis-app/nebulis:latest
```

### 4. Verify

Once the Actions run completes, check the package page:

```
https://github.com/nebulis-app/nebulis/pkgs/container/nebulis
```

---

## Tagging conventions

| Tag        | Meaning                                           |
| ---------- | ------------------------------------------------- |
| `X.Y.Z`    | Immutable release, matches `package.json` version |
| `latest`   | Moving pointer to the newest stable release       |

For pre-releases, push a `vX.Y.Z-beta` tag. The workflow strips the `v` prefix
so the image tag becomes `X.Y.Z-beta`. Do not manually retag `latest` for
pre-releases — the workflow only moves `latest` on full `v*.*.*` tags.

---

## Making the package public

On first push, GHCR packages default to private. Make it public once:

1. Go to `https://github.com/nebulis-app/nebulis/pkgs/container/nebulis`
2. Click **Package settings**
3. Under **Danger Zone**, change visibility to **Public**

After that, anyone can `docker pull ghcr.io/nebulis-app/nebulis:latest` without
authentication.

---

## Running the published image

```bash
docker run -d \
  -p 8080:8080 -p 47890:47890/udp \
  -v nebulis-data:/app/data \
  ghcr.io/nebulis-app/nebulis:latest
```

Or with Docker Compose — replace the `build:` block with the image reference:

```yaml
services:
  nebulis:
    image: ghcr.io/nebulis-app/nebulis:latest
```
