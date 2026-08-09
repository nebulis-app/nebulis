import { useTheme, type Theme } from '../../hooks/useTheme';
import { useNavVisibility, NAV_ITEMS } from '../../hooks/useNavVisibility';
import type { Settings as SettingsType } from '../../types';
import { Sec, Row, RowGroup, Seg, RadioCard, Toggle } from './SettingsUI';
import { SoftwareUpdateCard } from './SoftwareUpdateCard';
import { NightlyMaintenanceSection } from './NightlyMaintenanceSection';
import { Telescope, Globe, CloudMoon, Crosshair, BookOpen, HelpCircle } from 'lucide-react';

const NAV_ITEM_ICONS: Record<string, React.ReactNode> = {
  forecast: <CloudMoon className="w-4 h-4" />,
  planner:  <Crosshair className="w-4 h-4" />,
  catalogs: <BookOpen className="w-4 h-4" />,
  help:     <HelpCircle className="w-4 h-4" />,
};

// Each description says what the theme looks like or when to reach for it, in
// the same shape, so the four read as one set of choices.
const THEME_OPTIONS: { id: Theme; label: string; description: string }[] = [
  { id: 'light', label: 'Light', description: 'Bright, for daytime' },
  { id: 'dark',  label: 'Dark',  description: 'Default, for indoor use' },
  { id: 'space', label: 'Space', description: 'Deep violet, high contrast' },
  { id: 'night', label: 'Night', description: 'Red light, preserves night vision' },
];

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

function ImageSourceOption({
  value,
  current,
  onSelect,
  isDark,
  icon,
  label,
  description,
}: {
  value: 'sky-survey' | 'telescope';
  current: 'sky-survey' | 'telescope';
  onSelect: (v: 'sky-survey' | 'telescope') => void;
  isDark: boolean;
  icon: React.ReactNode;
  label: string;
  description: string;
}) {
  const selected = value === current;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`w-full text-left flex items-start gap-3 p-3.5 rounded-xl border transition-all ${
        selected
          ? isDark
            ? 'border-amber-500/60 bg-amber-500/10'
            : 'border-amber-400 bg-amber-50'
          : isDark
            ? 'border-slate-700 bg-slate-800/40 hover:border-slate-600'
            : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
    >
      <div className={`mt-0.5 p-1.5 rounded-lg flex-shrink-0 ${
        selected
          ? isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-100 text-amber-600'
          : isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'
      }`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium ${
          selected
            ? isDark ? 'text-amber-300' : 'text-amber-700'
            : isDark ? 'text-slate-200' : 'text-slate-700'
        }`}>
          {label}
        </div>
        <div className={`text-xs mt-0.5 leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {description}
        </div>
      </div>
      <div className={`mt-1 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all ${
        selected
          ? isDark ? 'border-amber-400 bg-amber-400' : 'border-amber-500 bg-amber-500'
          : isDark ? 'border-slate-600' : 'border-slate-300'
      }`}>
        {selected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
      </div>
    </button>
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
  const { theme, setTheme } = useTheme();
  const { isVisible, toggle } = useNavVisibility();
  const tempUnit = form.temperatureUnit ?? 'celsius';
  const windUnit = form.windSpeedUnit ?? 'mph';
  const imageSource = form.galleryImageSource ?? 'sky-survey';

  return (
    <>
      {/* Appearance — theme cards only. The nav toggles used to share this card
          via a second nested card; they are their own section now. */}
      <Sec
        title="Appearance"
        description="How Nebulis looks. Night mode keeps your eyes adapted at the telescope."
        isDark={isDark}
      >
        <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
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

      {/* Library — one card, with label strips where nested cards used to be. */}
      <Sec
        title="Library"
        description="How object cards and the slideshow behave."
        isDark={isDark}
      >
        <RowGroup
          label="Default object image"
          description="Shown on library cards when an object has no custom image."
          isDark={isDark}
        />
        <div className={`p-4 space-y-2 border-b ${isDark ? 'border-slate-800/70' : 'border-slate-100'}`}>
          <ImageSourceOption
            value="sky-survey"
            current={imageSource}
            onSelect={v => setForm(f => ({ ...f, galleryImageSource: v }))}
            isDark={isDark}
            icon={<Globe className="w-4 h-4" />}
            label="Reference image"
            description="Catalog imagery from Hubble, DSS2, NASA, and Caldwell. Rich color, wide availability."
          />
          <ImageSourceOption
            value="telescope"
            current={imageSource}
            onSelect={v => setForm(f => ({ ...f, galleryImageSource: v }))}
            isDark={isDark}
            icon={<Telescope className="w-4 h-4" />}
            label="My telescope images"
            description="Your own captures, for every object you have imaged."
          />
        </div>

        <RowGroup
          label="Catalog naming"
          description="Which catalog names a new object's folder when it has both an NGC/IC and a Caldwell designation."
          isDark={isDark}
        />
        <Row
          label="Prefer Caldwell numbers"
          description={'New objects are named "C5" rather than "IC342". Existing folders are not renamed.'}
          isDark={isDark}
        >
          <Toggle
            checked={(form.preferredCatalog ?? 'default') === 'caldwell'}
            onChange={v => setForm(f => ({ ...f, preferredCatalog: v ? 'caldwell' : 'default' }))}
          />
        </Row>

        <RowGroup label="Session grouping" isDark={isDark} />
        <Row
          label="Group by observing night"
          description="An 11pm to 1am session counts as one night rather than splitting across two calendar dates."
          isDark={isDark}
        >
          <Toggle
            checked={form.groupObservingNights ?? true}
            onChange={v => setForm(f => ({ ...f, groupObservingNights: v }))}
          />
        </Row>

        <RowGroup label="Image Gallery" isDark={isDark} />
        <Row
          label="Show processed images only"
          description='The Gallery page opens with the "Processed only" filter already on. You can still turn it off there.'
          isDark={isDark}
        >
          <Toggle
            checked={form.galleryProcessedOnlyDefault ?? false}
            onChange={v => setForm(f => ({ ...f, galleryProcessedOnlyDefault: v }))}
          />
        </Row>

        <RowGroup label="Planetarium mode" isDark={isDark} />
        <Row
          label="Show object information"
          description="Shows the name, type, and distance while images play."
          isDark={isDark}
        >
          <Toggle
            checked={form.planetariumShowInfo ?? true}
            onChange={v => setForm(f => ({ ...f, planetariumShowInfo: v }))}
          />
        </Row>
        <Row
          label="Rotate images 90° counter-clockwise"
          description="Corrects telescopes that capture rotated. Applies to the slideshow too."
          isDark={isDark}
        >
          <Toggle
            checked={form.slideshowRotateCCW ?? false}
            onChange={v => setForm(f => ({ ...f, slideshowRotateCCW: v }))}
          />
        </Row>
        <Row
          label="Start with processed images only"
          description="The slideshow opens with only processed images. You can still switch to All Images while it plays."
          isDark={isDark}
        >
          <Toggle
            checked={form.planetariumProcessedOnlyDefault ?? false}
            onChange={v => setForm(f => ({ ...f, planetariumProcessedOnlyDefault: v }))}
          />
        </Row>
      </Sec>

      {/* Nightly maintenance */}
      <NightlyMaintenanceSection isDark={isDark} form={form} setForm={setForm} />

      {/* Software updates */}
      <SoftwareUpdateCard isDark={isDark} form={form} setForm={setForm} />
    </>
  );
}
