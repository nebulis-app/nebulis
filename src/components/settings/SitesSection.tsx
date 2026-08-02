import { SiteManagerList } from './SiteManagerList';
import { Sec } from './SettingsUI';

/**
 * Observing sites — the places (and skies) the user observes from. Replaces
 * the old single-location form: any number of entries can be defined, each
 * bundling coordinates with the sky settings that apply there. The Planner
 * and Forecast pages pick which one to compute for.
 *
 * The list/add/edit/delete/set-default/set-visible-sky logic lives in
 * SiteManagerList, shared with the popup reachable from Planner/Forecast
 * (SiteManagerModal) so there is exactly one implementation.
 *
 * The default site's coordinates are mirrored onto the legacy Settings
 * fields server-side, so anything that hasn't been updated to read sites
 * directly (older native app builds) keeps working against whichever site is
 * marked default.
 */
export function SitesSection({ isDark }: { isDark: boolean }) {
  return (
    <Sec
      title="Observing sites"
      description="Every place you observe from. Planner and Forecast let you switch between them."
      isDark={isDark}
    >
      <div className="p-4 sm:p-5">
        <SiteManagerList isDark={isDark} />
      </div>
    </Sec>
  );
}
