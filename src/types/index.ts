export interface Settings {
  hostname: string;
  shareName: string;
  username: string;
  password: string;
  model: string;
  apiKey: string;
  hasApiKey: boolean;
  hasPassword: boolean;
  // Observer location (for planner / alt-az calculations)
  latitude: number | null;
  longitude: number | null;
  locationName: string;
  timezone: string;
  // Planner visibility
  minAlt: number;
  horizonProfile: number[]; // 36 values, one per 10° azimuth bucket (0°–350°)
  /** 144 booleans: 36 azimuth slices x 4 elevation bands (centers 10/30/50/70).
   *  Empty means "no map set" and the planner treats the whole sky as visible. */
  visibleSkyMap: boolean[];
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
  // Onboarding
  onboardingCompleted: boolean;
  // Offline catalog imagery + Wikipedia descriptions
  prefetchCatalogAssets: boolean;
  prefetchUseCatalogPacks: boolean;
  // Gallery
  planetariumShowInfo: boolean;
  /** Which image to show by default on library cards when no custom image is set.
   *  'sky-survey' = catalog reference imagery (Hubble, DSS2, NASA, Caldwell, etc.) — default
   *  'telescope'  = a telescope image from the user's own observations */
  galleryImageSource: 'sky-survey' | 'telescope';
  /** Rotate all images 90° CCW in slideshow / planetarium mode */
  slideshowRotateCCW: boolean;
  temperatureUnit: 'celsius' | 'fahrenheit';
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
  thumbnailUrl: string;
  filesUrl: string;
  weather: SessionWeather | null;
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
  downloadUrl: string;
  thumbUrl?: string;
  subIndex?: number | null;
}

export interface ProcessedImage {
  id: string;
  objectId: string;
  date: string;
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
}
