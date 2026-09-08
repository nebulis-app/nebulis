export interface Settings {
  apiKey: string;
  hasApiKey: boolean;
  // Observer location (for planner / alt-az calculations)
  latitude: number | null;
  longitude: number | null;
  locationName: string;
  timezone: string;
  // Planner visibility
  minAlt: number;
  horizonProfile: number[]; // 36 values, one per 10° azimuth bucket (0°–350°)
  /** 288 booleans: 36 azimuth slices x 8 elevation bands (10° tall, covering 0-80°).
   *  Empty means "no map set" and the planner treats the whole sky as visible. */
  visibleSkyMap: boolean[];
  /** Elevation-band count the server supports (currently 8); clients gate the
   *  finer visibleSkyMap grid on this. Absent on older servers. */
  skyMapBands?: number;
  // Sync / caching settings
  syncEnabled: boolean;
  syncJpg: boolean;
  syncFits: boolean;
  syncThumbnails: boolean;
  syncSubFrames: boolean;
  syncVideos: boolean;
  // Local library import
  autoImportInterval: number;
  importJpg: boolean;
  importFits: boolean;
  importThumbnails: boolean;
  importSubFrames: boolean;
  importVideos: boolean;
  /** Also keep files Nebulis has no use for, so this telescope's folder can be
   *  a complete copy of the device. Does not override the per-type toggles. */
  archiveAllFiles: boolean;
  // Onboarding
  onboardingCompleted: boolean;
  // Offline catalog imagery + Wikipedia descriptions
  prefetchCatalogAssets: boolean;
  // Gallery
  planetariumShowInfo: boolean;
  /** Which image to show by default on library cards when no custom image is set.
   *  'sky-survey' = catalog reference imagery (Hubble, DSS2, NASA, Caldwell, etc.) — default
   *  'telescope'  = a telescope image from the user's own observations */
  galleryImageSource: 'sky-survey' | 'telescope';
  /** Rotate all images 90° CCW in slideshow / planetarium mode */
  slideshowRotateCCW: boolean;
  /** Initial state of the "Processed only" filter on the Image Gallery page
   *  when it loads. The page's own toggle can still be changed per visit. */
  galleryProcessedOnlyDefault: boolean;
  /** Initial state of the "Processed only" filter when Planetarium mode
   *  launches. Its in-slideshow toggle can still be changed per session. */
  planetariumProcessedOnlyDefault: boolean;
  /** Which catalog nomenclature to prefer for new object folder names when an
   *  object has both an NGC/IC and a Caldwell designation (e.g. "C5" vs
   *  "IC342"). 'default' keeps NGC/IC priority; 'caldwell' prefers Caldwell. */
  preferredCatalog: 'default' | 'caldwell';
  /** Whether a session that runs past local midnight (e.g. 11pm-1am) groups
   *  as one observing night (true, default) or splits into two calendar-date
   *  sessions the old way (false). */
  groupObservingNights: boolean;
  temperatureUnit: 'celsius' | 'fahrenheit';
  windSpeedUnit: 'mph' | 'kmh';
  /** Desktop auto-update channel. 'beta' opts into pre-release builds. */
  updateChannel: 'stable' | 'beta';
  /** Whether the app checks for and pre-downloads updates automatically. Off by default. */
  autoUpdateEnabled: boolean;
  // Nightly maintenance
  plannerPrefetchEnabled: boolean;
  /** HH:MM in observer's local timezone (e.g. "03:00") */
  plannerPrefetchTime: string;
  /** Unix ms timestamp of last completed run, or null if never run. Read-only. */
  plannerPrefetchLastRun: number | null;
  nightlyCatalogPackCheckEnabled: boolean;
  nightlyHousekeepingEnabled: boolean;
  nightlyForecastPrefetchEnabled: boolean;
  /** Master switch for the whole nightly maintenance batch. */
  nightlyMaintenanceEnabled: boolean;
  nightlyHousekeepingLastRun: number | null;
  nightlyForecastLastRun: number | null;
}

export interface CatalogEntry {
  id: string;
  name: string;
  type: string;
  constellation: string;
  magnitude?: number;
  description: string;
  ra?: string;
  dec?: string;
  distanceLy?: number;
  /** Major axis in arcminutes — used by the client to match the prefetch's
   *  size-scaled thumbnail FOV so image requests cache-hit the disk. */
  majorAxisArcmin?: number | null;
  /** Source URL for the curated description. Mirrors server/lib/types/catalog.ts. */
  wikiUrl?: string | null;
  /** Formatted angular size string, e.g. "13.2' x 7.9'" (arcminutes). */
  size?: string | null;
  /** Other designations: NGC cross-refs, Caldwell, Sharpless, common names. */
  alsoKnownAs?: string[];
}

export interface AstroObject {
  id: string;
  catalogId: string;
  folderName: string;
  name: string;
  type: string;
  filterTags?: string[];
  constellation: string;
  description: string;
  magnitude?: number | null;
  ra?: string | null;
  dec?: string | null;
  distanceLy?: number | null;
  hasSubFrames: boolean;
  thumbnailUrl: string;
  sessionsUrl: string;
  filesUrl: string;
  subFramesUrl: string | null;
  sessionCount?: number;
  lastSessionDate?: string | null;
  lastImport?: string;
  source?: 'local' | 'smb';
  isFavorite?: boolean;
  galleryImage?: string | null;
  galleryImageUserSet?: boolean;
  /** Cache-buster string that changes when the gallery image OR its underlying
   *  bytes change (combines galleryImage with the source file's mtime). Use as
   *  the `version` arg to getLibraryObjectThumbnailUrl so re-uploads to the
   *  same `gallery_<id>.jpg` path defeat the browser's 24h cache. */
  galleryImageVersion?: string | null;
  /** Other captured variants of this object (e.g. Mosaic, Hα, HOO). */
  variants?: { objectId: string; label: string }[];
  /** Telescope that captured the most sessions for this object. */
  primaryTelescopeId?: string | null;
  /** Distinct telescopes that have captured this object, recency-sorted. */
  telescopeIds?: string[];
  /** All catalog aliases for this object (e.g. ["C30"] for NGC7331). */
  aliases?: string[];
}

export interface SessionWeather {
  temperature: number | null;
  cloudCover: number | null;
  humidity: number | null;
  windSpeed: number | null;
  dewPoint: number | null;
  visibility: number | null;
  precipProb: number | null;
}

export interface Session {
  id: string;
  date: string;
  objectId: string;
  fileCount: number;
  stackedCount: number;
  fitsCount: number;
  subFrameCount: number;
  imageCount: number;
  /** Video captures (mp4/mov/avi). Absent on responses from an older server. */
  videoCount?: number;
  processedCount: number;
  thumbnailUrl: string;
  filesUrl: string;
  weather: SessionWeather | null;
}

/** Rolled-up view of what the telescope recorded for one observing night.
 *  A null exposureSec/gain/filter means the night's capture runs disagreed
 *  ("mixed"), which is different from the value being unknown. */
export interface SessionCaptureSummary {
  runs: number;
  integrationSec: number | null;
  framesStacked: number | null;
  framesTaken: number | null;
  framesPlanned: number | null;
  exposureSec: number | null;
  gain: number | null;
  filter: string | null;
  minTempC: number | null;
  maxTempC: number | null;
}

export interface SessionFile {
  name: string;
  size: number;
  type: 'image' | 'fits' | 'video' | 'thumbnail' | 'other';
  fileType: 'stacked' | 'sub' | 'thumbnail' | 'video' | 'other';
  path: string;
  exposure: string | null;
  filter: string | null;
  timestamp: string | null;
  date: string | null;
  frameCount: number | null;
  isThumbnail: boolean;
  /** False when no rendering of this file can be trusted (a linear float TIFF),
   *  so it must be shown as a download card rather than an `<img>`. Absent on
   *  older responses, which is treated as previewable. */
  previewable?: boolean;
  downloadUrl: string;
  thumbUrl?: string;
  /** Larger (1024px) server-rendered JPEG for full-screen preview (FITS only). */
  previewUrl?: string;
  /** Inline, byte-range stream URL for a `<video>` tag. Present only for
   *  `type === 'video'`. MP4/MOV play in a browser; AVI does not, so callers
   *  fall back to `downloadUrl` when the name ends in `.avi`. */
  videoUrl?: string;
  subIndex?: number | null;
}

export interface ProcessedImage {
  id: string;
  objectId: string;
  /** Null for an image not tied to any single observing night (currently
   *  only Dwarf RESTACKED auto-imports — see `source`). */
  date: string | null;
  filename: string;
  originalName: string;
  title: string;
  notes: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  url: string;
  /** Relative library path (folderName/processed/filename) — safe to pass to /library/file. */
  path: string;
  /** Server-rendered thumbnail for a FITS processed image; null for anything
   *  else (renderable formats need no separate thumbnail, and other
   *  stored-only formats like XISF have no renderer). */
  thumbUrl: string | null;
  /** Bounded 2048 px JPEG for full-screen viewing, so opening a processed
   *  image never fetches or decodes the multi-MB original. Null for a
   *  stored-only format with no renderer (XISF, PSD, RAW). `url` stays the
   *  path to the true original for Download. */
  previewUrl: string | null;
  runId: string | null;
  /** Session dates the run covers, when this image combines more than one
   *  night. Null for ordinary single-session images. */
  runDates: string[] | null;
  /** 'dwarf-restack' for an auto-imported Dwarf RESTACKED file; 'user' for
   *  everything else. */
  source: 'user' | 'dwarf-restack';
}
