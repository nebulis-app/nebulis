/**
 * Help content registry.
 *
 * Topic-first information architecture: every article belongs to exactly one
 * topic. Articles are referenced by stable ids — used in URL hash (#article-id)
 * and as keys in the search index.
 *
 * Article bodies live in HelpArticles.tsx (one render fn per id). Keep this
 * file pure data so it stays cheap to import / search.
 */

import type { LucideIcon } from 'lucide-react';
import {
  Zap,
  Telescope,
  Camera,
  CalendarDays,
  HardDrive,
  SlidersHorizontal,
  Server,
  AlertTriangle,
} from 'lucide-react';

export type ArticleMeta = {
  id: string;
  title: string;
  /** One-line summary, shown on the topic page and in search results. */
  summary: string;
  /** Estimated reading time in minutes. Shown next to the title. */
  readingMinutes: number;
  /** Free-text terms used to boost search matches. */
  keywords?: string[];
  /** Article surfaces in the "Most read" strip on the hub. */
  popular?: boolean;
  /** Last-meaningful-update marker for the "Updated" badge. */
  updated?: string;
};

export type TopicMeta = {
  id: string;
  /** Short label, used as the card title and in breadcrumbs. */
  label: string;
  /** Tagline shown under the title on the topic page. */
  tagline: string;
  icon: LucideIcon;
  /** Color family — keys into TOPIC_COLORS in the components. */
  tone: 'amber' | 'violet' | 'cyan' | 'rose' | 'emerald' | 'sky' | 'orange' | 'slate';
  articles: ArticleMeta[];
};

export const TOPICS: TopicMeta[] = [
  {
    id: 'getting-started',
    label: 'Getting started',
    tagline: 'Install Nebulis, create your account, import your first night.',
    icon: Zap,
    tone: 'amber',
    articles: [
      {
        id: 'install-nebulis',
        title: 'Install Nebulis',
        summary: 'Pick the installer for your platform: Docker, Windows, or macOS.',
        readingMinutes: 4,
        popular: true,
        keywords: ['setup', 'install', 'docker', 'windows', 'macos', 'pkg', 'msi'],
        updated: '2025-04',
      },
      {
        id: 'first-account',
        title: 'Create your first account',
        summary: 'Open mode onboarding, picking a strong password, and signing back in.',
        readingMinutes: 2,
        keywords: ['account', 'sign in', 'password', 'admin', 'onboarding'],
      },
      {
        id: 'pair-telescope',
        title: 'Pair your Seestar',
        summary: 'Connect over Wi-Fi, enable SMB, and verify the share from Nebulis.',
        readingMinutes: 3,
        popular: true,
        keywords: ['seestar', 'pair', 'connect', 'wifi', 'smb', 'share', 's30', 's50'],
      },
      {
        id: 'first-import',
        title: 'Run your first import',
        summary: 'Pull last night\'s captures from the telescope into your library.',
        readingMinutes: 2,
        keywords: ['import', 'sync', 'first', 'backup'],
      },
    ],
  },

  {
    id: 'gallery-browsing',
    label: 'Gallery & browsing',
    tagline: 'Find any object across every session. Search, filter, favorite.',
    icon: Telescope,
    tone: 'violet',
    articles: [
      {
        id: 'gallery-overview',
        title: 'The Gallery',
        summary: 'Your library home: every imaged object as a card with the best frame.',
        readingMinutes: 2,
        popular: true,
        keywords: ['gallery', 'home', 'library', 'cards', 'thumbnails'],
      },
      {
        id: 'search-filter',
        title: 'Search and filter the library',
        summary: 'Catalog ids, common names, types, constellations, favorites.',
        readingMinutes: 2,
        keywords: ['search', 'filter', 'm31', 'ngc', 'constellation', 'favorites'],
      },
      {
        id: 'object-detail',
        title: 'Object detail page',
        summary: 'Catalog data, sessions, notes, and side-by-side compare.',
        readingMinutes: 3,
        keywords: ['object', 'detail', 'sessions', 'notes', 'compare', 'tabs'],
      },
      {
        id: 'image-gallery',
        title: 'Full-screen image gallery',
        summary: 'Slideshow with Ken Burns zoom, crossfade, and metadata overlay.',
        readingMinutes: 1,
        keywords: ['slideshow', 'fullscreen', 'cinematic', 'ken burns'],
      },
    ],
  },

  {
    id: 'sessions',
    label: 'Sessions & imaging',
    tagline: 'Inspect a single night: files, FITS viewer, weather, processed uploads.',
    icon: Camera,
    tone: 'cyan',
    articles: [
      {
        id: 'observation-detail',
        title: 'Observation detail page',
        summary: 'Browse every sub-frame, view weather, add notes, and download.',
        readingMinutes: 3,
        popular: true,
        keywords: ['observation', 'session', 'detail', 'subs', 'frames'],
      },
      {
        id: 'fits-viewer',
        title: 'Use the FITS viewer',
        summary: 'Stretch, contrast, and inspection tools for raw FITS data.',
        readingMinutes: 2,
        keywords: ['fits', 'stretch', 'contrast', 'log', 'asinh', 'viewer'],
      },
      {
        id: 'session-notes',
        title: 'Add observation notes',
        summary: 'Bortle class, seeing, transparency, moon phase, equipment, comments.',
        readingMinutes: 2,
        keywords: ['notes', 'bortle', 'seeing', 'transparency', 'moon', 'log'],
      },
      {
        id: 'upload-processed',
        title: 'Upload a processed image',
        summary: 'Attach your finished JPG/PNG so it becomes the gallery thumbnail.',
        readingMinutes: 1,
        popular: true,
        keywords: ['upload', 'processed', 'pixinsight', 'photoshop', 'final'],
      },
      {
        id: 'download-files',
        title: 'Download session files',
        summary: 'Export everything, images only, or FITS only as a single ZIP.',
        readingMinutes: 1,
        keywords: ['download', 'export', 'zip', 'archive'],
      },
    ],
  },

  {
    id: 'planner-forecast',
    label: 'Planner & forecast',
    tagline: 'Pick the right target for tonight, then check whether the sky will cooperate.',
    icon: CalendarDays,
    tone: 'rose',
    articles: [
      {
        id: 'planner-overview',
        title: 'Plan tonight\'s session',
        summary: 'Top targets ranked by altitude, window, brightness, moon, and FOV fit.',
        readingMinutes: 3,
        popular: true,
        keywords: ['planner', 'tonight', 'targets', 'altitude', 'ranking'],
      },
      {
        id: 'wishlist',
        title: 'Build a wishlist',
        summary: 'Save objects with priority and notes so the Planner highlights them.',
        readingMinutes: 1,
        keywords: ['wishlist', 'priority', 'targets', 'save'],
      },
      {
        id: 'forecast-overview',
        title: 'Read the forecast',
        summary: 'Per-night Ideal → Bad rating from cloud cover, seeing, and transparency.',
        readingMinutes: 2,
        keywords: ['forecast', 'weather', 'seeing', 'clouds', 'transparency'],
      },
      {
        id: 'observer-location',
        title: 'Set your observer location',
        summary: 'Latitude, longitude, timezone, minimum altitude: required for both.',
        readingMinutes: 2,
        keywords: ['location', 'latitude', 'longitude', 'timezone', 'horizon'],
      },
    ],
  },

  {
    id: 'storage-backup',
    label: 'Storage & backup',
    tagline: 'Where your library lives and how it stays in sync with the telescope.',
    icon: HardDrive,
    tone: 'emerald',
    articles: [
      {
        id: 'storage-dashboard',
        title: 'The storage dashboard',
        summary: 'Disk usage by object. Find heavy targets before archiving.',
        readingMinutes: 2,
        keywords: ['storage', 'disk', 'usage', 'breakdown'],
      },
      {
        id: 'import-status',
        title: 'Watch an import in progress',
        summary: 'Live progress bar, transfer speed, ETA, and the import history log.',
        readingMinutes: 2,
        keywords: ['import', 'backup', 'progress', 'sync', 'history'],
      },
      {
        id: 'archive-objects',
        title: 'Archive an object',
        summary: 'Move a finished target out of the active library to free disk space.',
        readingMinutes: 2,
        keywords: ['archive', 'remove', 'cleanup', 'free space'],
      },
    ],
  },

  {
    id: 'settings',
    label: 'Settings & hardware',
    tagline: 'Telescope connection, observer site, catalogs, users, units.',
    icon: SlidersHorizontal,
    tone: 'sky',
    articles: [
      {
        id: 'telescope-connection',
        title: 'Telescope connection',
        summary: 'Hostname, share, credentials, and switching between S30 and S50.',
        readingMinutes: 2,
        keywords: ['hardware', 'telescope', 'hostname', 'smb', 'credentials'],
      },
      {
        id: 'catalogs-display',
        title: 'Catalogs and display',
        summary: 'Catalog source, gallery image source, planetarium overlays, units.',
        readingMinutes: 2,
        keywords: ['catalog', 'display', 'overlays', 'units'],
      },
      {
        id: 'user-management',
        title: 'Manage users (admin)',
        summary: 'Invite people, reset passwords, and switch the library to closed mode.',
        readingMinutes: 2,
        keywords: ['users', 'admin', 'invite', 'password', 'closed mode'],
      },
    ],
  },

  {
    id: 'deployment',
    label: 'Deployment',
    tagline: 'Three install paths. All self-hosted. Your data never leaves the LAN.',
    icon: Server,
    tone: 'orange',
    articles: [
      {
        id: 'compare-installers',
        title: 'Compare install options',
        summary: 'Docker, Windows, and macOS side-by-side: requirements and tradeoffs.',
        readingMinutes: 3,
        popular: true,
        keywords: ['install', 'docker', 'windows', 'macos', 'compare', 'requirements'],
      },
      {
        id: 'install-docker',
        title: 'Install on Docker',
        summary: 'Compose file, ports, ADVERTISED_HOST, and the bundled Caddy HTTPS.',
        readingMinutes: 4,
        keywords: ['docker', 'compose', 'caddy', 'https', 'nas', 'synology'],
      },
      {
        id: 'install-windows',
        title: 'Install on Windows',
        summary: 'Run the wizard, pick ports, enable HTTPS, and find your data.',
        readingMinutes: 3,
        keywords: ['windows', 'installer', 'service', 'msi', 'caddy'],
      },
      {
        id: 'install-macos',
        title: 'Install on macOS',
        summary: '.pkg install, LaunchDaemon, Gatekeeper notes, optional Caddy via Homebrew.',
        readingMinutes: 3,
        keywords: ['macos', 'pkg', 'launchdaemon', 'gatekeeper', 'homebrew'],
      },
    ],
  },

  {
    id: 'troubleshooting',
    label: 'Troubleshooting',
    tagline: 'When something doesn\'t look right: diagnose and fix.',
    icon: AlertTriangle,
    tone: 'slate',
    articles: [
      {
        id: 'cant-find-telescope',
        title: 'Nebulis can\'t find my telescope',
        summary: 'Discovery, hostname, SMB share, firewall: work through it in order.',
        readingMinutes: 3,
        popular: true,
        keywords: ['cannot find', 'connect', 'discovery', 'firewall', 'smb'],
      },
      {
        id: 'import-stuck',
        title: 'Import is stuck or very slow',
        summary: 'Wi-Fi signal, large FITS files, retry strategy, log inspection.',
        readingMinutes: 2,
        keywords: ['import slow', 'stuck', 'wifi', 'retry'],
      },
      {
        id: 'missing-images',
        title: 'New session didn\'t appear',
        summary: 'Check filters, the import log, and re-run the sync.',
        readingMinutes: 2,
        keywords: ['missing', 'session', 'filter', 'sync'],
      },
      {
        id: 'planner-empty',
        title: 'Planner shows no targets',
        summary: 'Almost always: observer location is unset or filters are too strict.',
        readingMinutes: 1,
        keywords: ['planner empty', 'no targets', 'location'],
      },
    ],
  },
];

/** Common quick-action shortcuts shown under the hero search. */
export const QUICK_ACTIONS = [
  { id: 'pair-telescope', label: 'Pair my Seestar', topicId: 'getting-started' },
  { id: 'first-import', label: 'Run an import', topicId: 'getting-started' },
  { id: 'planner-overview', label: 'Plan tonight', topicId: 'planner-forecast' },
  { id: 'cant-find-telescope', label: 'Fix a connection', topicId: 'troubleshooting' },
];

/** Numbered "Start here" lane on the hub. */
export const START_HERE = [
  { id: 'install-nebulis', topicId: 'getting-started', step: 'Install', label: 'Pick your installer' },
  { id: 'pair-telescope', topicId: 'getting-started', step: 'Pair', label: 'Connect your Seestar' },
  { id: 'observer-location', topicId: 'planner-forecast', step: 'Locate', label: 'Set observer site' },
  { id: 'first-import', topicId: 'getting-started', step: 'Import', label: 'Pull your first night' },
];

/** FAQ shown on the hub. Keep short — long answers live in articles. */
export const HUB_FAQ = [
  {
    q: 'Does Nebulis send my images anywhere?',
    a: 'No. Nebulis is fully self-hosted. Images and catalog data stay on the machine you install it on, and nothing leaves your local network unless you choose to share it.',
  },
  {
    q: 'Which Seestar models are supported?',
    a: 'Both ZWO Seestar S30 and S50, configured per-library in Settings → Hardware. Other smart telescopes are not supported today.',
  },
  {
    q: 'Can I run Nebulis on a NAS?',
    a: 'Yes. The Docker image runs on Synology DSM 7+, QNAP, Unraid, or any Linux host with Docker Engine 20.10+. Bundled Caddy gives you HTTPS for free.',
  },
  {
    q: 'How do I share access with someone else?',
    a: 'Switch the library to closed mode in Settings → Users, then add accounts with viewer or admin roles. Sessions persist for 30 days.',
  },
  {
    q: 'What format are the raw files?',
    a: 'Nebulis imports the original FITS sub-frames, JPG previews, and any video the Seestar produced. Nothing is transcoded.',
  },
];

/** Lookup helpers. Cheap because the dataset is tiny. */

export function getTopic(id: string): TopicMeta | undefined {
  return TOPICS.find(t => t.id === id);
}

export function getArticle(id: string): { topic: TopicMeta; article: ArticleMeta } | undefined {
  for (const topic of TOPICS) {
    const article = topic.articles.find(a => a.id === id);
    if (article) return { topic, article };
  }
  return undefined;
}

export function allArticles(): { topic: TopicMeta; article: ArticleMeta }[] {
  return TOPICS.flatMap(topic => topic.articles.map(article => ({ topic, article })));
}

/**
 * Tiny full-text search across title / summary / keywords.
 *
 * Not a real ranker — just a stable order that puts title matches first,
 * then summary matches, then keyword matches. Good enough for ~40 articles.
 */
export function searchArticles(query: string, limit = 8): { topic: TopicMeta; article: ArticleMeta; score: number }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);

  return allArticles()
    .map(({ topic, article }) => {
      const title = article.title.toLowerCase();
      const summary = article.summary.toLowerCase();
      const kw = (article.keywords ?? []).join(' ').toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (title.includes(t)) score += 5;
        if (summary.includes(t)) score += 2;
        if (kw.includes(t)) score += 1;
      }
      // Whole-phrase boost
      if (title.includes(q)) score += 6;
      return { topic, article, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title))
    .slice(0, limit);
}
