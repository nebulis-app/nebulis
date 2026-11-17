# Backing up to Google Drive

Nebulis can use a folder in your Google Drive as its archive destination, next to a local disk and a network share. One archive run backs up:

- **The library.** Every object folder with its sessions, `_archive/` calibration frames, `RESTACKED/`, and the other top-level folders. Subframes are included if you turn that on.
- **The gallery.** The finished images in each object's `processed/` folder.
- **The Nebulis database.** Each run takes a fresh snapshot and uploads it to `.nebulis-database/`. Upgrade and manual snapshots are also uploaded as soon as they are taken.

The folder in Drive has the same layout as the library. You can download it and open it in Siril or PixInsight without Nebulis.

## 1. Create an OAuth client (once)

Nebulis signs in to Google with the device-code flow: it shows a short code, and you enter that code at google.com/device on any device. Your server does not need a public address or a redirect URL. You do need your own OAuth client.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project, or pick an existing one.
2. Go to **APIs & Services → Library**, find **Google Drive API** and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen**:
   - Choose **External**, and fill in an app name and your email address.
   - Under **Scopes**, you can add `.../auth/drive.file`. It is the only scope Nebulis asks for.
   - Under **Test users**, add the Google account you will back up to.
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Choose the application type **TVs and Limited Input devices**. Any other type is refused by the sign-in.
   - Copy the **client ID** and the **client secret**.

> **Testing versus published.** While the consent screen is in *Testing*, Google expires the sign-in after 7 days, and you have to sign in again from Settings. To keep the sign-in, click **Publish app** on the consent screen. You can publish without going through Google's verification. The consent screen then warns that the app is unverified, which is expected for an app you made yourself.

## 2. Connect Nebulis

1. Go to **Settings → Storage → Archive**, click the button next to the destination (**Choose folder**, **Change share** or **Change destination**), and open the **Google Drive** tab.
2. Enter the folder name (default `Nebulis`), the client ID and the client secret, then click **Sign in with Google**.
3. Open the address shown, enter the code, and allow access.
4. Click **Use Google Drive**, then finish setting up the archive. That last step creates the folder at the top of My Drive and writes the archive marker (`.nebulisarchive`) into it.

From then on, archive runs follow the schedule you chose, or you can start one with **Run now**.

## What Nebulis can and cannot touch

- **Scope.** Nebulis asks only for `drive.file`. It can see and change files it created, and nothing else in your Drive.
- **Ownership.** As with a disk, Nebulis writes only to a folder whose marker carries this install's archive ID. Taking over a folder created by another install needs the same confirmation as taking over a disk.
- **Verification.** A file is recorded only after the checksum Drive reports matches the one Nebulis computed locally.
- **Large files.** Uploads go in 32 MiB chunks. An interrupted chunk resumes from where Drive stopped instead of starting the file again.
- **Deletion.**
  - Drive keeps earlier versions of a file that Nebulis replaces.
  - Nebulis never deletes library files from Drive.
  - The only automatic clean-up is the per-run database snapshots: Nebulis keeps the newest 30 and moves older ones to the Drive bin.
- **Storage.** The client secret and the sign-in token are encrypted at rest with the Nebulis data key and are never returned by the API.

## Not yet available for Google Drive

- Pruning the archive after N days.
- Removing local subframes once they are archived.
- Browsing and restoring from Settings. Download the files from Google Drive instead.

Settings disables pruning and local-subframe removal while the destination is Google Drive.

## Signing out

Open the destination picker again, go to the **Google Drive** tab and click **Sign out**. This revokes the token with Google. The files in Drive stay where they are.
