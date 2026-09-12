import { useTheme, type Theme, THEME_OPTIONS } from '../../hooks/useTheme';
import { useNavVisibility, NAV_ITEMS } from '../../hooks/useNavVisibility';
import type { Settings as SettingsType } from '../../types';
import { Sec, Row, Seg, RadioCard, Toggle } from './SettingsUI';
import { NightlyMaintenanceSection } from './NightlyMaintenanceSection';
import { Images, CloudMoon, Crosshair, BookOpen, HelpCircle } from 'lucide-react';

const NAV_ITEM_ICONS: Record<string, React.ReactNode> = {
  gallery:  <Images className="w-4 h-4" />,
  forecast: <CloudMoon className="w-4 h-4" />,
  planner:  <Crosshair className="w-4 h-4" />,
  catalogs: <BookOpen className="w-4 h-4" />,
  help:     <HelpCircle className="w-4 h-4" />,
};

/** Tiny mini-UI swatches that hint at what the theme looks like. */
function ThemePreview({ id }: { id: Theme }) {
  const palette: Record<Theme, { bg: string; surface: string; line: string; accent: string; text: string }> = {
    light: { bg: '#f4f6fa', surface: '#ffffff', line: '#e2e8f0', accent: '#f59e0b', text: '#0f172a' },
    dark:  { bg: '#0a0e17', surface: '#0f1524', line: '#1a2235', accent: '#fbbf24', text: '#e2e8f0' },
    space: { bg: '#06050f', surface: '#0d0b1f', line: '#1e1a40', accent: '#a78bfa', text: '#c8c3e0' },
    night: { bg: '#000000', surface: '#0a0000', line: '#2a0808', accent: '#cc3333', text: '#cc3333' },
  };
  const p = palette[id];
  return (
    <div className="relative h-20 w-full" style={{ background: p.bg }}>
      <div className="absolute inset-x-2 top-2 h-3 rounded" style={{ background: p.surface, border: `1px solid ${p.line}` }} />
      <div className="absolute inset-x-2 top-7 bottom-2 rounded" style={{ background: p.surface, border: `1px solid ${p.line}` }}>
        <div className="absolute left-2 top-2 h-1.5 w-10 rounded" style={{ background: p.text, opacity: 0.55 }} />
        <div className="absolute left-2 top-5 h-1 w-14 rounded" style={{ background: p.text, opacity: 0.25 }} />
        <div className="absolute right-2 bottom-2 h-2 w-6 rounded" style={{ background: p.accent }} />
      </div>
    </div>
  );
}

export function GeneralSection({
  isDark,
  form,
  setForm,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
}) {
  const { theme, setTheme, nebulaBackdrop, setNebulaBackdrop } = useTheme();
  const { isVisible, toggle } = useNavVisibility();
  // Matches the server default (server/lib/types/appSettings.ts /
  // saveSettingsRow's 'fahrenheit' fallback) and every other reader of this
  // field (ForecastPage, PlannerPage, ObservationDetail) — this used to say
  // 'celsius' and disagreed with all of them while the setting was unset.
  const tempUnit = form.temperatureUnit ?? 'fahrenheit';
  const windUnit = form.windSpeedUnit ?? 'mph';

  return (
    <>
      {/* Appearance — theme cards only. The nav toggles used to share this card
          via a second nested card; they are their own section now. */}
      <Sec
        title="Appearance"
        description="How Nebulis looks. Night mode keeps your eyes adapted at the telescope."
        isDark={isDark}
      >
        <div className={`p-4 grid grid-cols-2 md:grid-cols-4 gap-3 border-b ${
          isDark ? 'border-slate-800/70' : 'border-slate-100'
        }`}>
          {THEME_OPTIONS.map(opt => (
            <RadioCard
              key={opt.id}
              id={opt.id}
              active={theme === opt.id}
              onSelect={(id) => setTheme(id)}
              title={opt.label}
              description={opt.description}
              preview={<ThemePreview id={opt.id} />}
              isDark={isDark}
            />
          ))}
        </div>
        <Row
          label="Nebula backdrop"
          description="Sets a faint deep-sky image and starfield behind the app, showing through the gaps between panels. Works with the Dark theme; the Space theme already has its own."
          isDark={isDark}
        >
          <Toggle
            checked={nebulaBackdrop}
            onChange={setNebulaBackdrop}
            disabled={theme !== 'dark'}
          />
        </Row>
      </Sec>

      {/* Navigation */}
      <Sec
        title="Navigation bar"
        description="Which items appear in the top menu."
        isDark={isDark}
      >
        {NAV_ITEMS.map(item => (
          <Row key={item.id} label={item.label} isDark={isDark}>
            <span className="flex items-center gap-3">
              <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                {NAV_ITEM_ICONS[item.id]}
              </span>
              <Toggle checked={isVisible(item.id)} onChange={() => toggle(item.id)} />
            </span>
          </Row>
        ))}
      </Sec>

      {/* Units */}
      <Sec
        title="Units"
        description="How values are displayed across the app."
        isDark={isDark}
      >
        <Row label="Temperature" description="Weather, dew point, and sensor readings." isDark={isDark}>
          <Seg
            value={tempUnit}
            options={[
              { id: 'celsius',    label: '°C' },
              { id: 'fahrenheit', label: '°F' },
            ]}
            onChange={(id) => setForm(f => ({ ...f, temperatureUnit: id }))}
            isDark={isDark}
          />
        </Row>
        <Row label="Wind speed" description="Forecast page readings." isDark={isDark}>
          <Seg
            value={windUnit}
            options={[
              { id: 'mph', label: 'mph' },
              { id: 'kmh', label: 'km/h' },
            ]}
            onChange={(id) => setForm(f => ({ ...f, windSpeedUnit: id }))}
            isDark={isDark}
          />
        </Row>
      </Sec>

      {/* Nightly maintenance */}
      <NightlyMaintenanceSection isDark={isDark} form={form} setForm={setForm} />
    </>
  );
}
