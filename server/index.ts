// Pure env-var set with no DB/fs side effects; must run before any async fs /
// sharp call initializes libuv's threadpool, hence it leads the import list.
import './lib/threadpool.js';
// Must run before paths.ts/db.ts open the database: handles `--reset-password`
// / `--list-users` and exits before the DB is created. No-op on normal boot.
import './lib/recoveryCli.js';
import './lib/logger.js'; // sets up file logging and crash capture for normal boot
import { log } from './lib/logger.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { apiEnvelope } from './middleware/apiEnvelope.js';
import { apiAuth } from './middleware/auth.js';
import { correlationMiddleware } from './middleware/correlation.js';
import { telescopeRouter } from './routes/telescope.js';
import { catalogRouter } from './routes/catalog.js';
import { settingsRouter } from './routes/settings.js';
import { openapiRouter } from './routes/openapi.js';
import { downloadRouter } from './routes/download.js';
import { storageRouter } from './routes/storage.js';
import { notesRouter } from './routes/notes.js';
import { telescopesRouter } from './routes/telescopes.js';
import { forecastRouter } from './routes/forecast.js';
import { authRouter } from './routes/auth.js';
import { observationsRouter } from './routes/observations.js';
import { satelliteRouter } from './routes/satellite.js';
import { libraryRouter } from './routes/library.js';
import { repairSpaceDirectories, repairAliasDirectories } from './lib/library/objects.js';
import { plannerRouter } from './routes/planner.js';
import { plannedSessionsRouter } from './routes/plannedSessions.js';
import { wishlistRouter } from './routes/wishlist.js';
import { reportsRouter } from './routes/reports.js';
import { preferencesRouter } from './routes/preferences.js';
import { pairRouter } from './routes/pair.js';
import { devicesRouter } from './routes/devices.js';
import { metaRouter } from './routes/meta.js';
import { startPackUpdateChecker } from './lib/catalogPack/updater.js';
import { startPlannerNightlyScheduler } from './lib/plannerNightlyPrefetch.js';
import { startAppUpdateChecker } from './lib/appUpdate/updater.js';
import { prewarmThumbnails } from './lib/catalogPrefetch.js';
import { satelliteCatalog } from './lib/satelliteCatalog.js';
import { DATA_DIR, LOGS_DIR } from './lib/paths.js';
import { scheduleAutoImport, purgeJunkFiles, purgeStaleImportTmp, scheduleImportTmpCleanup } from './lib/localLibrary.js';
import { isTelescopeOnline } from './lib/smbCache.js';
import { pickDefaultTarget } from './lib/telescopes.js';
import { runMigration } from './lib/migrate.js';
import db from './lib/db.js';
import fs from 'fs';
import dgram from 'dgram';
import net from 'net';
import { spawn } from 'child_process';
import Bonjour from 'bonjour-service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Run one-time migration from JSON files if needed (schema already created by db.ts import)
runMigration();

const app = express();
const PORT = process.env.PORT || 3002;

// Trust only the immediately upstream proxy (Caddy / Docker gateway).
// Without this, req.ip always reflects the socket address, which is correct
// for direct connections but misses the real client IP behind a local proxy.
// Limiting to 1 hop prevents spoofing via attacker-supplied X-Forwarded-For.
app.set('trust proxy', 1);

// Read version from the package.json stub written by the build script (same
// candidate list as meta.ts so the startup log matches what /meta/version returns).
function readAppVersion(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'package.json'),
    path.resolve(__dirname, '..', 'package.json'),
    path.resolve(__dirname, 'package.json'),
    path.resolve(path.dirname(process.execPath), 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string; buildNumber?: number };
      if (typeof pkg.version === 'string') {
        const build = typeof pkg.buildNumber === 'number' ? ` (${pkg.buildNumber})` : '';
        return pkg.version + build;
      }
    } catch { /* try next */ }
  }
  return '?';
}
const APP_VERSION = readAppVersion();

// --- Global middleware ---

// Correlation ID: must run before timing so the request log line carries
// requestId and before downstream handlers that may emit their own logs.
app.use(correlationMiddleware);

// Request timing logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (ms > 500 || req.path.startsWith('/api')) {
      log.info(
        { method: req.method, path: req.path, status: res.statusCode, ms },
        `${req.method} ${req.path} ${res.statusCode} (${ms}ms)`,
      );
    }
  });
  next();
});

// CORS allowlist: localhost (any port), LAN IPs (RFC1918), and *.local mDNS
// hostnames. Reflecting an arbitrary Origin while sending credentials lets any
// malicious page in the user's browser make authenticated calls to this server.
function isAllowedOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    const h = u.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
    if (h.endsWith('.local')) return true;
    // RFC1918 private ranges
    const ipMatch = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const a = Number(ipMatch[1]);
      const b = Number(ipMatch[2]);
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
    }
    return false;
  } catch {
    return false;
  }
}

app.use(cors((req, cb) => {
  const origin = req.header('Origin');
  const corsOptions = {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Client-Platform'],
    exposedHeaders: ['X-Request-Id', 'X-API-Version'],
    credentials: true,
  };
  // No Origin header → non-browser client (curl, native app). Allow.
  if (!origin) return cb(null, { ...corsOptions, origin: true });
  // Same-origin: vite emits module scripts which send Origin even on
  // same-origin loads. Without this, hosting on any public IP/hostname (not
  // covered by the RFC1918/.local allowlist) makes the SPA bundle requests
  // 500 from the CORS error.
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const reqHost = (req.headers.host ?? '').toLowerCase();
    if (originHost && originHost === reqHost) {
      return cb(null, { ...corsOptions, origin: true });
    }
  } catch { /* fall through */ }
  if (isAllowedOrigin(origin)) return cb(null, { ...corsOptions, origin: true });
  // Reject without throwing: returning `origin: false` omits CORS headers
  // (browser will block the response, but the server doesn't 500). Throwing
  // here would surface as a 500 HTML error page for every blocked asset.
  return cb(null, { ...corsOptions, origin: false });
}));

// Bumped from default 100 KB so bulk-upload requests carrying a parallel
// `relativePaths` JSON array (up to 500 files × deep paths) aren't silently
// truncated. Anything legitimately larger should use multipart upload.
app.use(express.json({ limit: '5mb' }));

// Security headers — CSP is tuned to what the SPA actually loads:
//   - Google Fonts (style + font sources)
//   - CartoDB tiles via Leaflet (img-src)
//   - data: URIs for local file-upload previews (img-src)
// HSTS is intentionally omitted — this app runs over HTTP on local networks.
app.use(helmet({
  strictTransportSecurity: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // blob: lets the SPA spawn Web Workers via URL.createObjectURL (used by
      // some Vite-bundled worker scripts). worker-src inherits from script-src.
      scriptSrc: ["'self'", 'blob:'],
      workerSrc: ["'self'", 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://*.basemaps.cartocdn.com'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
}));

app.use((_req, res, next) => {
  res.set('X-API-Version', '1.0.0');
  next();
});

// --- Versioned API (v1) ---

const v1 = express.Router();

v1.use(apiEnvelope);
v1.use(apiAuth);

// Health
v1.get('/health', (_req, res) => {
  const checks: Record<string, boolean> = {};

  // SQLite probe
  try {
    db.prepare('SELECT 1').get();
    checks.database = true;
  } catch {
    checks.database = false;
  }

  // DATA_DIR writable probe
  try {
    const probe = `${DATA_DIR}/.health-probe`;
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    checks.dataDir = true;
  } catch {
    checks.dataDir = false;
  }

  const allHealthy = Object.values(checks).every(Boolean);
  if (!allHealthy) {
    res.status(503).json({
      data: { status: 'degraded', checks, uptime: process.uptime(), timestamp: new Date().toISOString() },
      error: null,
    });
    return;
  }

  res.apiSuccess({
    status: 'healthy',
    checks,
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    telescopeOnline: isTelescopeOnline(),
  });
});

// Discovery
v1.get('/', (_req, res) => {
  res.apiSuccess({
    name: 'Nebulis API',
    version: '1.0.0',
    description: 'REST API for browsing and managing astronomical images from ZWO SeeStar smart telescopes.',
    features: [
      'Object gallery with catalog enrichment',
      'Session browsing (date-grouped from filenames)',
      'FITS file viewing and header inspection',
      'ZIP download/export',
      'Storage dashboard',
      'Observation notes/log',
      'Multi-telescope profiles',
      'Side-by-side comparison support',
      'Share-ready image export',
    ],
  });
});

// OpenAPI spec
v1.use('/openapi.json', openapiRouter);

// Auth (before apiAuth middleware, handled internally)
v1.use('/auth', authRouter);

// Core routes
v1.use('/telescope', telescopeRouter);
v1.use('/catalog', catalogRouter);
v1.use('/settings', settingsRouter);

// Feature routes
v1.use('/download', downloadRouter);
v1.use('/storage', storageRouter);
v1.use('/notes', notesRouter);
v1.use('/telescopes', telescopesRouter);
v1.use('/forecast', forecastRouter);
v1.use('/observations', observationsRouter);
v1.use('/satellite', satelliteRouter);
v1.use('/library', libraryRouter);
v1.use('/planner', plannerRouter);
v1.use('/dso', plannerRouter);   // alias: /api/v1/dso for catalog browsing
v1.use('/wishlist', wishlistRouter);
v1.use('/planned-sessions', plannedSessionsRouter);
v1.use('/reports', reportsRouter);
v1.use('/preferences', preferencesRouter);
v1.use('/pair', pairRouter);
v1.use('/devices', devicesRouter);
v1.use('/meta', metaRouter);

// Mount v1
app.use('/api/v1', v1);

// --- Legacy /api routes ---
// These also need the envelope middleware since the new route handlers
// use res.apiSuccess/res.apiError exclusively
const legacy = express.Router();
legacy.use((_req, res, next) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Sat, 01 Jan 2028 00:00:00 GMT');
  res.setHeader('Link', '</api/v1>; rel="successor-version"');
  next();
});
legacy.use(apiEnvelope);
legacy.use(apiAuth);
legacy.use('/auth', authRouter);
legacy.use('/telescope', telescopeRouter);
legacy.use('/catalog', catalogRouter);
legacy.use('/settings', settingsRouter);
legacy.use('/notes', notesRouter);
legacy.use('/storage', storageRouter);
legacy.use('/telescopes', telescopesRouter);
legacy.use('/download', downloadRouter);
legacy.use('/forecast', forecastRouter);
legacy.use('/observations', observationsRouter);
legacy.use('/satellite', satelliteRouter);
legacy.use('/library', libraryRouter);
legacy.use('/planner', plannerRouter);
legacy.use('/dso', plannerRouter);
legacy.use('/wishlist', wishlistRouter);
legacy.use('/planned-sessions', plannedSessionsRouter);
legacy.use('/reports', reportsRouter);
legacy.use('/preferences', preferencesRouter);
legacy.use('/pair', pairRouter);
legacy.use('/devices', devicesRouter);
legacy.use('/meta', metaRouter);
app.use('/api', legacy);

// --- Serve static frontend in production ---
// When running as a pkg-bundled exe, the frontend dist/ lives beside the exe
// on disk rather than embedded in the snapshot. Fall back to the standard
// relative path for Docker / direct `node` invocations.
const distPath = (process as NodeJS.Process & { pkg?: unknown }).pkg
  ? path.resolve(path.dirname(process.execPath), 'dist')
  : path.resolve(__dirname, '..', 'dist');
app.use(express.static(distPath, {
  setHeaders: (res, filePath) => {
    // Vite emits content-hashed files under /assets (e.g. index-Bf3itHA6.js), so
    // their bytes can never change under a fixed name — cache them immutably to
    // skip revalidation round-trips on repeat loads. index.html and other
    // unhashed files keep express.static's default ETag/Last-Modified behaviour
    // so a new build is always picked up.
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// SPA fallback: any non-API route serves index.html (production only; in dev, Vite handles the frontend)
if (process.env.NODE_ENV === 'production') {
  app.get('/{*splat}', (_req, res, next) => {
    if (_req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Global error handler — must be registered after all routes and have exactly
// four parameters so Express recognises it as an error handler, not middleware.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Multer errors are client mistakes (oversized file, too many files, etc.) — not server errors.
  if (err instanceof Error && err.name === 'MulterError') {
    const code = (err as Error & { code?: string }).code ?? 'UPLOAD_ERROR';
    const status = code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const messages: Record<string, string> = {
      LIMIT_FILE_SIZE:   'File is too large for this upload endpoint.',
      LIMIT_FIELD_VALUE: 'A form field value exceeded the allowed size.',
      LIMIT_FILE_COUNT:  'Too many files in a single upload.',
      LIMIT_FIELD_COUNT: 'Too many form fields in a single upload.',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field name.',
    };
    log.warn({ err, method: req.method, url: req.url, status }, 'multer_limit_exceeded');
    if (!res.headersSent) res.apiError(status, code, messages[code] ?? err.message);
    return;
  }
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { status?: number; statusCode?: number })?.statusCode
    ?? 500;
  const message = err instanceof Error ? err.message : 'Internal server error';
  log.error({ err, method: req.method, url: req.url, status }, 'unhandled_route_error');
  if (!res.headersSent) {
    res.apiError(status, 'INTERNAL_ERROR', message);
  }
});

// --- UDP Discovery Beacon ---

const DISCOVERY_PORT = 47890;

function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}


// Listens for UDP discovery pings from iOS/tvOS clients and responds with the HTTPS port.
// The client derives the server's IP from the source address of the response — Docker's NAT
// rewrites the source to the host's LAN IP, so this works correctly in bridge-mode containers.
function getLanIP(): string | null {
  // Prefer 192.168/10.x addresses — Docker bridge addresses (172.17-31.x) are last resort
  const allPrivate: Array<{ ip: string; priority: number }> = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const [a, b] = addr.address.split('.').map(Number);
      if (a === 192 && b === 168) allPrivate.push({ ip: addr.address, priority: 0 });
      else if (a === 10) allPrivate.push({ ip: addr.address, priority: 1 });
      else if (a === 172 && b >= 16 && b <= 31) allPrivate.push({ ip: addr.address, priority: 2 });
    }
  }
  allPrivate.sort((a, b) => a.priority - b.priority);
  return allPrivate[0]?.ip ?? null;
}

// Check if Caddy (or any HTTPS listener) is up on the given port.
// Cached for 30 s so discovery responses stay fast.
let _httpsAvail: boolean | null = null;
let _httpsAvailTs = 0;

async function isHTTPSAvailable(port: number): Promise<boolean> {
  const now = Date.now();
  if (_httpsAvail !== null && now - _httpsAvailTs < 30_000) return _httpsAvail;
  _httpsAvail = await new Promise<boolean>(resolve => {
    const s = new net.Socket();
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 300);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
    s.connect(port, '127.0.0.1');
  });
  _httpsAvailTs = now;
  return _httpsAvail;
}

/**
 * Returns a friendly hostname suitable for display in clients (e.g. "Brent-MacBook"),
 * or null when the OS hostname looks like a Docker container ID (12 lowercase hex
 * chars) and the operator has not set SERVER_HOSTNAME explicitly. Strips a trailing
 * ".local" so the value is concise for UI display.
 */
function getFriendlyHostname(): string | null {
  const override = process.env.SERVER_HOSTNAME;
  if (override && override.trim().length > 0) {
    return override.replace(/\.local$/i, '');
  }
  const raw = os.hostname();
  if (!raw) return null;
  // Default Docker container hostname is the 12-char short container ID.
  if (/^[0-9a-f]{12}$/.test(raw)) return null;
  return raw.replace(/\.local$/i, '');
}

// Responds to UDP discovery pings. Only includes httpsUrl/httpsPort when Caddy
// is actually reachable. The iOS client uses HTTPS only when those fields are present.
function startUDPResponder(httpPort: number, httpsPort: number): void {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', (err) => console.warn(`  UDP discovery: error — ${err.message}`));

  socket.on('message', async (msg, rinfo) => {
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(msg.toString()); } catch { return; }
      if (typeof parsed !== 'object' || parsed === null) return;
      const req = parsed as Record<string, unknown>;
      if (req.service !== 'nebulis') return;

      const ip = process.env.ADVERTISED_HOST || getLanIP();
      const httpsIsUp = await isHTTPSAvailable(httpsPort);
      const url = ip ? `http://${ip}:${httpPort}` : null;
      const friendlyHostname = getFriendlyHostname();
      const response = Buffer.from(JSON.stringify({
        service: 'nebulis',
        port: httpPort,
        url,
        ...(httpsIsUp && ip ? { httpsPort, httpsUrl: `https://${ip}:${httpsPort}` } : {}),
        ...(friendlyHostname ? { hostname: friendlyHostname } : {}),
        version: '1.0.0',
      }));
      socket.send(response, rinfo.port, rinfo.address, (err) => {
        if (err) console.warn(`  UDP discovery: send failed — ${err.message}`);
      });
    } catch {
      // ignore malformed packets
    }
  });

  socket.bind(DISCOVERY_PORT, () => {
    console.log(`  UDP discovery: listening on :${DISCOVERY_PORT}`);
  });

  process.on('SIGTERM', () => socket.close());
}

// --- Start ---
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Nebulis v${APP_VERSION} running on port ${PORT}`);
  console.log(`  UI:            http://localhost:${PORT}`);
  console.log(`  API (v1):      http://localhost:${PORT}/api/v1`);
  console.log(`  Health check:  http://localhost:${PORT}/api/v1/health`);
  console.log(`  Data dir:      ${DATA_DIR}`);
  console.log(`  Logs dir:      ${LOGS_DIR}`);
  console.log(`  Hostname:      ${getFriendlyHostname() ?? '(none — UDP replies will omit hostname field)'}`);

  repairSpaceDirectories();
  repairAliasDirectories();
  startPackUpdateChecker(prewarmThumbnails);
  startAppUpdateChecker();
  startPlannerNightlyScheduler();

  // Advertise via mDNS so iOS/tvOS clients can auto-discover this server.
  // Wraps in try/catch so a firewall block (common on Windows) never crashes the server.
  try {
    // SERVER_HOSTNAME overrides os.hostname() for Docker deployments where the
    // container hostname is a random ID that clients can't resolve. Set it to
    // the host machine's mDNS name (e.g. "my-mac.local") or its LAN IP.
    const rawHostname = process.env.SERVER_HOSTNAME ?? os.hostname();
    // Append .local only if the value looks like a bare hostname (no dots, not an IP)
    const hostname = rawHostname.includes('.') ? rawHostname : `${rawHostname}.local`;
    const friendlyHostname = getFriendlyHostname();
    const txtRecords = [
      `url=http://${hostname}:${PORT}`,
      `httpsPort=${HTTPS_PORT}`,
      `version=1.0.0`,
      ...(friendlyHostname ? [`hostname=${friendlyHostname}`] : []),
    ];

    if (process.platform === 'darwin') {
      // On macOS, use the system dns-sd command so all mDNS traffic routes
      // through the native mDNSResponder. Running a separate mDNS stack via
      // the bonjour-service npm package (which uses multicast-dns) causes
      // mDNSResponder to see two responders on the same machine and triggers
      // a hostname conflict dialog on every launch.
      const child = spawn('dns-sd', [
        '-R', 'Nebulis', '_nebulis._tcp', 'local.', String(PORT),
        ...txtRecords,
      ], { stdio: 'ignore' });
      child.on('error', (err) => {
        console.warn(`  mDNS:          dns-sd failed — ${err.message}`);
      });
      const killDnsSd = () => child.kill();
      process.once('exit', killDnsSd);
      process.once('SIGTERM', killDnsSd);
      process.once('SIGINT', killDnsSd);
      console.log(`  mDNS:          _nebulis._tcp → http://${hostname}:${PORT}`);
    } else {
      // Non-macOS (Windows, Linux, Docker): use the pure-JS bonjour-service package.
      const bonjourMod = Bonjour as typeof Bonjour & { default?: typeof Bonjour };
      const BonjourClass: typeof Bonjour = bonjourMod.default ?? Bonjour;
      const bonjour = new BonjourClass();
      bonjour.publish({
        name: 'Nebulis',
        type: 'nebulis',
        port: Number(PORT),
        txt: Object.fromEntries(txtRecords.map(r => r.split('=') as [string, string])),
      });
      console.log(`  mDNS:          _nebulis._tcp → http://${hostname}:${PORT}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  mDNS:          unavailable — ${msg}`);
  }

  startUDPResponder(Number(PORT), HTTPS_PORT);
});

// Remove macOS resource forks and other junk files left in the library
purgeJunkFiles();

// Delete abandoned folder-import wizard temp dirs older than 24 hours
purgeStaleImportTmp();
scheduleImportTmpCleanup();

// Start auto-import scheduler (checks settings on each tick)
scheduleAutoImport();


// Pre-download TLE satellite catalog in background so it's ready for trail detection
satelliteCatalog.loadCatalog()
  .then(records => console.log(`  TLE catalog:   ${records.length} satellites loaded`))
  .catch(err => console.warn('  TLE catalog:   download failed, will retry on first use:', err.message));
