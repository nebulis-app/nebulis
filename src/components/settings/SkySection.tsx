import type { Settings as SettingsType } from '../../types';
import { LocationSection } from './LocationSection';
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
  return (
    <div className="space-y-10">
      <LocationSection isDark={isDark} form={form} setForm={setForm} />
      <CatalogSection isDark={isDark} form={form} setForm={setForm} />
      <DataSourcesSection isDark={isDark} />
    </div>
  );
}
