/**
 * Article body registry.
 *
 * Maps article id → render function. Co-located so each article reads
 * top-to-bottom; the structural shell lives in HelpReader.tsx.
 *
 * Articles import primitives (Steps, Callout, KvTable, etc) — never raw
 * Tailwind plumbing — so theme + spacing stay consistent across the help.
 */

import type { ReactNode } from 'react';
import { Callout, Steps, KvTable, CompareTable, Code, Prose } from './HelpPrimitives';

type Render = () => ReactNode;

/* ───── Getting started ──────────────────────────────────────────────── */

const installNebulis: Render = () => (
  <>
    <Prose>
      Nebulis ships as a single-binary install on three platforms. All three are self-hosted.
      Your images stay on the machine you install on, and nothing leaves your local network.
      Pick whichever fits the hardware you already have.
    </Prose>

    <CompareTable
      columns={['', 'Docker', 'Windows', 'macOS']}
      rows={[
        ['OS',          'Linux (amd64 / arm64)', 'Windows 10+ 64-bit',     'macOS 12+'],
        ['Bundles Node', 'Yes (in container)',   'Yes (in installer)',     'Yes (in binary)'],
        ['Service mode', 'Container restart',     'Windows service',        'LaunchDaemon'],
        ['Built-in HTTPS','Yes (Caddy)',          'Optional in wizard',     'Optional via Homebrew'],
        ['Best for',     'NAS, Linux servers',    'A spare Windows PC',     'A Mac mini server'],
      ]}
    />

    <Callout type="tip" title="Not sure">
      If you already run a Synology, QNAP, or Linux box, install Docker. Otherwise pick whichever
      desktop you'll leave running overnight.
    </Callout>

    <Prose>Each installer has its own walkthrough. See the deployment topic for details.</Prose>
  </>
);

const firstAccount: Render = () => (
  <>
    <Prose>
      The very first time you load Nebulis there are no users yet, so the app runs in
      <strong> open mode</strong> and shows an onboarding panel. Filling it in creates the
      admin account and switches the library into normal authenticated mode.
    </Prose>

    <Steps steps={[
      { title: 'Open Nebulis in your browser', body: 'Use the URL the installer printed at the end: typically http://localhost:8080 or https://your-server:8443.' },
      { title: 'Fill in the onboarding panel', body: 'Email, username, display name, and password. The password is hashed locally; it never leaves the server.' },
      { title: 'You\'re signed in', body: 'The library now requires authentication. Subsequent visitors see a Sign In screen instead of onboarding.' },
      { title: 'Coming back later', body: 'Sessions persist for 30 days on the same browser. After that, sign in again with your username and password.' },
    ]} />

  </>
);

const pairTelescope: Render = () => (
  <>
    <Prose>
      Nebulis pulls files off your Seestar over SMB, the same file-sharing protocol Windows
      and macOS use to talk to a NAS. SMB is on by default in the Seestar firmware, so most
      pairing works out of the box.
    </Prose>

    <Steps steps={[
      { title: 'Power on the Seestar', body: 'Wait for the white LED to go solid. Connect it to your home Wi-Fi from the Seestar mobile app if you haven\'t already.' },
      { title: 'Find the Seestar on the network', body: <>Default hostname is <Code>seestar.local</Code> for the S50 or <Code>seestar30.local</Code> for the S30. If those don't resolve, use the IP address shown in the Seestar app.</> },
      { title: 'Open Nebulis → Settings → Hardware', body: 'Pick your model (S30 or S50), paste the hostname or IP, and use the default credentials unless you changed them.' },
      { title: 'Click Test connection', body: 'Nebulis tries the SMB share and reports back in under 5 seconds. A green check means you\'re ready to import.' },
    ]} />

    <Callout type="note" title="Default SMB share">
      The Seestar exposes a single share called <Code>EMMC Images</Code>. You don't need to
      pick it: Nebulis finds it automatically once it can reach the host.
    </Callout>
  </>
);

const firstImport: Render = () => (
  <>
    <Prose>
      An import copies new sub-frames, FITS files, and JPG previews from the telescope into
      your Nebulis library. Existing files are skipped, so re-running an import is safe.
    </Prose>

    <Steps steps={[
      { title: 'Open the Backup page from the top nav' },
      { title: 'Click "Start import"', body: 'A live progress bar appears immediately. The first import is the slowest because every file is new. Subsequent runs only pull what changed.' },
      { title: 'Wait for green check', body: 'Nebulis reports object count, files transferred, and total size. Typical full nights take 2–10 minutes over Wi-Fi.' },
      { title: 'Open the Gallery', body: 'New objects appear as cards using the best available frame as the thumbnail.' },
    ]} />

    <Callout type="tip" title="Run in the morning">
      The Seestar holds your overnight captures locally. Run the import once when you wake
      up: there's no need to leave the laptop running while you image.
    </Callout>
  </>
);

/* ───── Gallery & browsing ───────────────────────────────────────────── */

const galleryOverview: Render = () => (
  <>
    <Prose>
      The Gallery is your library home page. Every object you've ever imaged appears as a
      card showing the best frame, the catalog name, type, constellation, and the number of
      sessions you've spent on it.
    </Prose>
    <Prose>
      Cards are ordered by most recent session by default. Use the sort menu to switch to
      alphabetical, brightness, or session count.
    </Prose>
    <Callout type="tip" title="Best frame">
      The thumbnail prefers a processed image you've uploaded. If none exists, it falls back
      to the highest-scoring sub from the most recent session.
    </Callout>
  </>
);

const searchFilter: Render = () => (
  <>
    <Prose>
      The search box accepts catalog ids (<Code>M31</Code>, <Code>NGC 891</Code>),
      common names (<Code>Orion Nebula</Code>), constellations, or partial fragments: results
      filter as you type.
    </Prose>
    <Steps steps={[
      { title: 'Open the filter drawer', body: 'Top-right of the Gallery. Pick object types (Galaxy, Nebula, Cluster…), constellations, or favorites only.' },
      { title: 'Combine filters', body: 'Filters are AND-ed together. Pair "Galaxy" with "Andromeda" to find every galaxy in that constellation you\'ve imaged.' },
      { title: 'Save a view', body: 'Click "Save view" in the drawer to bookmark the current filter as a quick chip above the cards.' },
    ]} />
  </>
);

const objectDetailArt: Render = () => (
  <>
    <Prose>
      The Object Detail page is the hub for one specific target. The header shows catalog data
      (magnitude, distance, RA/Dec) and a Wikipedia summary; the body has three tabs.
    </Prose>
    <KvTable
      title="Tabs"
      rows={[
        ['Sessions', 'Every imaging date with file counts. Click a row to open Observation Detail.'],
        ['Notes', 'All notes you\'ve attached to this object across every session, oldest at the bottom.'],
        ['Compare', 'Side-by-side image comparison between any two sessions you pick.'],
      ]}
    />
  </>
);

const imageGalleryArt: Render = () => (
  <>
    <Prose>
      A full-screen, slow-paced slideshow of every image in your library. Ken Burns zoom on each
      slide, 2.5-second crossfade, ~9 seconds per image. Built for either showing off your
      library or running on a wall display.
    </Prose>
    <KvTable
      rows={[
        ['Shuffle', 'Randomise the slide order'],
        ['Heart', 'Toggle favorite for the current object'],
        ['Zoom', 'Adjust display size'],
        ['Metadata', 'Hover to see object name, type, constellation, and date'],
      ]}
    />
  </>
);

/* ───── Sessions & imaging ───────────────────────────────────────────── */

const observationDetailArt: Render = () => (
  <>
    <Prose>
      Use this page after a night to review every sub-frame, log conditions, attach a processed
      image, or download the raw data. Files are grouped by capture session and sortable by
      timestamp, score, or filter.
    </Prose>
    <Callout type="tip" title="Inspect before stacking">
      Score every sub before exporting. A single satellite trail or wind-shake can ruin a stack.
      Click a thumbnail to open the FITS viewer with stretch controls.
    </Callout>
  </>
);

const fitsViewerArt: Render = () => (
  <>
    <Prose>
      Raw FITS data is nearly black until stretched. The viewer applies a non-destructive
      display transform. Your file is never modified.
    </Prose>
    <KvTable
      title="Stretch presets"
      rows={[
        ['Linear', 'Default. Useful only for very bright targets.'],
        ['Log', 'Good first try for galaxies and faint nebulae.'],
        ['Asinh', 'Best for high dynamic range: bright cores plus faint dust.'],
        ['Auto', 'Adaptive median + stddev. Quick and usually right.'],
      ]}
    />
  </>
);

const sessionNotesArt: Render = () => (
  <>
    <Prose>
      Notes attach to one object on one date. Use them to capture conditions you'll forget
      tomorrow: they appear in Object Detail and feed into the Planner's "best night" hint.
    </Prose>
    <Steps steps={[
      { title: 'Open Observation Detail and click "Add notes"' },
      { title: 'Fill in Bortle, seeing, transparency, moon phase, equipment' },
      { title: 'Add freeform comments: what you tried, what worked, what didn\'t' },
      { title: 'Save. Notes are revision-tracked, so you can edit later without losing history.' },
    ]} />
  </>
);

const uploadProcessedArt: Render = () => (
  <>
    <Prose>
      When you finish processing in PixInsight, Photoshop, or anywhere else, upload the result
      back to Nebulis so it becomes the gallery thumbnail and shows in the slideshow.
    </Prose>
    <Steps steps={[
      { title: 'Open the session', body: 'Object → click the date.' },
      { title: 'Click "Upload processed image"' },
      { title: 'Pick your finished JPG or PNG (16-bit TIFF also accepted)' },
      { title: 'Add a title and any processing notes, then upload' },
      { title: 'Done', body: 'It becomes the gallery card thumbnail and appears in the full-screen slideshow rotation.' },
    ]} />
  </>
);

const downloadFilesArt: Render = () => (
  <>
    <Prose>
      Export an entire session as a single ZIP. Pick what to include so you don't haul gigabytes
      of FITS over the network if you only need the JPGs.
    </Prose>
    <KvTable
      title="Export presets"
      rows={[
        ['Everything', 'All files: FITS, JPG previews, video, metadata.'],
        ['Images only', 'JPG previews and any processed image you\'ve uploaded.'],
        ['FITS only', 'Raw sub-frames for processing in another tool.'],
      ]}
    />
  </>
);

/* ───── Planner & forecast ───────────────────────────────────────────── */

const plannerOverviewArt: Render = () => (
  <>
    <Prose>
      Open the Planner before a session to see which targets are best positioned for tonight.
      Ranking blends five factors so the top of the list is genuinely the smart pick, not just
      whatever's overhead.
    </Prose>
    <KvTable
      title="Ranking weights"
      rows={[
        ['Max altitude', '30%: higher is sharper'],
        ['Visibility window', '25%: time above your minimum altitude'],
        ['Magnitude', '20%: brighter is easier'],
        ['Transit timing', '15%: closer to local midnight scores higher'],
        ['Angular size fit', '10%: how well it fills the Seestar FOV'],
      ]}
    />
    <Callout type="warning" title="Set your location first">
      The Planner needs latitude, longitude, and timezone to do anything useful. Open
      Settings → Location and fill them in once.
    </Callout>
  </>
);

const wishlistArt: Render = () => (
  <>
    <Prose>
      A wishlist saves objects you want to image with a priority and notes. The Planner
      cross-references your wishlist and pins matches above generic suggestions.
    </Prose>
    <Steps steps={[
      { title: 'On any catalog object, click "Add to wishlist"' },
      { title: 'Pick a priority (High, Medium, or Low) and optional notes' },
      { title: 'When the Planner runs, wishlist items get a star badge and float to the top' },
    ]} />
  </>
);

const forecastOverviewArt: Render = () => (
  <>
    <Prose>
      The Forecast page rates each upcoming night Ideal → Bad based on cloud cover, seeing,
      transparency, and moon phase. Expand any night for an hour-by-hour breakdown.
    </Prose>
    <KvTable
      title="Nightly rating scale"
      rows={[
        ['Ideal', '≥ 85: perfect in every respect'],
        ['Great', '70–84: excellent night'],
        ['Good',  '55–69: solid session expected'],
        ['Fair',  '40–54: workable but compromised'],
        ['Poor',  '25–39: consider staying in'],
        ['Bad',   '< 25: stay inside'],
      ]}
    />
    <Callout type="tip" title="Seeing trumps clouds">
      A clear sky with seeing 1–2/5 still gives you blurry stars. Prioritise seeing 3+, even
      with thin clouds.
    </Callout>
  </>
);

const observerLocationArt: Render = () => (
  <>
    <Prose>
      Both the Planner and Forecast depend on your physical location. You only need to set this
      once per library. Nebulis never sends your coordinates anywhere.
    </Prose>
    <KvTable
      title="What to fill in"
      rows={[
        ['Latitude', 'Decimal degrees, +N. Example: 47.6062 for Seattle.'],
        ['Longitude', 'Decimal degrees, +E. Example: -122.3321 for Seattle.'],
        ['Timezone', 'IANA name. Example: America/Los_Angeles.'],
        ['Min altitude', 'Below this, an object is treated as below the horizon. Default 20°.'],
        ['Horizon profile', 'Optional. Trace your local skyline so trees/buildings count as horizon.'],
      ]}
    />
  </>
);

/* ───── Storage & backup ─────────────────────────────────────────────── */

const storageDashboardArt: Render = () => (
  <>
    <Prose>
      The Storage dashboard breaks down disk usage object by object. Use it to spot the few
      heavy targets eating most of your library before deciding what to archive.
    </Prose>
    <Callout type="note" title="What counts">
      Both raw FITS and JPG previews count toward the per-object total. Processed images you
      uploaded are tracked separately in the row's "Processed" column.
    </Callout>
  </>
);

const importStatusArt: Render = () => (
  <>
    <Prose>
      The Backup page shows live import progress and a full history of every past sync. The
      live panel updates every second; the history log keeps a row per import with start time,
      duration, files moved, and final status.
    </Prose>
    <Steps steps={[
      { title: 'Click an in-progress row to expand', body: 'You\'ll see per-object transfer status and the current file name.' },
      { title: 'Cancel safely at any point', body: 'In-flight files finish; partially-moved files are cleaned up so the next import starts clean.' },
      { title: 'Open a history row', body: 'Past imports show every file moved, with errors flagged red.' },
    ]} />
  </>
);

const archiveObjectsArt: Render = () => (
  <>
    <Prose>
      Archiving moves an object out of the active library to free disk space, while keeping its
      sessions and notes accessible. Archived objects don't appear in the Gallery or Planner
      unless you toggle "Show archived".
    </Prose>
    <Steps steps={[
      { title: 'Open the object', body: 'Object Detail → ⋯ menu in the header.' },
      { title: 'Pick Archive', body: 'You\'ll be asked whether to keep raw FITS on disk. Most people say no: the JPGs and metadata are enough for browsing.' },
      { title: 'The object disappears from the Gallery', body: 'Find it again under Settings → Storage → Archived, or by toggling "Show archived" in the Gallery filters.' },
    ]} />
  </>
);

/* ───── Settings & hardware ──────────────────────────────────────────── */

const telescopeConnectionArt: Render = () => (
  <>
    <Prose>
      Settings → Hardware is where you tell Nebulis how to reach the telescope. You can switch
      models any time. Your existing imported data stays put.
    </Prose>
    <KvTable
      title="Fields"
      rows={[
        ['Model', 'Seestar S30 or S50.'],
        ['Hostname / IP', 'seestar.local, seestar30.local, or a numeric address.'],
        ['SMB share', 'Auto-detected. Override only if you renamed the share manually.'],
        ['Credentials', 'Defaults work out of the box. Change if you set a Seestar user password.'],
      ]}
    />
  </>
);

const catalogsDisplayArt: Render = () => (
  <>
    <Prose>
      Pick the catalog source for object lookup, choose where gallery thumbnails come from, and
      toggle planetarium overlays.
    </Prose>
    <KvTable
      rows={[
        ['Catalog source', 'Built-in (offline, ~200K objects) or a custom URL endpoint you control.'],
        ['Gallery image', 'Best processed → newest sub → catalog placeholder. Reorder if you want.'],
        ['Planetarium overlays', 'Constellation lines, deep-sky boundaries, ecliptic, alt-az grid.'],
        ['Units', 'Imperial or metric. Affects altitudes, distances, and temperatures only.'],
      ]}
    />
  </>
);

const userManagementArt: Render = () => (
  <>
    <Prose>
      Switch the library between open mode (anyone on the LAN can use it) and closed mode
      (sign-in required). In closed mode, an admin can invite people and assign roles.
    </Prose>
    <Callout type="warning" title="Admin only">
      User management is hidden unless you're signed in as an admin. The first account you
      create in onboarding is an admin by default.
    </Callout>
    <KvTable
      title="Roles"
      rows={[
        ['Admin', 'Everything: settings, users, imports, deletes.'],
        ['Editor', 'Notes, processed uploads, archive, but no settings or user management.'],
        ['Viewer', 'Read-only. Can browse the Gallery but not modify anything.'],
      ]}
    />
  </>
);

/* ───── Deployment ───────────────────────────────────────────────────── */

const compareInstallersArt: Render = () => (
  <>
    <Prose>
      Three install paths, all self-hosted. None of them require Node or any external runtime.
      Every dependency is bundled into the installer.
    </Prose>
    <CompareTable
      columns={['', 'Docker', 'Windows', 'macOS']}
      rows={[
        ['OS',           'Linux (amd64 / arm64)', 'Windows 10+ 64-bit',     'macOS 12 Monterey+'],
        ['Architecture', 'x86-64 or ARM64',        'x86-64 only',           'Apple Silicon or Intel'],
        ['Service mode', 'Container restart',      'Windows service',       'LaunchDaemon'],
        ['HTTPS (Caddy)','Built-in',               'Optional at install',   'Optional via Homebrew'],
        ['Admin needed', 'Docker access',          'Yes',                   'Yes'],
        ['Default port', '8443',                   '8080 / 8443',           '8080 / 8443'],
      ]}
    />
  </>
);

const installDockerArt: Render = () => (
  <>
    <Prose>The Docker image runs on any Linux host, including NAS devices like Synology DSM 7+, QNAP, and Unraid. Caddy is bundled, so iOS devices on your LAN can connect over HTTPS without extra setup.</Prose>
    <KvTable
      title="System requirements"
      rows={[
        ['Docker Engine', '20.10 or later (or Docker Desktop)'],
        ['CPU',           'x86-64 or ARM64'],
        ['RAM',           '256 MB minimum, 512 MB recommended'],
        ['Disk (image)',  '~600 MB'],
        ['Disk (data)',   'Grows with library. Plan for several GB per season.'],
        ['Ports',         'TCP 8443 (HTTPS), UDP 47890 (discovery)'],
      ]}
    />
    <Steps steps={[
      { title: 'Download docker-compose.yml from the releases page' },
      { title: 'Set ADVERTISED_HOST', body: <>Use your server's LAN IP (required for iOS discovery). Containers can't detect the host's external IP themselves.</> },
      { title: 'Start the container', body: <Code>docker compose up -d</Code> },
      { title: 'Open the URL', body: 'https://your-server-ip:8443. Accept the self-signed certificate warning once.' },
    ]} />
  </>
);

const installWindowsArt: Render = () => (
  <>
    <Prose>A standard Windows setup wizard installs Nebulis as an auto-starting Windows service. No Node.js required. The installer is fully self-contained.</Prose>
    <KvTable
      title="System requirements"
      rows={[
        ['Windows', '10 64-bit or 11'],
        ['CPU',     'x86-64 (Intel / AMD). ARM is not supported.'],
        ['RAM',     '256 MB minimum, 512 MB recommended'],
        ['Disk',    '~150 MB app + library (in C:\\ProgramData\\Nebulis\\)'],
        ['Account', 'Administrator required to install'],
      ]}
    />
    <Steps steps={[
      { title: 'Download nebulis-setup.exe' },
      { title: 'Right-click → Run as administrator' },
      { title: 'Pick HTTP and HTTPS ports', body: 'Defaults are 8080 / 8443. Only change them if those ports are taken.' },
      { title: 'Tick "Enable HTTPS with Caddy"', body: 'Recommended for iOS LAN access.' },
      { title: 'Finish. Nebulis opens automatically.' },
    ]} />
    <KvTable
      title="File locations"
      monoValues
      rows={[
        ['Application', 'C:\\Program Files\\Nebulis\\'],
        ['Database',    'C:\\ProgramData\\Nebulis\\data\\nebulis.db'],
        ['Logs',        'C:\\ProgramData\\Nebulis\\logs\\service.log'],
      ]}
    />
  </>
);

const installMacOSArt: Render = () => (
  <>
    <Prose>A standard .pkg installer registers Nebulis as a LaunchDaemon so it starts at boot, even before you sign in. No Homebrew, no App Store, no Node.</Prose>
    <KvTable
      title="System requirements"
      rows={[
        ['macOS',   'macOS 12 Monterey or later'],
        ['CPU',     'Apple Silicon (arm64) or Intel (x86-64)'],
        ['RAM',     '256 MB minimum, 512 MB recommended'],
        ['Disk',    '~200 MB app + library (in /Library/Application Support/Nebulis/)'],
        ['Account', 'Admin password required to install'],
      ]}
    />
    <Steps steps={[
      { title: 'Download Nebulis.pkg', body: 'Pick arm64 for Apple Silicon, x86-64 for Intel.' },
      { title: 'Double-click and follow the wizard' },
      { title: 'Enter your admin password when prompted' },
      { title: 'Open http://localhost:8080' },
    ]} />
    <Callout type="warning" title="Gatekeeper warning">
      macOS may block the installer because the binary isn't notarized. Open System Settings → Privacy & Security and click "Allow Anyway" next to the Nebulis entry.
    </Callout>
  </>
);

/* ───── Troubleshooting ──────────────────────────────────────────────── */

const cantFindTelescopeArt: Render = () => (
  <>
    <Prose>Most pairing problems fall into one of four buckets. Work through them in order. About 90% of cases resolve in the first two.</Prose>
    <Steps steps={[
      { title: 'Confirm both devices are on the same Wi-Fi', body: 'Nebulis on the 5 GHz band and Seestar on a 2.4 GHz guest network is the most common silent failure.' },
      { title: 'Reach the Seestar by hostname or IP', body: <>Try <Code>ping seestar.local</Code> from a terminal on the Nebulis host. If that fails, use the IP address from the Seestar app instead.</> },
      { title: 'Check the SMB share name', body: <>Default is <Code>EMMC Images</Code>. If you've renamed it, set the override in Settings → Hardware.</> },
      { title: 'Open ports on the host firewall', body: 'Outbound TCP 445 (SMB) needs to be allowed. Most home setups already permit this.' },
    ]} />
    <Callout type="tip" title="Still stuck">
      Open Settings → Hardware → Diagnostics. The panel runs all four checks and prints exactly which one failed.
    </Callout>
  </>
);

const importStuckArt: Render = () => (
  <>
    <Prose>Imports stall most often because of weak Wi-Fi between Nebulis and the Seestar, or because a single very large FITS file is taking longer than expected.</Prose>
    <Steps steps={[
      { title: 'Watch the live progress', body: 'A stuck import vs. a slow one is easy to tell: bytes/sec in the live panel will be 0 for an actually-stuck import.' },
      { title: 'Cancel and retry', body: 'In-flight files finish cleanly, partially-moved files are cleaned up. The retry resumes from where it stopped.' },
      { title: 'Move the Seestar closer to the router', body: 'The Seestar Wi-Fi antenna is small. Even one wall costs significant throughput.' },
      { title: 'Check the import log', body: 'Past failures show in the history with the exact file that errored. Open it in the file browser to inspect.' },
    ]} />
  </>
);

const missingImagesArt: Render = () => (
  <>
    <Prose>If a session you definitely captured isn't showing up, it's almost always either a filter masking it in the Gallery, or the import didn't include the file type you expected.</Prose>
    <Steps steps={[
      { title: 'Clear all Gallery filters', body: 'The "Show archived" toggle and active type filters are the usual culprits.' },
      { title: 'Open the Backup → History row for that night', body: 'It lists every file moved. If your missing session isn\'t there, the import didn\'t see it.' },
      { title: 'Check the file-type filters in Settings → Sync', body: 'Video imports are off by default. Toggle them on if you expected video files.' },
      { title: 'Re-run the import', body: 'Existing files are skipped; only the missing ones move.' },
    ]} />
  </>
);

const plannerEmptyArt: Render = () => (
  <>
    <Prose>If the Planner shows no targets, the cause is almost always the observer location being unset or set wrong, or the minimum altitude filter being too aggressive.</Prose>
    <Steps steps={[
      { title: 'Open Settings → Location', body: 'Confirm latitude, longitude, and timezone are filled in and the timezone is correct (IANA name, e.g. America/Los_Angeles).' },
      { title: 'Lower the minimum altitude', body: 'Default is 20°. Drop to 10° to see if anything appears.' },
      { title: 'Check the date', body: 'The Planner defaults to tonight. Step forward a day if you\'re in the middle of the day with all targets below the horizon.' },
    ]} />
  </>
);

/* ───── Registry ─────────────────────────────────────────────────────── */

const ARTICLES: Record<string, Render> = {
  // Getting started
  'install-nebulis': installNebulis,
  'first-account':   firstAccount,
  'pair-telescope':  pairTelescope,
  'first-import':    firstImport,
  // Gallery
  'gallery-overview': galleryOverview,
  'search-filter':    searchFilter,
  'object-detail':    objectDetailArt,
  'image-gallery':    imageGalleryArt,
  // Sessions
  'observation-detail': observationDetailArt,
  'fits-viewer':        fitsViewerArt,
  'session-notes':      sessionNotesArt,
  'upload-processed':   uploadProcessedArt,
  'download-files':     downloadFilesArt,
  // Planner
  'planner-overview':   plannerOverviewArt,
  'wishlist':           wishlistArt,
  'forecast-overview':  forecastOverviewArt,
  'observer-location':  observerLocationArt,
  // Storage
  'storage-dashboard':  storageDashboardArt,
  'import-status':      importStatusArt,
  'archive-objects':    archiveObjectsArt,
  // Settings
  'telescope-connection': telescopeConnectionArt,
  'catalogs-display':     catalogsDisplayArt,
  'user-management':      userManagementArt,
  // Deployment
  'compare-installers': compareInstallersArt,
  'install-docker':     installDockerArt,
  'install-windows':    installWindowsArt,
  'install-macos':      installMacOSArt,
  // Troubleshooting
  'cant-find-telescope': cantFindTelescopeArt,
  'import-stuck':        importStuckArt,
  'missing-images':      missingImagesArt,
  'planner-empty':       plannerEmptyArt,
};

export function renderArticleBody(id: string): ReactNode {
  const render = ARTICLES[id];
  return render ? render() : null;
}

export function hasArticleBody(id: string): boolean {
  return id in ARTICLES;
}
