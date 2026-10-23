# PixInsight connector

The Nebulis Connector is a PixInsight script that talks to your Nebulis server. From inside PixInsight it can:

- **Library & Download**: browse your objects and download a night's raw sub-frames, unpacked into your working folder.
- **Calibration Library**: list your darks, flats, bias and flat-darks, suggest the ones that match your lights, and download them.
- **Project Sync**: store process icons (`.xpsm`), `.pxiproject` files or a `.zip` of a whole project with the object, under *Project archives* (the same place the web app shows them). Uploading needs an **admin** key.

## Set up

1. **Turn it on.** Settings → Features → PixInsight integration, then save. It is off by default; while off, `/plugins/pixinsight/` answers 404.
2. **Add the repository in PixInsight.** Resources → Updates → Manage Repositories → Add, and paste the URL shown under the switch (`http://<server>:<port>/plugins/pixinsight/`, keep the trailing slash). Then Resources → Updates → Check for Updates, apply, and restart PixInsight. The connector is versioned with Nebulis, so a Nebulis upgrade offers a matching connector.
3. **Create an API key.** Settings → API keys → New key. Copy it; it is shown once.
4. **Connect.** In PixInsight: Script → Nebulis → Nebulis Connector → Settings. Enter the server address and the key, and test the connection.

No repository? You can also download `NebulisConnector.js` from `/plugins/pixinsight/` and add it through Script → Feature Scripts.

## Requirements

- PixInsight 1.8.9 or 1.9.x.
- The `curl` command on the machine running PixInsight (included with Windows 10 and later, macOS and most Linux systems). Uploads, downloads and API calls go through it. The API key is passed to curl through a temporary file, not on the command line.
- `tar` (Windows 10+, macOS) or `unzip` (most Linux) to unpack downloaded sub-frames. If neither works the zip is left in the folder for you to unpack.

## API keys

- A key acts as its owner, with the owner's role. Demoting a user demotes their keys; deleting a user deletes them.
- Keys cannot create or revoke keys. Use a signed-in browser session for that.
- Revoke a key in Settings → API keys. Admins can see and revoke everyone's.
- Send a key as `X-API-Key: neb-…` (or `Authorization: Bearer neb-…`) to use the HTTP API from your own scripts.

## For maintainers

- The script lives at `server/assets/pixinsight/NebulisConnector.js`. The server pins its `NEBULIS_VERSION` to the app version when it serves it.
- It can't run in CI. `tests/backend/pixinsightContract.test.ts` is the guard: it lists every endpoint the script calls and checks every response field it reads. If you change an API shape that test covers, update the script in the same commit.
- Release builds (Windows, macOS) stage the script as `assets/pixinsight/NebulisConnector.pjsr` next to the bundled server, because `pkg` would otherwise try to compile it as Node JavaScript. See `scripts/build-win.mjs` and `scripts/build-mac.mjs`.
