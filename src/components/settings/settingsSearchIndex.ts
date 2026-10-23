/** What the Settings search can find. Labels come from the same i18n keys the
 *  panes render, so a result always reads exactly like the row it opens (and is
 *  translated for free). Only the pane each key lives in is hand-maintained here.
 *
 *  `group` / `section` are SETTINGS_NAV ids; admin-only visibility is inherited
 *  from the nav (see useSettingsSearch), not repeated per entry. `keywords` are
 *  extra English terms people are likely to type for a setting whose label
 *  doesn't contain them. */
export interface SettingsSearchEntry {
  group: string;
  section?: string;
  /** i18n key of the label shown in results and matched against the row. */
  labelKey: string;
  ns?: 'settings' | 'common';
  keywords?: string;
}

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  // General
  { group: 'general', labelKey: 'settings.language.label', ns: 'common', keywords: 'language locale translation' },
  { group: 'general', labelKey: 'appearance.title', keywords: 'theme dark light night red space mode' },
  { group: 'general', labelKey: 'appearance.nebulaBackdrop.label', keywords: 'background animation' },
  { group: 'general', labelKey: 'appearance.uiScale.label', keywords: 'zoom scale size text bigger smaller larger font display' },
  { group: 'general', labelKey: 'appearance.compactBanners.label', keywords: 'hero header banner collapse fold shrink small' },
  { group: 'general', labelKey: 'navigation.title', keywords: 'tabs menu order reorder hide' },
  { group: 'general', labelKey: 'units.temperature.label', keywords: 'celsius fahrenheit' },
  { group: 'general', labelKey: 'units.windSpeed.label', keywords: 'mph kmh knots' },

  // Library
  { group: 'library', section: 'display', labelKey: 'librarySection.display.cardPictures.label', keywords: 'reference image my telescope images catalog thumbnail hubble dss2 nasa captures object card' },
  { group: 'library', section: 'display', labelKey: 'librarySection.display.galleryProcessedOnly.label' },
  { group: 'library', section: 'display', labelKey: 'librarySection.display.objectPages.label' },
  { group: 'library', section: 'display', labelKey: 'librarySection.display.slideshowShowInfo.label' },
  { group: 'library', section: 'display', labelKey: 'librarySection.display.slideshowProcessedOnly.label' },
  { group: 'library', section: 'display', labelKey: 'librarySection.imageBehavior.rotate.label', keywords: 'orientation flip' },
  { group: 'library', section: 'organization', labelKey: 'librarySection.organization.preferCaldwell.label', keywords: 'messier ngc names' },
  { group: 'library', section: 'organization', labelKey: 'librarySection.organization.groupByNight.label' },
  { group: 'library', section: 'organization', labelKey: 'librarySection.organization.groupCompanions.label', keywords: 'same frame mosaic' },
  { group: 'library', section: 'organization', labelKey: 'librarySection.filterAliases.title', keywords: 'filter names narrowband' },
  { group: 'library', section: 'processing', labelKey: 'librarySection.organization.autoSolve.label', keywords: 'plate solve astrometry' },
  { group: 'library', section: 'processing', labelKey: 'librarySection.organization.autoMeasure.label', keywords: 'fwhm hfr quality analyze' },

  // Equipment
  { group: 'hardware', labelKey: 'connectionSection.title', keywords: 'seestar dwarf connect add telescope import' },
  { group: 'hardware', labelKey: 'librarySection.calibration.expiryDays.label', keywords: 'darks bias flats calibration frames expire' },
  { group: 'sky', section: 'sites', labelKey: 'sitesSection.title', keywords: 'location latitude longitude bortle horizon' },
  { group: 'sky', section: 'catalogs', labelKey: 'offlineCatalog.title', keywords: 'download ngc offline' },
  { group: 'sky', section: 'catalogs', labelKey: 'tleCatalog.title', keywords: 'satellite tle iss celestrak' },
  { group: 'integrations', labelKey: 'featuresSection.pixinsight.label', keywords: 'pixinsight plugin xisf' },

  // System
  { group: 'storage', section: 'location', labelKey: 'libraryLocation.title', keywords: 'folder path move drive disk' },
  { group: 'storage', section: 'archive', labelKey: 'archive.title', keywords: 'external disk backup nas' },
  { group: 'storage', section: 'archive', labelKey: 'archive.includeSubframes.label' },
  { group: 'storage', section: 'archive', labelKey: 'archive.minAge.label' },
  { group: 'storage', section: 'archive', labelKey: 'archive.retention.label' },
  { group: 'storage', section: 'archive', labelKey: 'archive.removeLocal.label' },
  { group: 'storage', section: 'linked', labelKey: 'linkedFolders.title', keywords: 'link watch rescan external' },
  { group: 'storage', section: 'backups', labelKey: 'databaseBackups.title', keywords: 'restore snapshot' },
  { group: 'storage', section: 'cleanup', labelKey: 'libraryCleanup.title', keywords: 'duplicates missing files health' },
  { group: 'storage', section: 'maintenance', labelKey: 'nightlyMaintenance.title', keywords: 'schedule prefetch housekeeping' },
  { group: 'storage', section: 'maintenance', labelKey: 'nightlyMaintenance.tasks.plannerPrefetch.label' },
  { group: 'storage', section: 'maintenance', labelKey: 'nightlyMaintenance.tasks.catalogData.label' },
  { group: 'storage', section: 'maintenance', labelKey: 'nightlyMaintenance.tasks.housekeeping.label' },
  { group: 'storage', section: 'maintenance', labelKey: 'nightlyMaintenance.tasks.forecast.label' },
  { group: 'account', section: 'users', labelKey: 'usersSection.title', keywords: 'password accounts roles permissions' },
  { group: 'account', section: 'devices', labelKey: 'connectedDevices.title', keywords: 'phone pair link' },
  { group: 'account', section: 'api-keys', labelKey: 'apiKeys.title', keywords: 'token' },
  { group: 'alerts', labelKey: 'alerts.title', keywords: 'notifications push telegram email sms' },
  { group: 'alerts', labelKey: 'alerts.clearNight.title', keywords: 'weather notification' },
  { group: 'alerts', labelKey: 'alerts.event.night.dew.label', keywords: 'dew heater' },
  { group: 'alerts', labelKey: 'alerts.event.import.finished.label' },
  { group: 'alerts', labelKey: 'alerts.event.import.failed.label' },
  { group: 'alerts', labelKey: 'alerts.event.update.available.label' },
  { group: 'updates', labelKey: 'softwareUpdate.title', keywords: 'upgrade version' },
  { group: 'updates', labelKey: 'softwareUpdate.autoUpdate.label' },
  { group: 'updates', labelKey: 'softwareUpdate.channel.label', keywords: 'beta stable' },

  // Advanced
  { group: 'log', labelKey: 'systemLog.title', keywords: 'errors events history' },
  { group: 'danger', labelKey: 'dangerSection.debugLogging.title', keywords: 'verbose diagnostics' },
  { group: 'danger', labelKey: 'dangerSection.deleteAllData.title', keywords: 'reset wipe erase factory' },
  { group: 'about', labelKey: 'about.title', keywords: 'version credits licenses feedback support data sources' },
];
