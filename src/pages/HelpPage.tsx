import { useState, type ReactNode } from 'react';
import {
  ChevronDown,
  HelpCircle,
  Info,
  Rocket,
  Compass,
  Telescope,
  Download,
  Upload,
  Library,
  Settings,
  AlertTriangle,
  Wifi,
  Usb,
  Server,
  Smartphone,
  type LucideIcon,
} from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useTour } from '../components/tour/TourProvider';
import { HeroBackdrop } from '../components/ui/HeroBackdrop';
import { PAGE_HERO } from '../lib/heroImagery';
import settingsTelescopesShot from '../assets/help/getting-started/settings-telescopes.webp';
import addTelescopeModalShot from '../assets/help/getting-started/add-telescope-modal.webp';
import settingsSkyShot from '../assets/help/getting-started/settings-sky.webp';
import syncDropdownShot from '../assets/help/getting-started/sync-dropdown.webp';
import tourLibraryOverviewShot from '../assets/help/tour/library/overview.webp';
import wifiHostnameTestShot from '../assets/help/telescopes/wifi-hostname-test.webp';
import usbPathTypedShot from '../assets/help/telescopes/usb-path-typed.webp';
import otherSmbShareShot from '../assets/help/telescopes/other-smb-share.webp';
import backupStatusShot from '../assets/help/shared/backup-status.webp';
import uploadFilesShot from '../assets/help/uploading/upload-files.webp';
import newObservationShot from '../assets/help/uploading/new-observation.webp';
import settingsStorageShot from '../assets/help/settings/storage.webp';
import settingsAdvancedShot from '../assets/help/settings/advanced.webp';
import settingsDevicesShot from '../assets/help/settings/devices.webp';
import settingsAccountTourShot from '../assets/help/settings/account.webp';
import libraryFilterMenuShot from '../assets/help/tour/library/filter-menu.webp';
import librarySessionNotesShot from '../assets/help/tour/library/session-notes.webp';
import libraryObjectActionBarShot from '../assets/help/tour/library/object-action-bar.webp';
import libraryStorageBreakdownShot from '../assets/help/tour/library/storage-breakdown.webp';
import tourObjectsOverviewShot from '../assets/help/tour/objects/overview.webp';
import tourObjectsTonightShot from '../assets/help/tour/objects/tonight.webp';
import tourObjectsProcessedShot from '../assets/help/tour/objects/processed.webp';
import tourObjectsSessionsShot from '../assets/help/tour/objects/sessions.webp';
import tourGalleryOverviewShot from '../assets/help/tour/gallery/overview.webp';
import tourGalleryViewerShot from '../assets/help/tour/gallery/viewer.webp';
import tourGalleryManageShot from '../assets/help/tour/gallery/manage.webp';
import tourObservationsCalendarShot from '../assets/help/tour/observations/calendar.webp';
import tourObservationsListShot from '../assets/help/tour/observations/list.webp';
import tourObservationsDetailShot from '../assets/help/tour/observations/detail.webp';
import tourObservationsMapShot from '../assets/help/tour/observations/map.webp';
import tourForecastTonightShot from '../assets/help/tour/forecast/tonight.webp';
import tourForecastWeekShot from '../assets/help/tour/forecast/week.webp';
import tourForecastLocationShot from '../assets/help/tour/forecast/location.webp';
import tourPlannerScheduleShot from '../assets/help/tour/planner/schedule.webp';
import tourPlannerCurvesShot from '../assets/help/tour/planner/curves.webp';
import tourPlannerConflictsShot from '../assets/help/tour/planner/conflicts.webp';
import tourPlannerConditionsShot from '../assets/help/tour/planner/conditions.webp';
import tourCatalogsLandingShot from '../assets/help/tour/catalogs/landing.webp';
import tourCatalogsBoardShot from '../assets/help/tour/catalogs/board.webp';
import tourCatalogsPopupShot from '../assets/help/tour/catalogs/popup.webp';
import tourCatalogsProgressShot from '../assets/help/tour/catalogs/progress.webp';
import mobileMenuShot from '../assets/help/mobile/menu.webp';
import mobileQrShot from '../assets/help/mobile/qr.webp';
import mobileEnterCodeShot from '../assets/help/mobile/enter-code.webp';

/**
 * Help: a hero banner, a left rail, and one guide shown at a time.
 *
 * Mirrors the Settings page: the left rail (a horizontal chip strip on mobile)
 * picks which section renders in the content column. Only one guide is visible
 * at once, so there is no long scroll and no anchor jumping.
 */

type SectionId =
  | 'what-is-nebulis'
  | 'quick-answers'
  | 'getting-started'
  | 'tour'
  | 'tour-library'
  | 'tour-objects'
  | 'tour-gallery'
  | 'tour-observations'
  | 'tour-forecast'
  | 'tour-planner'
  | 'tour-catalogs'
  | 'tour-settings'
  | 'telescopes'
  | 'custom-smb'
  | 'importing'
  | 'uploading'
  | 'mobile-devices'
  | 'troubleshooting';

const NAV: ({ id: SectionId; label: string; icon?: LucideIcon; indent?: boolean })[] = [
  { id: 'what-is-nebulis', label: 'What is Nebulis', icon: Info },
  { id: 'quick-answers', label: 'Quick answers', icon: HelpCircle },
  { id: 'getting-started', label: 'Getting started', icon: Rocket },
  { id: 'tour', label: 'A tour of the app', icon: Compass },
  { id: 'tour-library', label: 'Library', indent: true },
  { id: 'tour-objects', label: 'Object Details', indent: true },
  { id: 'tour-gallery', label: 'Gallery', indent: true },
  { id: 'tour-observations', label: 'Observations', indent: true },
  { id: 'tour-forecast', label: 'Forecast', indent: true },
  { id: 'tour-planner', label: 'Planner', indent: true },
  { id: 'tour-catalogs', label: 'Catalogs', indent: true },
  { id: 'tour-settings', label: 'Settings', indent: true },
  { id: 'telescopes', label: 'Adding a telescope or source', icon: Telescope },
  { id: 'custom-smb', label: 'Custom SMB sources', icon: Server },
  { id: 'importing', label: 'Importing and syncing images', icon: Download },
  { id: 'uploading', label: 'Uploading images', icon: Upload },
  { id: 'mobile-devices', label: 'Mobile devices', icon: Smartphone },
  { id: 'troubleshooting', label: 'Troubleshooting', icon: AlertTriangle },
];

export function HelpPage() {
  const { isDark, isNight, isSpace } = useTheme();
  const [activeId, setActiveId] = useState<SectionId>('what-is-nebulis');
  const { start: startTour } = useTour();

  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';

  function select(id: SectionId) {
    setActiveId(id);
  }

  return (
    <div className="space-y-8" data-screen-label="Help">
      <HelpHero accent={accent} onStartTour={startTour} />

      {/* ── Mobile section picker (chip strip) ─────────────────────── */}
      <div className={`lg:hidden sticky top-16 z-30 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2 border-b ${
        isDark ? 'bg-slate-950/85 backdrop-blur-xl border-slate-800' : 'bg-slate-50/85 backdrop-blur-xl border-slate-200'
      }`}>
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {NAV.filter(n => !n.indent).map(n => (
            <button
              key={n.id}
              onClick={() => select(n.id)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                activeId === n.id
                  ? isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-100 text-accent-700'
                  : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {n.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Body: left rail + one section ──────────────────────────── */}
      <div className="lg:flex lg:gap-10 lg:items-start">
        <nav className="hidden lg:block sticky top-24 w-60 shrink-0">
          <p className={`px-2.5 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Guides
          </p>
          <ul className="space-y-0.5">
            {NAV.map(n => {
              const Icon = n.icon;
              const isActive = n.id === activeId;
              return (
                <li key={n.id}>
                  <button
                    onClick={() => select(n.id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors ${
                      n.indent ? 'pl-9' : ''
                    } ${
                      isActive
                        ? isDark ? 'bg-slate-800 text-accent-400' : 'bg-accent-100 text-accent-700'
                        : isDark ? 'text-slate-400 hover:bg-slate-900 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                    }`}
                  >
                    {Icon && <Icon className="w-4 h-4 shrink-0" />}
                    {n.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">{renderSection(activeId, isDark, select)}</div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Hero banner, matching the Library / Settings / Backup shell.                 */
/* ────────────────────────────────────────────────────────────────────────── */

function HelpHero({ accent, onStartTour }: { accent: string; onStartTour: () => void }) {
  return (
    <section className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel">
      <HeroBackdrop image={PAGE_HERO.help} />

      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: `radial-gradient(90% 140% at 8% 0%, ${accent}1f 0%, transparent 60%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{ background: `radial-gradient(70% 130% at 95% 100%, ${accent}14 0%, transparent 62%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-3xl"
        style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }}
      />

      <div className="relative flex min-h-[9.5rem] flex-col justify-center p-5 sm:min-h-[11.5rem] sm:p-7">
        <div className="flex flex-wrap items-center gap-5">
          <div className="min-w-0 lg:max-w-[56%]">
            <h1 className="font-display flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              <HelpCircle className="h-6 w-6 sm:h-7 sm:w-7" style={{ color: accent }} />
              Help
            </h1>
            <p className="mt-2 text-[13px] text-white/55">
              Everything you need to use Nebulis, from first install to everyday use.
            </p>
          </div>

          <button
            onClick={onStartTour}
            className="ml-auto inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white bg-accent-500 hover:bg-accent-600 transition-all duration-150 hover:scale-[1.02] active:scale-[0.99] shadow-sm shadow-accent-500/20"
          >
            <Compass className="h-4 w-4" />
            Start the guided tour
          </button>
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Section bodies                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

function renderSection(id: SectionId, isDark: boolean, navigate: (id: SectionId) => void): ReactNode {
  switch (id) {
    case 'what-is-nebulis':
      return <WhatIsNebulis isDark={isDark} />;

    case 'quick-answers':
      return <QuickAnswers isDark={isDark} />;

    case 'getting-started':
      return (
        <GuideCard icon={Rocket} title="Getting started" lead="You are already signed in, so start with the telescope. Then set where you observe and pull your first night." isDark={isDark}>
          <Steps
            isDark={isDark}
            steps={[
              {
                title: 'Add your telescope',
                body: (
                  <>
                    <p>Open Settings → Telescopes → Add smart telescope. Pick your model and enter the address. The share name and other defaults fill in on their own.</p>
                    <ScreenshotPair>
                      <Screenshot src={settingsTelescopesShot} alt="Settings → Telescopes, with the Add smart telescope button at the bottom of the list" caption="Settings → Telescopes" isDark={isDark} />
                      <Screenshot src={addTelescopeModalShot} alt="The Add Smart Telescope dialog, with telescope type, display name, badge color, and connection fields" caption="Add Smart Telescope" isDark={isDark} />
                    </ScreenshotPair>
                  </>
                ),
              },
              {
                title: 'Set your location',
                body: (
                  <>
                    <p>Settings → Sky → your observing site. Latitude, longitude, and timezone are required for the Planner and Forecast to do anything useful.</p>
                    <Screenshot src={settingsSkyShot} alt="Settings → Sky, showing an observing site with its name, coordinates, and minimum altitude" caption="Settings → Sky" isDark={isDark} />
                  </>
                ),
              },
              {
                title: 'Run your first import',
                body: (
                  <>
                    <p>Open the telescope icon in the top bar and choose Sync. The first run copies everything, so it is the slowest one. Later runs only move new files.</p>
                    <Screenshot src={syncDropdownShot} alt="The telescope pill in the top bar, open to show each telescope with a Sync button and a Sync all option" caption="Top bar → Telescopes" isDark={isDark} width="max-w-sm" />
                  </>
                ),
              },
            ]}
          />
        </GuideCard>
      );

    case 'tour':
      return (
        <GuideCard icon={Compass} title="A tour of the app" lead="Learn what each page does and how to use it." isDark={isDark}>
          <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            Select a page from the menu on the left to learn what it does, why you'd use it, and how to get the most out of it.
          </p>
        </GuideCard>
      );

    case 'tour-library':
      return (
        <GuideCard icon={Library} title="Library" lead="Your home base. Every object you have imaged shows as a card with its best photo." isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: 'Find what you\'re looking for',
                body: 'Type a catalog ID like M51, a common name like Whirlpool, or a constellation. Tap the filter icon to show only the object types you care about: galaxies, nebulae, clusters, whatever you want to focus on.',
                img: libraryFilterMenuShot,
                alt: 'The Library page with the Customize filters menu open, listing object type groups as checkboxes',
                caption: 'Library → Search and filter',
              },
              {
                title: 'Explore an object',
                body: 'Tap any card to see every session you\'ve imaged it in. You get the date, telescope, number of sub-frames, file size, and a timeline of your progress. Mark it as a favorite by starring it. Your best captures show at the top when you filter for Favorites.',
                img: tourLibraryOverviewShot,
                alt: 'The Library page showing object cards with thumbnails, object names, and session information',
                caption: 'Library → Object cards',
              },
              {
                title: 'Record session details',
                body: 'Open an object, tap Notes, and log your personal rating, seeing quality, Bortle class, location, equipment used, and any thoughts about the session. These notes attach to that session permanently so you can reference them anytime.',
                img: librarySessionNotesShot,
                alt: 'The Session Notes dialog filled in with a personal rating, seeing rating, Bortle class, location, equipment, and notes',
                caption: 'Object page → Notes',
              },
              {
                title: 'Manage frames and files',
                body: 'On an object\'s page, use the action bar to Download all frames as a ZIP, Combine subs to stack your raw frames into one image, or Upload your finished processed image to use as the thumbnail. Once you have a final stack, delete the raw sub-frames to free up disk space while keeping the stacked result and all metadata.',
                img: libraryObjectActionBarShot,
                alt: 'An object page\'s action bar, with Add observation, Plan a night, Compare, Combine subs, and Download buttons',
                caption: 'Object page → Actions',
              },
              {
                title: 'Check your storage',
                body: 'Go to Settings → Storage to see a full breakdown of which objects are using the most disk space, sorted largest first. This makes it easy to find and manage the heavy ones when you need to free up room.',
                img: libraryStorageBreakdownShot,
                alt: 'The Storage page, showing overall disk usage and a per-object breakdown table sorted by total size',
                caption: 'Settings → Storage',
              },
            ]}
          />
        </GuideCard>
      );

    case 'tour-objects':
      return (
        <GuideCard icon={Library} title="Object Details" lead="View all your imaging history for a specific object. Track sessions, metadata, processed images, and visibility forecasts in one place." isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: 'View your best capture and object info',
                body: 'Click any object in your Library to open its detail page. At the top, you see your best captured image displayed prominently, along with all the object\'s catalog information: its type (galaxy, nebula, cluster, etc.), constellation, coordinates (RA/Dec), visual magnitude, distance in light-years, and angular size. A star icon lets you quickly add the object to your favorites for easy access.',
                img: tourObjectsOverviewShot,
                alt: 'Object detail page showing the best captured image, object name, and catalog metadata',
                caption: 'Object Details → Hero Section',
              },
              {
                title: 'Check tonight\'s visibility and weather forecasts',
                body: 'Just below the image, you\'ll see a "Tonight" panel showing whether this object is visible from your observing location and when it\'s best to image. It displays the current altitude, the peak altitude and when it happens, an altitude curve for the night, and the best months of the year to shoot it. This helps you plan your observing session in advance.',
                img: tourObjectsTonightShot,
                alt: 'Tonight visibility panel showing an altitude curve, current altitude, and best months to image',
                caption: 'Object Details → Tonight Panel',
              },
              {
                title: 'Browse the finished images from any session',
                body: 'Click into a session to see its Images tab: the finished stack and its FITS master side by side, with All / Image / Fits filters to switch between them. A Processed tab next to it holds any JPG, PNG, or TIFF finals you have uploaded for that night, separate from the raw stack.',
                img: tourObjectsProcessedShot,
                alt: 'A session\'s Images tab showing the JPG stack and FITS master with All, Image, and Fits filter buttons',
                caption: 'Session → Images',
              },
              {
                title: 'Review all your imaging sessions',
                body: 'Further down is a complete history of every session you\'ve imaged this object in, grouped by year and sorted newest first. Each card shows the date captured, telescope used, how many sub-frames were stacked, cloud cover, and temperature that night. Click any card to open the full session, its raw sub-frames, and its FITS metadata.',
                img: tourObjectsSessionsShot,
                alt: 'Observations section showing session cards grouped by year with date, telescope, and weather',
                caption: 'Object Details → Observations',
              },
              {
                title: 'Record and review observation notes',
                body: 'For each session, you can tap the Notes icon to record your personal experience from that night. Log your seeing rating (1-5 stars), sky darkness (Bortle scale), observing location, equipment used, weather conditions, and any thoughts about the imaging run. These notes stay permanently attached to that session so you can remember what worked well and what to try differently next time.',
                img: librarySessionNotesShot,
                alt: 'Session notes form showing star rating, seeing, Bortle, location, and equipment fields',
                caption: 'Object Details → Session Notes',
              },
            ]}
          />
          <Note isDark={isDark}>
            All session notes, metadata, and observations stay permanently attached to their object. Revisit any object years later and you'll still have exactly what you captured, what equipment you used, and your thoughts from that observing session.
          </Note>
        </GuideCard>
      );

    case 'tour-gallery':
      return (
        <GuideCard icon={Library} title="Gallery" lead="Every frame from your library in one grid, with a filter to narrow it down to just your finished results." isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: 'Browse every frame, or just the processed ones',
                body: 'The header shows totals for images, objects, processed finals, and favorites. By default the grid includes every frame in your library; turn on Processed only to see just the JPG, PNG, and TIFF finals you\'ve uploaded. Search by object name, filter by object type, or sort the grid to find what you\'re after.',
                img: tourGalleryOverviewShot,
                alt: 'Image Gallery page showing header stats and a grid of thumbnails, with Favorites, Processed only, and object-type filters',
                caption: 'Gallery → Overview',
              },
              {
                title: 'View images full-size',
                body: 'Click any thumbnail to open it in a full-screen viewer. Toggle between Fit and 1:1 to zoom in on detail, favorite or share the image, and download it. A filmstrip along the bottom lets you jump between every image for that object without closing the viewer.',
                img: tourGalleryViewerShot,
                alt: 'Full-size image viewer for the Eagle Nebula with Fit, 1:1, favorite, share, and download controls, and a filmstrip of other images below',
                caption: 'Gallery → Image Viewer',
              },
              {
                title: 'Search, filter, and favorite',
                body: 'Search narrows the grid to one object\'s frames across every session. Hover a thumbnail to favorite it right from the grid, or click through to see which object and session produced it. Favorites and Processed only combine with search, so you can find a specific final fast even in a large library.',
                img: tourGalleryManageShot,
                alt: 'Gallery filtered by search to Eagle Nebula, with a favorite heart icon showing on hover over the first thumbnail',
                caption: 'Gallery → Search and favorites',
              },
            ]}
          />
          <Note isDark={isDark}>
            Your Gallery automatically updates as you import new frames or upload processed images from any object or session. It's a living collection of your astrophotography achievements.
          </Note>
        </GuideCard>
      );

    case 'tour-observations':
      return (
        <GuideCard icon={Library} title="Observations" lead="Every imaging session you've ever logged, browsable by calendar, list, or map." isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: 'See your imaging activity at a glance',
                body: 'The header totals nights out, distinct objects, sessions, and files across your whole history, and a bar chart breaks sessions down by month for the selected year. Below it, the Calendar view lays out every session on the day it happened, with a thumbnail and time for each object.',
                img: tourObservationsCalendarShot,
                alt: 'Observations page showing lifetime totals, a monthly bar chart, and a calendar grid with session thumbnails on each day',
                caption: 'Observations → Calendar',
              },
              {
                title: 'Switch to a list, or a map of where you\'ve observed',
                body: 'The List view is a sortable table of every session by object, catalog id, and date, good for scanning a long history fast. Filter either view down to one telescope with the scope dropdown, and use Share to hand someone a read-only link.',
                img: tourObservationsListShot,
                alt: 'Observations List view showing a sortable table of sessions with Object, Catalog, and Date columns',
                caption: 'Observations → List',
              },
              {
                title: 'Review session details and notes',
                body: 'Click any session to open its full detail page: the stacked image, integration time, frames stacked, exposure and filter used, plus panels for the object itself, sky conditions that night, and where you observed from. Add notes, combine subs, or delete the session from here.',
                img: tourObservationsDetailShot,
                alt: 'M45 Pleiades observation detail page showing the stacked image, integration stats, and About, Conditions, and Observed from panels',
                caption: 'Observations → Session Details',
              },
              {
                title: 'See where you\'ve observed from',
                body: 'The Map view plots every session by location, clustered by how many you logged nearby. If you observe from more than one site, home, a dark-sky trip, a friend\'s backyard, this is the fastest way to see your history spread across them.',
                img: tourObservationsMapShot,
                alt: 'Observations Map view showing session location clusters across the southeastern United States',
                caption: 'Observations → Map',
              },
            ]}
          />
          <Note isDark={isDark}>
            Every observation is permanently linked to its object. Even years later, you'll be able to see exactly what you captured, when, with which equipment, and under what conditions.
          </Note>
        </GuideCard>
      );

    case 'tour-forecast':
      return (
        <GuideCard icon={Library} title="Forecast" lead="A single 0–100 score for tonight, plus the astronomical facts and weather behind it." isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: 'Read tonight\'s score at a glance',
                body: 'The ring on the left boils cloud cover, seeing and jet stream, and moon interference down to one 0–100 rating with a plain-language verdict underneath. Dark hours, sunset, sunrise, and the best imaging window sit alongside it, and the ribbon below traces sky quality through the night, worst to best, so you can see exactly when it gets good.',
                img: tourForecastTonightShot,
                alt: 'Sky Forecast page showing a 55/100 Good rating, moon phase, dark hours, sunset and sunrise times, best window, and a colored night-quality ribbon',
                caption: 'Forecast → Tonight',
              },
              {
                title: 'Check the nights just ahead',
                body: 'Below the ribbon, "The nights ahead" cards give each upcoming night its own score and a cloud-cover trend line, so you can tell at a glance whether tomorrow is worth staying up for or better spent processing what you already have.',
                img: tourForecastWeekShot,
                alt: 'Two upcoming-night cards showing a 64 Good score for Thursday and a 94 Excellent score for Friday, each with a cloud cover trend line',
                caption: 'Forecast → The nights ahead',
              },
              {
                title: 'Switch between your observing sites',
                body: 'If you\'ve set up more than one site under Settings → Sky, the location picker in the top right switches the whole forecast between them instantly. Handy for comparing home against a dark-sky spot before deciding where to drive.',
                img: tourForecastLocationShot,
                alt: 'Location picker open showing Franklin Tennessee, Nashville - West, and Russia as selectable observing sites',
                caption: 'Forecast → Observing sites',
              },
            ]}
          />
          <Note isDark={isDark}>
            Forecast data comes from open-meteo and 7Timer, combined into one score tuned for imaging rather than general weather.
          </Note>
        </GuideCard>
      );

    case 'tour-planner':
      return (
        <GuideCard icon={Library} title="Planner" lead="Build tonight's schedule target by target, and watch conflicts and free time update as you go." isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: 'Add targets to build your schedule',
                body: 'Search or browse the Targets list on the left, each one shows its magnitude, constellation, and when it peaks tonight, and tap + to drop it onto the Night schedule on the right. Nebulis picks a sensible time window automatically; drag a block\'s handle to nudge it, or use the day picker up top to plan any of the next two weeks.',
                img: tourPlannerScheduleShot,
                alt: 'Planner page with three targets added to the night schedule, showing scheduled time blocks and remaining free time',
                caption: 'Planner → Schedule',
              },
              {
                title: 'See exactly when each target is well placed',
                body: 'Scroll down and the altitude chart plots a curve for every scheduled target across the night, shaded over the span it\'s actually booked for. It\'s the fastest way to check a target isn\'t scheduled while it\'s still low on the horizon.',
                img: tourPlannerCurvesShot,
                alt: 'Altitude curve chart showing three scheduled targets with their curves shaded over their booked time windows',
                caption: 'Planner → Altitude curves',
              },
              {
                title: 'Spot double-booked time slots',
                body: 'If two targets land in the same window, their blocks sit side by side in the schedule instead of stacking, an unmistakable sign you\'ve overcommitted the night. Drag one to a free slot, or remove it with the × on the card.',
                img: tourPlannerConflictsShot,
                alt: 'Night schedule showing two targets both booked for 22:20 to 23:50, their blocks placed side by side to flag the overlap',
                caption: 'Planner → Conflicts',
              },
              {
                title: 'Check the moon and darkness for the night',
                body: 'The header sums up the night before you add anything: a Fair/Good/Excellent score, moon phase and illumination with its set time, and how many objects out of your whole catalog are visible tonight. Plan my night can fill the schedule for you from there.',
                img: tourPlannerConditionsShot,
                alt: 'Planner header showing a Fair score, Waxing Gibbous moon at 61% illuminated, and a Plan my night button',
                caption: 'Planner → Conditions',
              },
            ]}
          />
          <Note isDark={isDark}>
            A well-organized plan means you'll spend less time searching for targets and more time imaging. Use the planner to maximize your productive observing hours.
          </Note>
        </GuideCard>
      );

    case 'tour-catalogs':
      return (
        <GuideCard icon={Library} title="Catalogs" lead="Track your progress through classic observing programs, and research your next target." isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: 'Pick a catalog to work through',
                body: 'Catalogs opens on a scoreboard: how many unique objects you\'ve imaged across every catalog combined, then a card for each one, Messier, Caldwell, Herschel 400, Sharpless, with its imaged percentage and a breakdown by galaxies, nebulae, clusters, and other. Open a board to start working through it.',
                img: tourCatalogsLandingShot,
                alt: 'Catalogs landing page showing overall progress and catalog cards for Messier, Caldwell, Herschel 400, and Sharpless with imaged percentages',
                caption: 'Catalogs → Overview',
              },
              {
                title: 'Browse a catalog and see what you still need',
                body: 'Inside a board, filter to All, Imaged, or Remaining, search by name or constellation, and the grid marks every object you\'ve already captured with a checkmark and session count. It\'s the fastest way to see what\'s left on a list like Messier or Caldwell.',
                img: tourCatalogsBoardShot,
                alt: 'Messier catalog board showing progress bars by object type and a grid of objects with checkmarks and session counts on imaged ones',
                caption: 'Catalogs → Browse a board',
              },
              {
                title: 'Look up an object before you shoot it',
                body: 'Click any entry to open a quick-reference card: type, constellation, magnitude, coordinates, a description with a Wikipedia link, and a bar chart of its maximum altitude for each of the next 12 months so you know which season suits it best.',
                img: tourCatalogsPopupShot,
                alt: 'M16 Eagle Nebula quick reference card showing a description, Wikipedia link, and a monthly max-altitude bar chart with Feb through Oct highlighted as the best window',
                caption: 'Catalogs → Object reference',
              },
              {
                title: 'Jump straight to observing or planning it',
                body: 'From that same card, View observations takes you to everything you\'ve already captured of it, and Open in Planner drops it onto tonight\'s schedule. Objects you\'ve already imaged carry their session count right in the grid, so you always know where you stand before you commit a night to it.',
                img: tourCatalogsProgressShot,
                alt: 'Catalog grid showing checkmark badges and session counts on imaged objects like Pleiades (17 sessions) and Orion Nebula (13 sessions)',
                caption: 'Catalogs → Your progress',
              },
            ]}
          />
          <Note isDark={isDark}>
            Catalog entries carry distance and angular size where known, so you can also just browse for objects that happen to be nearby or a good match for your telescope's field of view.
          </Note>
        </GuideCard>
      );

    case 'tour-settings':
      return (
        <GuideCard icon={Settings} title="Settings" lead="Configure your app, manage storage, connect devices, and control your Nebulis experience." isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: 'Set your theme, units, and navigation',
                body: 'Settings → General covers the look and feel of the app: Light, Dark, Space, or Night theme, which menu items show in the top bar, measurement units, and other library defaults.',
                img: settingsAdvancedShot,
                alt: 'Settings → General, showing theme options (Light, Dark, Space, Night) and navigation bar toggles',
                caption: 'Settings → General',
              },
              {
                title: 'Manage your account and connected devices',
                body: 'In Settings → Account, manage users (admin or viewer) and see every phone, tablet, or TV paired to your library. Connect a device to generate a QR code for quick pairing, and revoke access for any device you no longer use.',
                img: settingsAccountTourShot,
                alt: 'Settings → Account → Devices, with a Connect a device button and an empty device list',
                caption: 'Settings → Account',
              },
              {
                title: 'Connect your telescopes and cameras',
                body: 'Add your smart telescopes, cameras, or network sources. Support includes ZWO SeeStar, ZWO ASIAIR, DWARFLAB Dwarf series, and standard SMB network shares. For each telescope, configure the connection type (Wi-Fi or USB), network settings, and enable/disable to control syncing. Automatically discover nearby devices or manually enter connection details.',
                img: settingsTelescopesShot,
                alt: 'Telescopes settings showing list of connected devices with connection status',
                caption: 'Settings → Telescopes',
              },
              {
                title: 'Set your observing site',
                body: 'Settings → Sky is where the Planner and Forecast get their facts: your observing site\'s coordinates and timezone, minimum altitude, catalog source, and data sources such as satellite trail tracking.',
                img: settingsSkyShot,
                alt: 'Settings → Sky, showing an observing site with its name, coordinates, and minimum altitude',
                caption: 'Settings → Sky',
              },
              {
                title: 'Monitor and manage storage',
                body: 'Check your total library storage usage and see a breakdown by object. Find which objects are using the most disk space. Move your library to a different drive or network location if needed. Manage your backups and set automated backup schedules to protect your imaging data.',
                img: settingsStorageShot,
                alt: 'Storage settings showing total usage, per-object breakdown, and library location controls',
                caption: 'Settings → Storage',
              },
              {
                title: 'Connect other devices and manage pairing',
                body: 'Pair your iPad, iPhone, Apple TV, or web browsers to access your library remotely. Generate QR codes for quick pairing, view all connected devices, and revoke access from devices you no longer use. Each device gets its own authentication token for secure access.',
                img: settingsDevicesShot,
                alt: 'Devices settings showing list of paired devices with revoke buttons',
                caption: 'Settings → Devices',
              },
              {
                title: 'Advanced configuration and data management',
                body: 'Access advanced settings like enabling night mode (red-tinted interface for dark adaptation), adjusting satellite trail detection sensitivity, clearing cached data, resetting the app, and viewing logs. Export your data or import previously backed up libraries.',
                img: settingsAdvancedShot,
                alt: 'Advanced settings showing theme options, data management, and expert controls',
                caption: 'Settings → Advanced',
              },
            ]}
          />
          <Note isDark={isDark}>
            Settings is where you can fine-tune Nebulis to match your exact workflow. Most settings take effect immediately, though some (like telescope connections) may require a resync.
          </Note>
        </GuideCard>
      );

    case 'telescopes':
      return (
        <GuideCard icon={Telescope} title="Adding a telescope or source" lead="Nebulis reads files over Wi-Fi or USB, and it can also read a plain folder shared on your network." isDark={isDark}>
          <Terms
            isDark={isDark}
            label="Supported telescopes and sources"
            items={[
              { t: 'ZWO SeeStar S30, S30 Pro, S50, and S50 Pro', d: 'Wi-Fi over SMB, or USB when the storage is plugged in directly.' },
              { t: 'ZWO ASIAIR (beta)', d: 'Wi-Fi over SMB, or USB.' },
              { t: 'DWARFLAB Dwarf 3, II, and Mini', d: 'Wi-Fi over FTP, or USB.' },
              {
                t: 'Any SMB share',
                d: (
                  <>
                    A NAS, PC, or another camera that follows the{' '}
                    <button
                      type="button"
                      onClick={() => navigate('custom-smb')}
                      className={`font-medium underline underline-offset-2 hover:no-underline ${
                        isDark ? 'text-accent-400' : 'text-accent-700'
                      }`}
                    >
                      custom SMB folder layout
                    </button>
                    .
                  </>
                ),
              },
            ]}
          />
          <p className={`px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Add it
          </p>
          <Steps
            isDark={isDark}
            steps={[
              {
                title: 'Go to Settings → Telescopes → Add smart telescope.',
                body: (
                  <Screenshot
                    src={settingsTelescopesShot}
                    alt="Settings → Telescopes, with the Add smart telescope button at the bottom of the list"
                    caption="Settings → Telescopes"
                    isDark={isDark}
                  />
                ),
              },
              {
                title: 'Pick the model.',
                body: (
                  <>
                    <p>The share name, username, and defaults fill in automatically.</p>
                    <Screenshot
                      src={addTelescopeModalShot}
                      alt="The Add Smart Telescope dialog with the Telescope Type dropdown set to ZWO SeeStar S50"
                      caption="Add Smart Telescope"
                      isDark={isDark}
                    />
                  </>
                ),
              },
              {
                title: 'Choose how to connect, then Test Connection.',
                body: <ConnectionMethodTabs isDark={isDark} />,
              },
            ]}
          />
          <Note isDark={isDark}>
            You can add more than one telescope. Each imports on its own, and the icon in the
            top bar shows how many are online.
          </Note>
        </GuideCard>
      );

    case 'custom-smb':
      return (
        <GuideCard
          icon={Server}
          title="Custom SMB sources"
          lead="A NAS, a PC share, or any camera works as a source as long as its files are organized the way Nebulis expects."
          isDark={isDark}
        >
          <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            Add it under Settings → Telescopes → Add smart telescope, with the telescope type set to{' '}
            <Code isDark={isDark}>Other (custom SMB share)</Code>. Then lay out the share root like this:
          </p>
          <pre className={`mt-3 overflow-x-auto p-3.5 rounded-xl text-xs leading-relaxed border ${
            isDark ? 'bg-slate-900 text-slate-300 border-slate-800' : 'bg-white text-slate-700 border-slate-200'
          }`}>{`<share root>/
└── M31/                       one folder per object: a catalog id (M31, NGC1788) or a common name
    ├── 2026-04-26_2030/       session folder, local time: <YYYY-MM-DD>_<HHMM>
    │   ├── lights/            required: at least one stacked or single-shot final
    │   │   ├── M31_stacked.fit
    │   │   └── M31_stacked.jpg
    │   ├── subframes/         optional: individual sub-frames
    │   │   ├── M31_001.fit
    │   │   └── M31_002.fit
    │   └── meta.json          optional: exposureSec, gain, filter, frameCount, integrationSec
    └── 2026-05-03_2115/
        └── lights/...`}</pre>
          <div className="mt-5">
            <Terms
              isDark={isDark}
              items={[
                { t: 'Object folder', d: 'Its name is the catalog id or common name Nebulis will file everything under. A recognized catalog id resolves to better metadata than a plain common name.' },
                { t: 'Session folder', d: 'Must match YYYY-MM-DD_HHMM exactly, in local time. The date drives the calendar view; the time keeps two sessions on the same night apart.' },
                { t: 'lights/', d: 'Required. At least one finished image, FITS master, or single-shot capture. A session folder with no files here is skipped entirely, so a half-finished copy never creates an empty object.' },
                { t: 'subframes/', d: 'Optional. Individual sub-frames for quality scoring and per-frame review. Only pulled in when "Include subframes" is turned on for this source, same as any other telescope.' },
                { t: 'meta.json', d: 'Optional. A small JSON file with whatever you know: exposureSec, gain, filter, frameCount, integrationSec. Leave out anything you don\'t have.' },
                { t: 'Filenames', d: 'Not parsed at all. Nebulis decides what a file is by which folder it sits in, not by what it\'s called, so anything with a supported extension in lights/ or subframes/ is picked up.' },
              ]}
            />
          </div>
          <Note isDark={isDark}>
            Already have files sitting directly inside the object folder with no session
            subfolders? That still works exactly as before, everything lands in one flat
            folder for that object. The session-folder layout above is only needed when you
            want each night kept separate, with sub-frames and metadata alongside it.
          </Note>
        </GuideCard>
      );

    case 'importing':
      return (
        <GuideCard icon={Download} title="Importing and syncing images" lead="Importing copies new files from your telescope into the library. Files you have already imported are skipped, so re-running is safe." isDark={isDark}>
          <Bullets
            isDark={isDark}
            items={[
              <>Sync now: click the telescope icon in the top bar and pick Sync, or use the refresh button on a telescope in Settings. The icon also shows how many telescopes are currently online.</>,
              <>Auto-import: turn it on for a telescope in Settings → Telescopes, and Nebulis pulls new captures on a schedule with no clicking needed.</>,
              <>First import: the first run copies everything, so give it a few minutes. Later runs only move new files.</>,
            ]}
          />
          <ScreenshotPair>
            <Screenshot src={syncDropdownShot} alt="The telescope pill in the top bar, open to show each telescope with a Sync button and a Sync all option" caption="Top bar → Telescopes" isDark={isDark} />
            <Screenshot src={backupStatusShot} alt="The Backup Status page, showing per-telescope sync state and a history of past syncs" caption="Backup Status" isDark={isDark} />
          </ScreenshotPair>
          <Note isDark={isDark}>
            Watch progress on the Backup page. It keeps a row for every import with how many
            files moved, how long it took, and any errors.
          </Note>
        </GuideCard>
      );

    case 'uploading':
      return (
        <GuideCard icon={Upload} title="Uploading images" lead="Not everything has to come straight from a telescope. You can bring in files you already have, or log a session by hand." isDark={isDark}>
          <Bullets
            isDark={isDark}
            items={[
              <>Upload files: Library → Upload Files. Drag in a folder from your computer, or pick a folder already on the server. You review each object before anything is committed.</>,
              <>Add a processed image: open a session and upload your finished JPG, PNG, or TIFF. It becomes the card thumbnail and shows in the slideshow.</>,
              <>Log an observation: Library → New Observation. Record a session manually with an optional image and notes.</>,
            ]}
          />
          <ScreenshotPair>
            <Screenshot src={uploadFilesShot} alt="The Import to Library dialog, with a drop zone for a folder and options for subframes and archiving everything" caption="Library → Upload Files" isDark={isDark} />
            <Screenshot src={newObservationShot} alt="The Log Observation dialog, with fields for object, date, image, telescope, and notes" caption="Library → New Observation" isDark={isDark} />
          </ScreenshotPair>
        </GuideCard>
      );

    case 'mobile-devices':
      return (
        <GuideCard icon={Smartphone} title="Mobile devices" lead="iPhone, iPad, Apple TV, and Android apps that read the same library over your local network. No cloud, no subscription, no separate account to manage." isDark={isDark}>
          <Steps
            isDark={isDark}
            steps={[
              {
                title: 'Download the app for your device',
                body: (
                  <>
                    <p>iPhone, iPad, and Apple TV share one app on the App Store; Android has its own on Google Play. Both are free and connect to this same server, so anything you capture, star, or process on the web shows up there too.</p>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <a
                        href="https://apps.apple.com/us/app/nebulis/id6769902885"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                      >
                        Download on the App Store
                      </a>
                      <a
                        href="https://play.google.com/store/apps/details?id=com.nebulis.app"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                      >
                        Get it on Google Play
                      </a>
                    </div>
                    <Screenshot
                      src={mobileMenuShot}
                      alt="The Mobile menu open in the top bar, showing Scan QR code, Enter code, and download links for iPhone/iPad/Apple TV and Android"
                      caption="Top bar → Mobile"
                      isDark={isDark}
                      width="max-w-sm"
                    />
                  </>
                ),
              },
              {
                title: 'Connect a phone or tablet with a QR code',
                body: (
                  <>
                    <p>Click the <Code isDark={isDark}>Mobile</Code> button in the top bar and choose <Code isDark={isDark}>Scan QR code</Code>. Open Nebulis on your phone, tap Scan QR, and point it at the code on screen. It connects and signs you in together, no typing an IP address. The code refreshes itself and expires after ten minutes if it isn&apos;t used.</p>
                    <Screenshot
                      src={mobileQrShot}
                      alt="The Connect a device dialog with a QR code to scan from the Nebulis phone app, plus a manual address fallback"
                      caption="Mobile → Scan QR code"
                      isDark={isDark}
                      width="max-w-xs"
                    />
                  </>
                ),
              },
              {
                title: 'Link an Apple TV with a short code',
                body: (
                  <>
                    <p>A TV has no camera, so pairing works the other way around: open Nebulis on the Apple TV and it displays a four-character code. Back on the web, click <Code isDark={isDark}>Mobile</Code> → <Code isDark={isDark}>Enter code</Code>, type what&apos;s on screen, and confirm the TV name that comes up.</p>
                    <Screenshot
                      src={mobileEnterCodeShot}
                      alt="The Link an Apple TV dialog with a four-character code input field"
                      caption="Mobile → Enter code"
                      isDark={isDark}
                      width="max-w-xs"
                    />
                  </>
                ),
              },
              {
                title: 'Manage or revoke paired devices',
                body: (
                  <>
                    <p>Every phone, tablet, and TV you&apos;ve linked shows up under Settings → Account → Devices. Each one carries its own sign-in token, so revoking a device here cuts its access immediately without touching anyone else&apos;s.</p>
                    <Screenshot
                      src={settingsDevicesShot}
                      alt="Settings → Account → Devices, with a Connect a device button and an empty device list"
                      caption="Settings → Account → Devices"
                      isDark={isDark}
                    />
                  </>
                ),
              },
            ]}
          />
        </GuideCard>
      );

    case 'troubleshooting':
      return (
        <GuideCard icon={AlertTriangle} title="Troubleshooting" lead="The problems people actually run into." isDark={isDark}>
          <Bullets
            isDark={isDark}
            items={[
              <>The telescope will not connect: check both are on the same Wi-Fi, try the IP instead of the hostname, and check the share name. Use Test connection in the telescope editor to see the exact error.</>,
              <>An import is stuck or slow: weak Wi-Fi and large FITS files are the usual causes. Cancel and retry; it resumes where it stopped.</>,
              <>A new session is not showing up: clear filters in the Library, check the import log on the Backup page, then re-run the import.</>,
              <>The Planner is empty: almost always the location is unset or the minimum altitude is too high. Check Settings → Sky and lower it.</>,
              <>The library says it is unavailable: check the drive it is stored on is connected, or that the network share is reachable.</>,
            ]}
          />
        </GuideCard>
      );
    default: {
      // Every SectionId in NAV must render a body. Without this a newly added
      // id would land on an empty page with no compiler complaint.
      const _exhaustive: never = id;
      void _exhaustive;
      return null;
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Guide card + content primitives                                              */
/* ────────────────────────────────────────────────────────────────────────── */

function GuideCard({
  icon: Icon,
  title,
  lead,
  isDark,
  children,
}: {
  icon: LucideIcon;
  title: string;
  lead?: string;
  isDark: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-2xl border ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
      <div className={`flex items-center gap-3 px-5 pt-4 pb-3 border-b ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        <span className={`inline-flex items-center justify-center w-9 h-9 rounded-xl ${isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-100 text-accent-700'}`}>
          <Icon className="w-4.5 h-4.5" />
        </span>
        <div className="min-w-0">
          <h2 className={`font-display text-lg font-bold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{title}</h2>
        </div>
      </div>
      <div className="px-5 py-4">
        {lead && <p className={`text-sm leading-relaxed mb-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{lead}</p>}
        {children}
      </div>
    </div>
  );
}

function Steps({ steps, isDark }: { steps: { title: string; body?: ReactNode }[]; isDark: boolean }) {
  const heading = isDark ? 'text-slate-100' : 'text-slate-800';
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  return (
    <ol className="flex flex-col gap-0">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-4">
          <div className="flex flex-col items-center">
            <div className="w-7 h-7 rounded-full bg-accent-500 text-slate-950 text-xs font-bold flex items-center justify-center shrink-0">
              {i + 1}
            </div>
            {i < steps.length - 1 && (
              <div className={`w-px flex-1 my-1 ${isDark ? 'bg-slate-700' : 'bg-slate-300'}`} />
            )}
          </div>
          <div className="pb-7 pt-0.5 flex-1 min-w-0">
            <p className={`text-sm font-semibold ${heading}`}>{step.title}</p>
            {step.body && <div className={`text-sm mt-1 leading-relaxed ${body}`}>{step.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function TourSteps({
  steps,
  isDark,
}: {
  steps: { title: string; body: string; img: string; alt: string; caption: string }[];
  isDark: boolean;
}) {
  const heading = isDark ? 'text-slate-100' : 'text-slate-800';
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  return (
    <ol className="flex flex-col gap-0">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-4">
          <div className="flex flex-col items-center">
            <div className="w-8 h-8 rounded-full bg-accent-500 text-slate-950 text-sm font-bold flex items-center justify-center shrink-0">
              {i + 1}
            </div>
            {i < steps.length - 1 && (
              <div className={`w-px flex-1 my-2 ${isDark ? 'bg-slate-700' : 'bg-slate-300'}`} />
            )}
          </div>
          <div className="pb-8 pt-0.5 flex-1 min-w-0">
            <p className={`text-sm font-semibold ${heading}`}>{step.title}</p>
            <div className={`text-sm mt-1.5 leading-relaxed ${body}`}>{step.body}</div>
            <Screenshot src={step.img} alt={step.alt} caption={step.caption} isDark={isDark} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function Bullets({ items, isDark }: { items: ReactNode[]; isDark: boolean }) {
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-2 w-1.5 h-1.5 rounded-full shrink-0 bg-accent-500" />
          <span className={`text-sm leading-relaxed ${body}`}>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Terms({ items, label, isDark }: { items: { t: string; d: ReactNode }[]; label?: string; isDark: boolean }) {
  const term = isDark ? 'text-slate-200' : 'text-slate-800';
  const def = isDark ? 'text-slate-400' : 'text-slate-600';
  return (
    <div className="mb-8">
      {label && (
        <p className={`px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {label}
        </p>
      )}
      <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-800 bg-slate-900/40' : 'border-slate-200 bg-slate-50/60'}`}>
        {items.map((item, i) => (
          <div
            key={item.t}
            className={`grid grid-cols-1 sm:grid-cols-[13rem_1fr] gap-x-6 gap-y-1 px-4 py-3.5 ${
              i < items.length - 1 ? (isDark ? 'border-b border-slate-800' : 'border-b border-slate-100') : ''
            }`}
          >
            <span className={`text-sm font-semibold ${term}`}>{item.t}</span>
            <span className={`text-sm leading-relaxed ${def}`}>{item.d}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Note({ children, isDark }: { children: ReactNode; isDark: boolean }) {
  return (
    <div
      className={`mt-5 flex gap-3 p-3.5 rounded-lg border text-sm leading-relaxed ${
        isDark ? 'bg-accent-500/10 border-accent-500/30 text-amber-200' : 'bg-amber-50 border-amber-200 text-amber-800'
      }`}
    >
      {children}
    </div>
  );
}

/** The traffic-light-dots title bar shared by Screenshot frames. */
function ChromeBar({ caption, isDark }: { caption: string; isDark: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 border-b text-[11px] font-medium tracking-wide ${
        isDark ? 'border-slate-700 bg-slate-800 text-slate-400' : 'border-slate-200 bg-slate-100 text-slate-500'
      }`}
    >
      <span className="flex gap-1 shrink-0">
        <span className="w-2 h-2 rounded-full bg-red-400/70" />
        <span className="w-2 h-2 rounded-full bg-amber-400/70" />
        <span className="w-2 h-2 rounded-full bg-emerald-400/70" />
      </span>
      {caption}
    </div>
  );
}

function ConnectionMethodTabs({ isDark }: { isDark: boolean }) {
  const [active, setActive] = useState<'wifi' | 'usb' | 'network'>('wifi');

  const tabs: { id: typeof active; label: string; icon: LucideIcon }[] = [
    { id: 'wifi', label: 'Wi-Fi', icon: Wifi },
    { id: 'usb', label: 'USB', icon: Usb },
    { id: 'network', label: 'Network folder', icon: Server },
  ];

  return (
    <div>
      <div className={`inline-flex p-1 rounded-xl gap-1 ${isDark ? 'bg-slate-950/60' : 'bg-slate-100'}`}>
        {tabs.map(t => {
          const Icon = t.icon;
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                isActive
                  ? isDark ? 'bg-accent-500 text-slate-950' : 'bg-white text-accent-700 shadow-sm'
                  : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {active === 'wifi' && (
        <div className="mt-3">
          <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            A SeeStar is usually <Code isDark={isDark}>seestar.local</Code> or the IP from its app. A Dwarf defaults
            to <Code isDark={isDark}>192.168.88.1</Code> only when it broadcasts its own access point; joined to your
            home Wi-Fi it takes whatever address your router assigns. A green result means you are ready to import.
          </p>
          <Screenshot
            src={wifiHostnameTestShot}
            alt="The hostname field filled in with seestar.local, and a green Connected result reading 'Connected. Found 209 object folders.'"
            caption="Add Smart Telescope → Connection"
            isDark={isDark}
            width="max-w-lg"
          />
        </div>
      )}

      {active === 'usb' && (
        <div className="mt-3">
          <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            Plug the telescope's storage into this computer and tap the refresh icon to detect it, or type the path
            yourself if you already know it.
          </p>
          <Screenshot
            src={usbPathTypedShot}
            alt="The USB storage path field with /Volumes/EMMC Images typed in"
            caption="Add Smart Telescope → Connection → USB cable"
            isDark={isDark}
            width="max-w-lg"
          />
        </div>
      )}

      {active === 'network' && (
        <div className="mt-3">
          <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            For a NAS, a PC share, or another camera, pick <Code isDark={isDark}>Other (custom SMB share)</Code> as
            the telescope type, then enter the host and the share name.
          </p>
          <Screenshot
            src={otherSmbShareShot}
            alt="Telescope Type set to Other (custom SMB share), with hostname 192.168.1.50 and SMB Share Name Astronomy typed in"
            caption="Add Smart Telescope → Other (custom SMB share)"
            isDark={isDark}
            width="max-w-lg"
          />
        </div>
      )}
    </div>
  );
}

function Screenshot({
  src,
  alt,
  caption,
  isDark,
  width = 'max-w-lg',
}: {
  src: string;
  alt: string;
  /** Short "breadcrumb" shown in the frame's title bar, e.g. "Settings → Telescopes". */
  caption: string;
  isDark: boolean;
  width?: string;
}) {
  return (
    <div
      className={`mt-3 w-full ${width} overflow-hidden rounded-xl border ${
        isDark ? 'border-slate-600 bg-slate-800' : 'border-slate-300 bg-white'
      }`}
      style={{
        boxShadow: isDark
          ? '0 0 0 1px rgba(0,0,0,0.4), 0 16px 32px -14px rgba(0,0,0,0.75)'
          : '0 12px 28px -16px rgba(15,23,42,0.3)',
      }}
    >
      <ChromeBar caption={caption} isDark={isDark} />
      <div className={isDark ? 'bg-slate-950' : 'bg-slate-50'}>
        <img src={src} alt={alt} className="block w-full h-auto" loading="lazy" />
      </div>
    </div>
  );
}

function ScreenshotPair({ children }: { children: ReactNode }) {
  return <div className="mt-3 grid items-start gap-3 sm:grid-cols-2">{children}</div>;
}

function Code({ children, isDark }: { children: ReactNode; isDark: boolean }) {
  return (
    <code className={`px-1.5 py-0.5 rounded text-xs font-mono ${isDark ? 'bg-slate-800 text-accent-400' : 'bg-slate-100 text-accent-700'}`}>
      {children}
    </code>
  );
}

function WhatIsNebulis({ isDark }: { isDark: boolean }) {
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  return (
    <GuideCard
      icon={Info}
      title="What is Nebulis"
      lead="Your astrophotography library and session planner, running on your own machine."
      isDark={isDark}
    >
      <div className={`flex flex-col gap-4 text-sm leading-relaxed ${body}`}>
        <p>
          Connect a smart telescope and Nebulis pulls in every session automatically, building one
          library sorted by object and by night, with full capture history, FITS metadata, and your
          own notes attached. Check the Forecast before you head out for a single sky score built
          from cloud cover, seeing, and moon phase, then use the Planner to turn your object list
          into a real schedule for the hours you have.
        </p>
        <p>
          It doesn't edit, stack, or control your telescope. Those jobs already have tools built for
          them. Nebulis is what happens after: everything your gear captured, finally organized into
          something you can actually use.
        </p>
      </div>
      <Note isDark={isDark}>
        <div>
          <p className="font-semibold">Completely free, now and forever.</p>
          <ul className="mt-2 space-y-1">
            <li className="flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-current shrink-0" />
              No cloud account
            </li>
            <li className="flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-current shrink-0" />
              No subscription
            </li>
            <li className="flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-current shrink-0" />
              No storage fees
            </li>
          </ul>
          <p className="mt-2">Runs entirely on your own computer. Every image stays on hardware you own, for as long as you want it.</p>
        </div>
      </Note>
    </GuideCard>
  );
}

function QuickAnswers({ isDark }: { isDark: boolean }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const qas: { q: string; a: string }[] = [
    {
      q: 'Does Nebulis send my images anywhere?',
      a: 'No. Nebulis runs on your own machine and your images stay there. Nothing leaves your network unless you choose to share it.',
    },
    {
      q: 'Which telescopes can I connect?',
      a: 'ZWO SeeStar S30, S30 Pro, S50, and S50 Pro, the ZWO ASIAIR (beta), and DWARFLAB Dwarf 3, Dwarf II, and Dwarf Mini. There is also a generic option for any SMB share that follows the same folder layout, such as a NAS or another camera.',
    },
    {
      q: 'I just installed it. What do I do first?',
      a: 'Create your account, add a telescope under Settings → Telescopes, set your location under Settings → Sky, then run an import. That is the whole setup.',
    },
    {
      q: 'How do new images get into my library?',
      a: 'Sync from the telescope icon in the top bar, or turn on auto-import in Settings → Telescopes. You can also import files you already have from a folder.',
    },
    {
      q: 'Can I view my library on a phone or TV?',
      a: 'Yes. Nebulis has iOS, Apple TV, and Android apps that connect to your server over the same network. Pair them under Settings → Account → Devices.',
    },
  ];

  return (
    <div className={`rounded-2xl border ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
      <div className={`flex items-center gap-3 px-5 pt-4 pb-3 border-b ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        <span className={`inline-flex items-center justify-center w-9 h-9 rounded-xl ${isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-100 text-accent-700'}`}>
          <HelpCircle className="w-4.5 h-4.5" />
        </span>
        <div className="min-w-0">
          <h2 className={`font-display text-lg font-bold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Quick answers</h2>
          <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>The things most people want to know first.</p>
        </div>
      </div>
      <div className="px-3 py-2 flex flex-col gap-1">
        {qas.map(qa => {
          const isOpen = !!open[qa.q];
          return (
            <div key={qa.q} className={isDark ? 'text-slate-300' : 'text-slate-700'}>
              <button
                onClick={() => setOpen(o => ({ ...o, [qa.q]: !o[qa.q] }))}
                aria-expanded={isOpen}
                className={`w-full flex items-center justify-between gap-4 px-3 py-3 text-left rounded-lg transition-colors ${isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50'}`}
              >
                <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{qa.q}</span>
                <ChevronDown className={`w-4 h-4 shrink-0 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
              </button>
              {isOpen && (
                <div className={`px-3 pb-3 -mt-1 text-sm leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {qa.a}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
