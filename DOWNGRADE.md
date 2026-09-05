# Going back to an older Nebulis version

Nebulis upgrades are one-way by design: the built-in updater only ever installs
a newer build, and the database schema changes it applies on first boot are not
reversed automatically. If you need to return to an older release, this is how.

## What makes a downgrade safe

**A database backup.** Nebulis takes one automatically. Just before it applies
the schema changes for a new version, it copies the whole database into
`{DATA_DIR}/backups/` while it still holds the old layout and data. The newest
three of each kind are kept (`upgrade` = automatic, `manual` = you clicked "Back
up now"). You can see them, download them, or make one at **Settings → Storage →
Backups**.

A `RESTORE.txt` with these same steps is written next to the backup files.

### What the backup does not include

Your imported images and the library folder. Upgrades never rewrite those files,
but a major version can change the library folder *layout* on disk (for example,
normalising an object folder's name). If you restore an old database and the
folders it points at were renamed, the two will not line up. For a major upgrade,
also keep your own copy of the whole `DATA_DIR` and the library folder.

The data directory is:

| Platform | `DATA_DIR` |
|---|---|
| Docker | the volume mounted at `/app/data` |
| Windows | `C:\ProgramData\Nebulis\data` |
| macOS | `~/Library/Application Support/Nebulis` |
| Linux / dev | `./data` next to the app |

## Steps

### 1. Stop Nebulis

| Platform | How |
|---|---|
| Docker | `docker compose down` |
| Windows | Stop the **Nebulis** service: `net stop Nebulis`, or use `services.msc` |
| macOS | Quit Nebulis from the menu bar |

### 2. Put the backup in place of the live database

In `DATA_DIR`:

1. Delete or rename `nebulis.db`.
2. Delete `nebulis.db-wal` and `nebulis.db-shm` if they are present.
3. Copy your chosen `backups/nebulis-db-<timestamp>-v<version>-<kind>.db` to
   `nebulis.db`.

If you downloaded the backup from the Backups screen it arrives gzipped
(`.db.gz`); decompress it first (`gunzip` on macOS/Linux, any archive tool on
Windows).

### 3. Install the older version

- **Docker**: change the image tag in `docker-compose.yml` back to the older
  version, then `docker compose up -d`.
- **Windows / macOS**: download the older installer from nebulis.app and run it.
  It installs over the current one.

### 4. Start Nebulis

Start the service / container / app again. It should come up on the restored
database with no migration to run.

### If telescope connections show a credential error afterwards

The at-rest encryption key (`.data-key`) changed at some point between the two
installs. Re-enter the SMB or FTP password for each telescope at **Settings →
Telescopes**. Nothing else is affected.

## Known gap: downgrade, then upgrade again

The older build has none of the backup code and never updates the version marker
(`{DATA_DIR}/.last-version`). So a downgrade does not create a snapshot, and if
you later re-upgrade to the exact version you came from, Nebulis sees an
unchanged marker and does not snapshot again either. If you expect to move back
and forth, download a backup and keep it yourself before each switch.
