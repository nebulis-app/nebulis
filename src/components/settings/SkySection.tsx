import type { Settings as SettingsType } from '../../types';
import { SitesSection } from './SitesSection';
import { CatalogSection } from './CatalogSection';
import { DataSourcesSection } from './DataSourcesSection';

/** Sky = where you observe from, what catalogs you trust, and where the data comes from. */
export function SkySection({
  isDark,
  form,
  setForm,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
}) {
  // No wrapping space-y here: `Sec` (see SettingsUI.tsx) already carries its
  // own `mt-10 first:mt-0`, so a Fragment lets it space itself against
  // whichever Sec — from any of these three sub-components — actually lands
  // first in the DOM, the same way GeneralSection and LibrarySection do.
  return (
    <>
      <SitesSection isDark={isDark} />
      <CatalogSection isDark={isDark} form={form} setForm={setForm} />
      <DataSourcesSection isDark={isDark} />
    </>
  );
}
