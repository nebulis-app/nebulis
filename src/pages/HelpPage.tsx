import { useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
  Layers,
  Settings,
  AlertTriangle,
  Wifi,
  Usb,
  Server,
  Smartphone,
  HardDrive,
  UserCog,
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
import manualImportDropZoneShot from '../assets/help/manual-import/drop-zone.webp';
import manualImportFolderPickerShot from '../assets/help/manual-import/folder-picker.webp';
import manualImportUncPathShot from '../assets/help/manual-import/unc-path.webp';

/**
 * Help: a hero banner, a left rail, and one guide shown at a time.
 *
 * Mirrors the Settings page: the left rail (a horizontal chip strip on mobile)
 * picks which section renders in the content column. Only one guide is visible
 * at once, so there is no long scroll and no anchor jumping.
 */

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

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
  | 'manual-import'
  | 'mobile-devices'
  | 'pixinsight'
  | 'troubleshooting';

const NAV: ({ id: SectionId; labelKey: string; icon?: LucideIcon; indent?: boolean })[] = [
  { id: 'what-is-nebulis', labelKey: 'nav.whatIsNebulis', icon: Info },
  { id: 'quick-answers', labelKey: 'nav.quickAnswers', icon: HelpCircle },
  { id: 'getting-started', labelKey: 'nav.gettingStarted', icon: Rocket },
  { id: 'tour', labelKey: 'nav.tour', icon: Compass },
  { id: 'tour-library', labelKey: 'nav.tourLibrary', indent: true },
  { id: 'tour-objects', labelKey: 'nav.tourObjects', indent: true },
  { id: 'tour-gallery', labelKey: 'nav.tourGallery', indent: true },
  { id: 'tour-observations', labelKey: 'nav.tourObservations', indent: true },
  { id: 'tour-forecast', labelKey: 'nav.tourForecast', indent: true },
  { id: 'tour-planner', labelKey: 'nav.tourPlanner', indent: true },
  { id: 'tour-catalogs', labelKey: 'nav.tourCatalogs', indent: true },
  { id: 'tour-settings', labelKey: 'nav.tourSettings', indent: true },
  { id: 'telescopes', labelKey: 'nav.telescopes', icon: Telescope },
  { id: 'custom-smb', labelKey: 'nav.customSmb', icon: Server },
  { id: 'importing', labelKey: 'nav.importing', icon: Download },
  { id: 'uploading', labelKey: 'nav.uploading', icon: Upload },
  { id: 'manual-import', labelKey: 'nav.manualImport', icon: HardDrive },
  { id: 'mobile-devices', labelKey: 'nav.mobileDevices', icon: Smartphone },
  { id: 'pixinsight', labelKey: 'nav.pixinsight', icon: Layers },
  { id: 'troubleshooting', labelKey: 'nav.troubleshooting', icon: AlertTriangle },
];

export function HelpPage() {
  const { t } = useTranslation('help');
  const { isDark, isNight, isSpace } = useTheme();
  const [activeId, setActiveId] = useState<SectionId>('what-is-nebulis');
  const { start: startTour } = useTour();

  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';

  function select(id: SectionId) {
    setActiveId(id);
  }

  return (
    <div className="space-y-8" data-screen-label="Help">
      <HelpHero accent={accent} onStartTour={startTour} t={t} />

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
              {t(n.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Body: left rail + one section ──────────────────────────── */}
      <div className="lg:flex lg:gap-10 lg:items-start">
        <nav className="hidden lg:block sticky top-24 w-60 shrink-0">
          <p className={`px-2.5 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {t('page.guidesHeading')}
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
                    {t(n.labelKey)}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">{renderSection(activeId, isDark, select, t)}</div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Hero banner, matching the Library / Settings / Backup shell.                 */
/* ────────────────────────────────────────────────────────────────────────── */

function HelpHero({ accent, onStartTour, t }: { accent: string; onStartTour: () => void; t: TFunc }) {
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

      <div className="relative flex hero-min-h flex-col justify-center p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-5">
          <div className="min-w-0 lg:max-w-[56%]">
            <h1 className="font-display flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              <HelpCircle className="h-6 w-6 sm:h-7 sm:w-7" style={{ color: accent }} />
              {t('page.title')}
            </h1>
            <p className="mt-2 text-[13px] text-white/55">
              {t('page.subtitle')}
            </p>
          </div>

          <button
            onClick={onStartTour}
            className="ml-auto inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white bg-accent-500 hover:bg-accent-600 transition-all duration-150 hover:scale-[1.02] active:scale-[0.99] shadow-sm shadow-accent-500/20"
          >
            <Compass className="h-4 w-4" />
            {t('page.startTour')}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Section bodies                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

function renderSection(id: SectionId, isDark: boolean, navigate: (id: SectionId) => void, t: TFunc): ReactNode {
  switch (id) {
    case 'what-is-nebulis':
      return <WhatIsNebulis isDark={isDark} t={t} />;

    case 'quick-answers':
      return <QuickAnswers isDark={isDark} t={t} />;

    case 'getting-started':
      return (
        <GuideCard icon={Rocket} title={t('gettingStarted.title')} lead={t('gettingStarted.lead')} isDark={isDark}>
          <Steps
            isDark={isDark}
            steps={[
              {
                title: t('gettingStarted.step1Title'),
                body: (
                  <>
                    <p>{t('gettingStarted.step1Body')}</p>
                    <ScreenshotPair>
                      <Screenshot src={settingsTelescopesShot} alt={t('gettingStarted.step1AltA')} caption={t('gettingStarted.captionSettingsTelescopes')} isDark={isDark} />
                      <Screenshot src={addTelescopeModalShot} alt={t('gettingStarted.step1AltB')} caption={t('gettingStarted.captionAddSmartTelescope')} isDark={isDark} />
                    </ScreenshotPair>
                  </>
                ),
              },
              {
                title: t('gettingStarted.step2Title'),
                body: (
                  <>
                    <p>{t('gettingStarted.step2Body')}</p>
                    <Screenshot src={settingsSkyShot} alt={t('gettingStarted.step2Alt')} caption={t('gettingStarted.captionSettingsSky')} isDark={isDark} />
                  </>
                ),
              },
              {
                title: t('gettingStarted.step3Title'),
                body: (
                  <>
                    <p>{t('gettingStarted.step3Body')}</p>
                    <Screenshot src={syncDropdownShot} alt={t('gettingStarted.step3Alt')} caption={t('gettingStarted.captionTopBarTelescopes')} isDark={isDark} width="max-w-sm" />
                  </>
                ),
              },
            ]}
          />
        </GuideCard>
      );

    case 'tour':
      return (
        <GuideCard icon={Compass} title={t('tour.title')} lead={t('tour.lead')} isDark={isDark}>
          <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            {t('tour.body')}
          </p>
        </GuideCard>
      );

    case 'tour-library':
      return (
        <GuideCard icon={Library} title={t('tourLibrary.title')} lead={t('tourLibrary.lead')} isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: t('tourLibrary.step1Title'),
                body: t('tourLibrary.step1Body'),
                img: libraryFilterMenuShot,
                alt: t('tourLibrary.step1Alt'),
                caption: t('tourLibrary.step1Caption'),
              },
              {
                title: t('tourLibrary.step2Title'),
                body: t('tourLibrary.step2Body'),
                img: tourLibraryOverviewShot,
                alt: t('tourLibrary.step2Alt'),
                caption: t('tourLibrary.step2Caption'),
              },
              {
                title: t('tourLibrary.step3Title'),
                body: t('tourLibrary.step3Body'),
                img: librarySessionNotesShot,
                alt: t('tourLibrary.step3Alt'),
                caption: t('tourLibrary.step3Caption'),
              },
              {
                title: t('tourLibrary.step4Title'),
                body: t('tourLibrary.step4Body'),
                img: libraryObjectActionBarShot,
                alt: t('tourLibrary.step4Alt'),
                caption: t('tourLibrary.step4Caption'),
              },
              {
                title: t('tourLibrary.step5Title'),
                body: t('tourLibrary.step5Body'),
                img: libraryStorageBreakdownShot,
                alt: t('tourLibrary.step5Alt'),
                caption: t('tourLibrary.step5Caption'),
              },
            ]}
          />
        </GuideCard>
      );

    case 'tour-objects':
      return (
        <GuideCard icon={Library} title={t('tourObjects.title')} lead={t('tourObjects.lead')} isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: t('tourObjects.step1Title'),
                body: t('tourObjects.step1Body'),
                img: tourObjectsOverviewShot,
                alt: t('tourObjects.step1Alt'),
                caption: t('tourObjects.step1Caption'),
              },
              {
                title: t('tourObjects.step2Title'),
                body: t('tourObjects.step2Body'),
                img: tourObjectsTonightShot,
                alt: t('tourObjects.step2Alt'),
                caption: t('tourObjects.step2Caption'),
              },
              {
                title: t('tourObjects.step3Title'),
                body: t('tourObjects.step3Body'),
                img: tourObjectsProcessedShot,
                alt: t('tourObjects.step3Alt'),
                caption: t('tourObjects.step3Caption'),
              },
              {
                title: t('tourObjects.step4Title'),
                body: t('tourObjects.step4Body'),
                img: tourObjectsSessionsShot,
                alt: t('tourObjects.step4Alt'),
                caption: t('tourObjects.step4Caption'),
              },
              {
                title: t('tourObjects.step5Title'),
                body: t('tourObjects.step5Body'),
                img: librarySessionNotesShot,
                alt: t('tourObjects.step5Alt'),
                caption: t('tourObjects.step5Caption'),
              },
            ]}
          />
          <Note isDark={isDark}>
            {t('tourObjects.note')}
          </Note>
        </GuideCard>
      );

    case 'tour-gallery':
      return (
        <GuideCard icon={Library} title={t('tourGallery.title')} lead={t('tourGallery.lead')} isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: t('tourGallery.step1Title'),
                body: t('tourGallery.step1Body'),
                img: tourGalleryOverviewShot,
                alt: t('tourGallery.step1Alt'),
                caption: t('tourGallery.step1Caption'),
              },
              {
                title: t('tourGallery.step2Title'),
                body: t('tourGallery.step2Body'),
                img: tourGalleryViewerShot,
                alt: t('tourGallery.step2Alt'),
                caption: t('tourGallery.step2Caption'),
              },
              {
                title: t('tourGallery.step3Title'),
                body: t('tourGallery.step3Body'),
                img: tourGalleryManageShot,
                alt: t('tourGallery.step3Alt'),
                caption: t('tourGallery.step3Caption'),
              },
            ]}
          />
          <Note isDark={isDark}>
            {t('tourGallery.note')}
          </Note>
        </GuideCard>
      );

    case 'tour-observations':
      return (
        <GuideCard icon={Library} title={t('tourObservations.title')} lead={t('tourObservations.lead')} isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: t('tourObservations.step1Title'),
                body: t('tourObservations.step1Body'),
                img: tourObservationsCalendarShot,
                alt: t('tourObservations.step1Alt'),
                caption: t('tourObservations.step1Caption'),
              },
              {
                title: t('tourObservations.step2Title'),
                body: t('tourObservations.step2Body'),
                img: tourObservationsListShot,
                alt: t('tourObservations.step2Alt'),
                caption: t('tourObservations.step2Caption'),
              },
              {
                title: t('tourObservations.step3Title'),
                body: t('tourObservations.step3Body'),
                img: tourObservationsDetailShot,
                alt: t('tourObservations.step3Alt'),
                caption: t('tourObservations.step3Caption'),
              },
              {
                title: t('tourObservations.step4Title'),
                body: t('tourObservations.step4Body'),
                img: tourObservationsMapShot,
                alt: t('tourObservations.step4Alt'),
                caption: t('tourObservations.step4Caption'),
              },
            ]}
          />
          <Note isDark={isDark}>
            {t('tourObservations.note')}
          </Note>
        </GuideCard>
      );

    case 'tour-forecast':
      return (
        <GuideCard icon={Library} title={t('tourForecast.title')} lead={t('tourForecast.lead')} isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: t('tourForecast.step1Title'),
                body: t('tourForecast.step1Body'),
                img: tourForecastTonightShot,
                alt: t('tourForecast.step1Alt'),
                caption: t('tourForecast.step1Caption'),
              },
              {
                title: t('tourForecast.step2Title'),
                body: t('tourForecast.step2Body'),
                img: tourForecastWeekShot,
                alt: t('tourForecast.step2Alt'),
                caption: t('tourForecast.step2Caption'),
              },
              {
                title: t('tourForecast.step3Title'),
                body: t('tourForecast.step3Body'),
                img: tourForecastLocationShot,
                alt: t('tourForecast.step3Alt'),
                caption: t('tourForecast.step3Caption'),
              },
            ]}
          />
          <Note isDark={isDark}>
            {t('tourForecast.note')}
          </Note>
        </GuideCard>
      );

    case 'tour-planner':
      return (
        <GuideCard icon={Library} title={t('tourPlanner.title')} lead={t('tourPlanner.lead')} isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: t('tourPlanner.step1Title'),
                body: t('tourPlanner.step1Body'),
                img: tourPlannerScheduleShot,
                alt: t('tourPlanner.step1Alt'),
                caption: t('tourPlanner.step1Caption'),
              },
              {
                title: t('tourPlanner.step2Title'),
                body: t('tourPlanner.step2Body'),
                img: tourPlannerCurvesShot,
                alt: t('tourPlanner.step2Alt'),
                caption: t('tourPlanner.step2Caption'),
              },
              {
                title: t('tourPlanner.step3Title'),
                body: t('tourPlanner.step3Body'),
                img: tourPlannerConflictsShot,
                alt: t('tourPlanner.step3Alt'),
                caption: t('tourPlanner.step3Caption'),
              },
              {
                title: t('tourPlanner.step4Title'),
                body: t('tourPlanner.step4Body'),
                img: tourPlannerConditionsShot,
                alt: t('tourPlanner.step4Alt'),
                caption: t('tourPlanner.step4Caption'),
              },
            ]}
          />
          <Note isDark={isDark}>
            {t('tourPlanner.note')}
          </Note>
        </GuideCard>
      );

    case 'tour-catalogs':
      return (
        <GuideCard icon={Library} title={t('tourCatalogs.title')} lead={t('tourCatalogs.lead')} isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: t('tourCatalogs.step1Title'),
                body: t('tourCatalogs.step1Body'),
                img: tourCatalogsLandingShot,
                alt: t('tourCatalogs.step1Alt'),
                caption: t('tourCatalogs.step1Caption'),
              },
              {
                title: t('tourCatalogs.step2Title'),
                body: t('tourCatalogs.step2Body'),
                img: tourCatalogsBoardShot,
                alt: t('tourCatalogs.step2Alt'),
                caption: t('tourCatalogs.step2Caption'),
              },
              {
                title: t('tourCatalogs.step3Title'),
                body: t('tourCatalogs.step3Body'),
                img: tourCatalogsPopupShot,
                alt: t('tourCatalogs.step3Alt'),
                caption: t('tourCatalogs.step3Caption'),
              },
              {
                title: t('tourCatalogs.step4Title'),
                body: t('tourCatalogs.step4Body'),
                img: tourCatalogsProgressShot,
                alt: t('tourCatalogs.step4Alt'),
                caption: t('tourCatalogs.step4Caption'),
              },
            ]}
          />
          <Note isDark={isDark}>
            {t('tourCatalogs.note')}
          </Note>
        </GuideCard>
      );

    case 'tour-settings':
      return (
        <GuideCard icon={Settings} title={t('tourSettings.title')} lead={t('tourSettings.lead')} isDark={isDark}>
          <TourSteps
            isDark={isDark}
            steps={[
              {
                title: t('tourSettings.step1Title'),
                body: t('tourSettings.step1Body'),
                img: settingsAdvancedShot,
                alt: t('tourSettings.step1Alt'),
                caption: t('tourSettings.step1Caption'),
              },
              {
                title: t('tourSettings.step2Title'),
                body: t('tourSettings.step2Body'),
                img: settingsAccountTourShot,
                alt: t('tourSettings.step2Alt'),
                caption: t('tourSettings.step2Caption'),
              },
              {
                title: t('tourSettings.step3Title'),
                body: t('tourSettings.step3Body'),
                img: settingsTelescopesShot,
                alt: t('tourSettings.step3Alt'),
                caption: t('tourSettings.step3Caption'),
              },
              {
                title: t('tourSettings.step4Title'),
                body: t('tourSettings.step4Body'),
                img: settingsSkyShot,
                alt: t('tourSettings.step4Alt'),
                caption: t('tourSettings.step4Caption'),
              },
              {
                title: t('tourSettings.step5Title'),
                body: t('tourSettings.step5Body'),
                img: settingsStorageShot,
                alt: t('tourSettings.step5Alt'),
                caption: t('tourSettings.step5Caption'),
              },
              {
                title: t('tourSettings.step6Title'),
                body: t('tourSettings.step6Body'),
                img: settingsDevicesShot,
                alt: t('tourSettings.step6Alt'),
                caption: t('tourSettings.step6Caption'),
              },
              {
                title: t('tourSettings.step7Title'),
                body: t('tourSettings.step7Body'),
                img: settingsAdvancedShot,
                alt: t('tourSettings.step7Alt'),
                caption: t('tourSettings.step7Caption'),
              },
            ]}
          />
          <Note isDark={isDark}>
            {t('tourSettings.note')}
          </Note>
        </GuideCard>
      );

    case 'telescopes':
      return (
        <GuideCard icon={Telescope} title={t('telescopes.title')} lead={t('telescopes.lead')} isDark={isDark}>
          <Terms
            isDark={isDark}
            label={t('telescopes.supportedLabel')}
            items={[
              { t: t('telescopes.seestarTerm'), d: t('telescopes.seestarDef') },
              { t: t('telescopes.asiairTerm'), d: t('telescopes.asiairDef') },
              { t: t('telescopes.dwarfTerm'), d: t('telescopes.dwarfDef') },
              {
                t: t('telescopes.smbTerm'),
                d: (
                  <Trans
                    i18nKey="telescopes.smbDef"
                    ns="help"
                    components={{
                      1: (
                        <button
                          type="button"
                          onClick={() => navigate('custom-smb')}
                          className={`font-medium underline underline-offset-2 hover:no-underline ${
                            isDark ? 'text-accent-400' : 'text-accent-700'
                          }`}
                        />
                      ),
                    }}
                  />
                ),
              },
            ]}
          />
          <p className={`px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {t('telescopes.addItLabel')}
          </p>
          <Steps
            isDark={isDark}
            steps={[
              {
                title: t('telescopes.step1Title'),
                body: (
                  <Screenshot
                    src={settingsTelescopesShot}
                    alt={t('gettingStarted.step1AltA')}
                    caption={t('gettingStarted.captionSettingsTelescopes')}
                    isDark={isDark}
                  />
                ),
              },
              {
                title: t('telescopes.step2Title'),
                body: (
                  <>
                    <p>{t('telescopes.step2Body')}</p>
                    <Screenshot
                      src={addTelescopeModalShot}
                      alt={t('telescopes.altAddSmartTelescope')}
                      caption={t('gettingStarted.captionAddSmartTelescope')}
                      isDark={isDark}
                    />
                  </>
                ),
              },
              {
                title: t('telescopes.step3Title'),
                body: <ConnectionMethodTabs isDark={isDark} t={t} />,
              },
            ]}
          />
          <Note isDark={isDark}>
            {t('telescopes.note')}
          </Note>
        </GuideCard>
      );

    case 'custom-smb':
      return (
        <GuideCard
          icon={Server}
          title={t('customSmb.title')}
          lead={t('customSmb.lead')}
          isDark={isDark}
        >
          <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            {t('customSmb.introBefore')}{' '}
            <Code isDark={isDark}>{t('customSmb.introCode')}</Code>. {t('customSmb.introAfter')}
          </p>
          <pre className={`mt-3 overflow-x-auto p-3.5 rounded-xl text-xs leading-relaxed border ${
            isDark ? 'bg-slate-900 text-slate-300 border-slate-800' : 'bg-white text-slate-700 border-slate-200'
          }`}>{t('customSmb.folderTree')}</pre>
          <div className="mt-5">
            <Terms
              isDark={isDark}
              items={[
                { t: t('customSmb.objectFolderTerm'), d: t('customSmb.objectFolderDef') },
                { t: t('customSmb.sessionFolderTerm'), d: t('customSmb.sessionFolderDef') },
                { t: t('customSmb.lightsTerm'), d: t('customSmb.lightsDef') },
                { t: t('customSmb.subframesTerm'), d: t('customSmb.subframesDef') },
                { t: t('customSmb.metaJsonTerm'), d: t('customSmb.metaJsonDef') },
                { t: t('customSmb.filenamesTerm'), d: t('customSmb.filenamesDef') },
              ]}
            />
          </div>
          <Note isDark={isDark}>
            {t('customSmb.note')}
          </Note>
        </GuideCard>
      );

    case 'importing':
      return (
        <GuideCard icon={Download} title={t('importing.title')} lead={t('importing.lead')} isDark={isDark}>
          <Bullets
            isDark={isDark}
            items={[
              <>{t('importing.bullet1')}</>,
              <>{t('importing.bullet2')}</>,
              <>{t('importing.bullet3')}</>,
            ]}
          />
          <ScreenshotPair>
            <Screenshot src={syncDropdownShot} alt={t('importing.altSyncDropdown')} caption={t('importing.captionTopBarTelescopes')} isDark={isDark} />
            <Screenshot src={backupStatusShot} alt={t('importing.altBackupStatus')} caption={t('importing.captionBackupStatus')} isDark={isDark} />
          </ScreenshotPair>
          <Note isDark={isDark}>
            {t('importing.note')}
          </Note>
        </GuideCard>
      );

    case 'uploading':
      return (
        <GuideCard icon={Upload} title={t('uploading.title')} lead={t('uploading.lead')} isDark={isDark}>
          <Bullets
            isDark={isDark}
            items={[
              <>{t('uploading.bullet1')}</>,
              <>{t('uploading.bullet2')}</>,
              <>{t('uploading.bullet3')}</>,
            ]}
          />
          <ScreenshotPair>
            <Screenshot src={uploadFilesShot} alt={t('uploading.altUploadFiles')} caption={t('uploading.captionUploadFiles')} isDark={isDark} />
            <Screenshot src={newObservationShot} alt={t('uploading.altNewObservation')} caption={t('uploading.captionNewObservation')} isDark={isDark} />
          </ScreenshotPair>
        </GuideCard>
      );

    case 'manual-import':
      return (
        <div className="space-y-6">
        <GuideCard
          icon={HardDrive}
          title={t('manualImport.title')}
          lead={t('manualImport.lead')}
          isDark={isDark}
        >
          <Steps
            isDark={isDark}
            steps={[
              {
                title: t('manualImport.step1Title'),
                body: (
                  <>
                    <p>
                      {t('manualImport.step1Body')}
                    </p>
                    <Screenshot
                      src={manualImportDropZoneShot}
                      alt={t('manualImport.step1Alt')}
                      caption={t('manualImport.step1Caption')}
                      isDark={isDark}
                    />
                  </>
                ),
              },
              {
                title: t('manualImport.step2Title'),
                body: (
                  <>
                    <p>
                      {t('manualImport.step2Body')}
                    </p>
                    <Screenshot
                      src={manualImportFolderPickerShot}
                      alt={t('manualImport.step2Alt')}
                      caption={t('manualImport.step2Caption')}
                      isDark={isDark}
                    />
                  </>
                ),
              },
              {
                title: t('manualImport.step3Title'),
                body: (
                  <>
                    <p>
                      <Trans
                        i18nKey="manualImport.step3Body"
                        ns="help"
                        components={{ 1: <Code isDark={isDark} />, 3: <Code isDark={isDark} /> }}
                      />
                    </p>
                    <Screenshot
                      src={manualImportUncPathShot}
                      alt={t('manualImport.step3Alt')}
                      caption={t('manualImport.step3Caption')}
                      isDark={isDark}
                    />
                  </>
                ),
              },
              {
                title: t('manualImport.step4Title'),
                body: t('manualImport.step4Body'),
              },
            ]}
          />
          <Note isDark={isDark}>
            {t('manualImport.note')}
          </Note>
        </GuideCard>

        <GuideCard
          icon={UserCog}
          title={t('giveAccess.title')}
          lead={t('giveAccess.lead')}
          isDark={isDark}
        >
          <ServiceAccountTabs isDark={isDark} t={t} />
          <Note isDark={isDark}>
            {t('giveAccess.note')}
          </Note>
        </GuideCard>
        </div>
      );

    case 'mobile-devices':
      return (
        <GuideCard icon={Smartphone} title={t('mobileDevices.title')} lead={t('mobileDevices.lead')} isDark={isDark}>
          <Steps
            isDark={isDark}
            steps={[
              {
                title: t('mobileDevices.step1Title'),
                body: (
                  <>
                    <p>{t('mobileDevices.step1Body')}</p>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <a
                        href="https://apps.apple.com/us/app/nebulis/id6769902885"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                      >
                        {t('mobileDevices.appStoreLink')}
                      </a>
                      <a
                        href="https://play.google.com/store/apps/details?id=com.nebulis.app"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                      >
                        {t('mobileDevices.googlePlayLink')}
                      </a>
                    </div>
                    <Screenshot
                      src={mobileMenuShot}
                      alt={t('mobileDevices.step1Alt')}
                      caption={t('mobileDevices.step1Caption')}
                      isDark={isDark}
                      width="max-w-sm"
                    />
                  </>
                ),
              },
              {
                title: t('mobileDevices.step2Title'),
                body: (
                  <>
                    <p>
                      <Trans
                        i18nKey="mobileDevices.step2Body"
                        ns="help"
                        components={{ 1: <Code isDark={isDark} />, 3: <Code isDark={isDark} /> }}
                      />
                    </p>
                    <Screenshot
                      src={mobileQrShot}
                      alt={t('mobileDevices.step2Alt')}
                      caption={t('mobileDevices.step2Caption')}
                      isDark={isDark}
                      width="max-w-xs"
                    />
                  </>
                ),
              },
              {
                title: t('mobileDevices.step3Title'),
                body: (
                  <>
                    <p>
                      <Trans
                        i18nKey="mobileDevices.step3Body"
                        ns="help"
                        components={{ 1: <Code isDark={isDark} />, 3: <Code isDark={isDark} /> }}
                      />
                    </p>
                    <Screenshot
                      src={mobileEnterCodeShot}
                      alt={t('mobileDevices.step3Alt')}
                      caption={t('mobileDevices.step3Caption')}
                      isDark={isDark}
                      width="max-w-xs"
                    />
                  </>
                ),
              },
              {
                title: t('mobileDevices.step4Title'),
                body: (
                  <>
                    <p>{t('mobileDevices.step4Body')}</p>
                    <Screenshot
                      src={settingsDevicesShot}
                      alt={t('mobileDevices.step4Alt')}
                      caption={t('mobileDevices.step4Caption')}
                      isDark={isDark}
                    />
                  </>
                ),
              },
            ]}
          />
        </GuideCard>
      );

    case 'pixinsight':
      return <PixInsightHelp isDark={isDark} />;

    case 'troubleshooting':
      return (
        <GuideCard icon={AlertTriangle} title={t('troubleshooting.title')} lead={t('troubleshooting.lead')} isDark={isDark}>
          <Bullets
            isDark={isDark}
            items={[
              <>{t('troubleshooting.bullet1')}</>,
              <>{t('troubleshooting.bullet2')}</>,
              <>{t('troubleshooting.bullet3')}</>,
              <>{t('troubleshooting.bullet4')}</>,
              <>{t('troubleshooting.bullet5')}</>,
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

function PixInsightHelp({ isDark }: { isDark: boolean }) {
  const repoUrl = typeof window !== 'undefined' ? `${window.location.origin}/plugins/pixinsight/` : 'http://<nebulis-host>:3002/plugins/pixinsight/';
  return (
    <GuideCard
      icon={Layers}
      title="PixInsight integration"
      lead="Nebulis features an official PixInsight integration via an embedded update repository and a native PJSR connector (v2.1.0). Browse objects, download light subframes, manage calibrations with linked target visibility, and sync your process icons and processing projects."
      isDark={isDark}
    >
      <div className="space-y-6">
        <div>
          <h3 className={`text-sm font-semibold mb-2 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>1. Add the Repository to PixInsight</h3>
          <p className={`text-sm leading-relaxed mb-3 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            Nebulis serves an official PixInsight update repository at <code className="px-1.5 py-0.5 rounded text-xs bg-slate-800 text-sky-400 font-mono">/plugins/pixinsight/</code>. Add it once to receive automated updates directly through PixInsight:
          </p>
          <div className={`p-3.5 rounded-xl border font-mono text-xs mb-3 flex items-center justify-between ${isDark ? 'bg-slate-950 border-slate-800 text-sky-400' : 'bg-slate-100 border-slate-300 text-sky-700'}`}>
            <span>{repoUrl}</span>
          </div>
          <Bullets
            isDark={isDark}
            items={[
              <>In PixInsight, navigate to <b>Resources → Updates → Manage Repositories</b>.</>,
              <>Click <b>Add</b>, paste your Nebulis repository URL above (make sure to include the trailing slash <code className="font-mono">/</code>), and click <b>OK</b>.</>,
              <>Go to <b>Resources → Updates → Check for Updates</b>. PixInsight will find <b>Nebulis Connector for PixInsight (v2.1.0)</b>. Click <b>Apply updates</b> and restart PixInsight.</>,
              <>Launch the connector from <b>Script → Nebulis → Nebulis Connector</b>.</>,
            ]}
          />
        </div>

        <div>
          <h3 className={`text-sm font-semibold mb-2 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>2. Authenticate with an API Key</h3>
          <p className={`text-sm leading-relaxed mb-3 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            The connector authenticates using user-linked API keys:
          </p>
          <Bullets
            isDark={isDark}
            items={[
              <>In your Nebulis web browser, open <b>Settings → Account → API Keys</b>.</>,
              <>Click <b>New API Key</b>, give it a descriptive name (e.g. <i>PixInsight Mac Studio</i>), and copy the key (prefixed with <code className="font-mono">neb-</code>).</>,
              <>In PixInsight, click the <b>⚙ Settings</b> icon in the connector header or bottom bar, paste the key into <b>Nebulis API Key</b>, and click <b>Save Settings</b>.</>,
            ]}
          />
        </div>

        <div>
          <h3 className={`text-sm font-semibold mb-2 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>3. Connector Interface Overview</h3>
          <Terms
            isDark={isDark}
            label="Tabbed Architecture"
            items={[
              {
                t: 'Library & Download',
                d: 'Browse your DSO targets with real-time DSO image previews, catalog identifiers, and session breakdowns (date, filter, subframes, telescope rig). Download raw light subframes directly into your local workspace folder.',
              },
              {
                t: 'Calibration Library',
                d: 'Dedicated browser for all Master Darks, Flats, Bias, and Flat-Darks across all telescopes and rigs. For Flats, the linked target object (e.g. NGC 6888) is explicitly displayed. Select any calibration sets and batch-download them to your local calibrations folder.',
              },
              {
                t: 'Project Sync',
                d: 'Two-way synchronization for your processing workflows. Export active PixInsight process icons (.xpsm) or upload master integrated images (.xisf) directly into the object\'s processing_project/ folder on Nebulis.',
              },
              {
                t: '⚙ Settings Window',
                d: 'Dedicated sub-window for server connection, API key testing, download root directories, and download acceleration options.',
              },
            ]}
          />
        </div>
      </div>
    </GuideCard>
  );
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

function ConnectionMethodTabs({ isDark, t }: { isDark: boolean; t: TFunc }) {
  const [active, setActive] = useState<'wifi' | 'usb' | 'network'>('wifi');

  const tabs: { id: typeof active; labelKey: string; icon: LucideIcon }[] = [
    { id: 'wifi', labelKey: 'connectionMethodTabs.wifi', icon: Wifi },
    { id: 'usb', labelKey: 'connectionMethodTabs.usb', icon: Usb },
    { id: 'network', labelKey: 'connectionMethodTabs.network', icon: Server },
  ];

  return (
    <div>
      <div className={`inline-flex p-1 rounded-xl gap-1 ${isDark ? 'bg-slate-950/60' : 'bg-slate-100'}`}>
        {tabs.map(tab => {
          const Icon = tab.icon;
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActive(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                isActive
                  ? isDark ? 'bg-accent-500 text-slate-950' : 'bg-white text-accent-700 shadow-sm'
                  : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      {active === 'wifi' && (
        <div className="mt-3">
          <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            <Trans
              i18nKey="connectionMethodTabs.wifiBody"
              ns="help"
              components={{ 1: <Code isDark={isDark} />, 3: <Code isDark={isDark} /> }}
            />
          </p>
          <Screenshot
            src={wifiHostnameTestShot}
            alt={t('connectionMethodTabs.wifiAlt')}
            caption={t('connectionMethodTabs.wifiCaption')}
            isDark={isDark}
            width="max-w-lg"
          />
        </div>
      )}

      {active === 'usb' && (
        <div className="mt-3">
          <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            {t('connectionMethodTabs.usbBody')}
          </p>
          <Screenshot
            src={usbPathTypedShot}
            alt={t('connectionMethodTabs.usbAlt')}
            caption={t('connectionMethodTabs.usbCaption')}
            isDark={isDark}
            width="max-w-lg"
          />
        </div>
      )}

      {active === 'network' && (
        <div className="mt-3">
          <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            <Trans
              i18nKey="connectionMethodTabs.networkBody"
              ns="help"
              components={{ 1: <Code isDark={isDark} /> }}
            />
          </p>
          <Screenshot
            src={otherSmbShareShot}
            alt={t('connectionMethodTabs.networkAlt')}
            caption={t('connectionMethodTabs.networkCaption')}
            isDark={isDark}
            width="max-w-lg"
          />
        </div>
      )}
    </div>
  );
}

function ServiceAccountTabs({ isDark, t }: { isDark: boolean; t: TFunc }) {
  const [active, setActive] = useState<'windows' | 'macos'>('windows');
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  const code = <Code isDark={isDark} />;

  const tabs: { id: typeof active; labelKey: string }[] = [
    { id: 'windows', labelKey: 'serviceAccountTabs.windows' },
    { id: 'macos', labelKey: 'serviceAccountTabs.macos' },
  ];

  return (
    <div>
      <div className={`inline-flex p-1 rounded-xl gap-1 ${isDark ? 'bg-slate-950/60' : 'bg-slate-100'}`}>
        {tabs.map(tab => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActive(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                isActive
                  ? isDark ? 'bg-accent-500 text-slate-950' : 'bg-white text-accent-700 shadow-sm'
                  : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      {active === 'windows' && (
        <div className="mt-4">
          <p className={`text-sm leading-relaxed ${body}`}>
            <Trans i18nKey="serviceAccountTabs.winIntro" ns="help" components={{ 1: code }} />
          </p>
          <div className="mt-4">
            <Steps
              isDark={isDark}
              steps={[
                {
                  title: t('serviceAccountTabs.winStep1Title'),
                  body: (
                    <Trans i18nKey="serviceAccountTabs.winStep1Body" ns="help" components={{ 1: code, 3: code }} />
                  ),
                },
                {
                  title: t('serviceAccountTabs.winStep2Title'),
                  body: (
                    <Trans i18nKey="serviceAccountTabs.winStep2Body" ns="help" components={{ 1: code, 3: code }} />
                  ),
                },
                {
                  title: t('serviceAccountTabs.winStep3Title'),
                  body: (
                    <Trans i18nKey="serviceAccountTabs.winStep3Body" ns="help" components={{ 1: code, 3: code }} />
                  ),
                },
                {
                  title: t('serviceAccountTabs.winStep4Title'),
                  body: (
                    <Trans i18nKey="serviceAccountTabs.winStep4Body" ns="help" components={{ 1: code }} />
                  ),
                },
              ]}
            />
          </div>
          <p className={`text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            <Trans i18nKey="serviceAccountTabs.winFooter" ns="help" components={{ 1: code, 3: code }} />
          </p>
        </div>
      )}

      {active === 'macos' && (
        <div className="mt-4">
          <p className={`text-sm leading-relaxed ${body}`}>
            {t('serviceAccountTabs.macIntro')}
          </p>
          <div className="mt-4">
            <Steps
              isDark={isDark}
              steps={[
                {
                  title: t('serviceAccountTabs.macStep1Title'),
                  body: (
                    <Trans i18nKey="serviceAccountTabs.macStep1Body" ns="help" components={{ 1: code, 3: code, 5: <em /> }} />
                  ),
                },
                {
                  title: t('serviceAccountTabs.macStep2Title'),
                  body: (
                    <Trans i18nKey="serviceAccountTabs.macStep2Body" ns="help" components={{ 1: code, 3: code }} />
                  ),
                },
                {
                  title: t('serviceAccountTabs.macStep3Title'),
                  body: t('serviceAccountTabs.macStep3Body'),
                },
              ]}
            />
          </div>
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

/** Inline code span. `children` is optional because every call site passes it
 *  through `<Trans components={{...}}>` or a `t()` interpolation, where the
 *  matched text is injected as children at runtime, not at the JSX site. */
function Code({ children, isDark }: { children?: ReactNode; isDark: boolean }) {
  return (
    <code className={`px-1.5 py-0.5 rounded text-xs font-mono ${isDark ? 'bg-slate-800 text-accent-400' : 'bg-slate-100 text-accent-700'}`}>
      {children}
    </code>
  );
}

function WhatIsNebulis({ isDark, t }: { isDark: boolean; t: TFunc }) {
  const body = isDark ? 'text-slate-300' : 'text-slate-600';
  return (
    <GuideCard
      icon={Info}
      title={t('whatIsNebulis.title')}
      lead={t('whatIsNebulis.lead')}
      isDark={isDark}
    >
      <div className={`flex flex-col gap-4 text-sm leading-relaxed ${body}`}>
        <p>
          {t('whatIsNebulis.p1')}
        </p>
        <p>
          {t('whatIsNebulis.p2')}
        </p>
      </div>
      <Note isDark={isDark}>
        <div>
          <p className="font-semibold">{t('whatIsNebulis.freeTitle')}</p>
          <ul className="mt-2 space-y-1">
            <li className="flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-current shrink-0" />
              {t('whatIsNebulis.noCloud')}
            </li>
            <li className="flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-current shrink-0" />
              {t('whatIsNebulis.noSubscription')}
            </li>
            <li className="flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-current shrink-0" />
              {t('whatIsNebulis.noStorageFees')}
            </li>
          </ul>
          <p className="mt-2">{t('whatIsNebulis.runsLocally')}</p>
        </div>
      </Note>
    </GuideCard>
  );
}

function QuickAnswers({ isDark, t }: { isDark: boolean; t: TFunc }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const qas: { key: string; q: string; a: string }[] = [
    { key: 'sendImages', q: t('quickAnswers.sendImages.q'), a: t('quickAnswers.sendImages.a') },
    { key: 'locationSharing', q: t('quickAnswers.locationSharing.q'), a: t('quickAnswers.locationSharing.a') },
    { key: 'whichTelescopes', q: t('quickAnswers.whichTelescopes.q'), a: t('quickAnswers.whichTelescopes.a') },
    { key: 'firstSteps', q: t('quickAnswers.firstSteps.q'), a: t('quickAnswers.firstSteps.a') },
    { key: 'newImages', q: t('quickAnswers.newImages.q'), a: t('quickAnswers.newImages.a') },
    { key: 'viewOnPhone', q: t('quickAnswers.viewOnPhone.q'), a: t('quickAnswers.viewOnPhone.a') },
    // Reference rather than "how do I start", so it sits last: the answer is a
    // mapping table in prose, and you only want it once a filter has surprised
    // you by leaving something out.
    { key: 'objectFilters', q: t('quickAnswers.objectFilters.q'), a: t('quickAnswers.objectFilters.a') },
  ];

  return (
    <div className={`rounded-2xl border ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
      <div className={`flex items-center gap-3 px-5 pt-4 pb-3 border-b ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        <span className={`inline-flex items-center justify-center w-9 h-9 rounded-xl ${isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-100 text-accent-700'}`}>
          <HelpCircle className="w-4.5 h-4.5" />
        </span>
        <div className="min-w-0">
          <h2 className={`font-display text-lg font-bold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{t('quickAnswers.title')}</h2>
          <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>{t('quickAnswers.subtitle')}</p>
        </div>
      </div>
      <div className="px-3 py-2 flex flex-col gap-1">
        {qas.map(qa => {
          const isOpen = !!open[qa.key];
          return (
            <div key={qa.key} className={isDark ? 'text-slate-300' : 'text-slate-700'}>
              <button
                onClick={() => setOpen(o => ({ ...o, [qa.key]: !o[qa.key] }))}
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
