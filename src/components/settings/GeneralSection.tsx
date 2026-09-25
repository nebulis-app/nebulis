import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme, type Theme, THEME_OPTIONS } from '../../hooks/useTheme';
import { useLanguage } from '../../hooks/useLanguage';
import { useNavVisibility, type NavItemId } from '../../hooks/useNavVisibility';
import type { Settings as SettingsType } from '../../types';
import { Sec, Row, Seg, RadioCard, Toggle, getInputClass } from './SettingsUI';
import { NightlyMaintenanceSection } from './NightlyMaintenanceSection';
import { Home, Library, Images, Calendar, CloudMoon, Crosshair, Star, BookOpen, Aperture, Settings as SettingsIcon, HelpCircle, GripVertical, Lock } from 'lucide-react';

const NAV_ITEM_ICONS: Record<NavItemId, React.ReactNode> = {
  home:          <Home className="w-4 h-4" />,
  library:       <Library className="w-4 h-4" />,
  gallery:       <Images className="w-4 h-4" />,
  observations:  <Calendar className="w-4 h-4" />,
  forecast:      <CloudMoon className="w-4 h-4" />,
  planner:       <Crosshair className="w-4 h-4" />,
  wishlist:      <Star className="w-4 h-4" />,
  catalogs:      <BookOpen className="w-4 h-4" />,
  calibrations:  <Aperture className="w-4 h-4" />,
  settings:      <SettingsIcon className="w-4 h-4" />,
  help:          <HelpCircle className="w-4 h-4" />,
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
  const { t } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const { theme, setTheme, nebulaBackdrop, setNebulaBackdrop } = useTheme();
  const { language, setLanguage, languages } = useLanguage();
  const { isVisible, toggle, isLocked, orderedItems, reorderItems, moveItem } = useNavVisibility();
  const [draggedId, setDraggedId] = useState<NavItemId | null>(null);
  const [dragOverId, setDragOverId] = useState<NavItemId | null>(null);
  // Matches the server default (server/lib/types/appSettings.ts /
  // saveSettingsRow's 'fahrenheit' fallback) and every other reader of this
  // field (ForecastPage, PlannerPage, ObservationDetail) — this used to say
  // 'celsius' and disagreed with all of them while the setting was unset.
  const tempUnit = form.temperatureUnit ?? 'fahrenheit';
  const windUnit = form.windSpeedUnit ?? 'mph';

  return (
    <>
      {/* Language */}
      <Sec title={t('settings.language.title')} description={t('settings.language.description')} isDark={isDark}>
        <Row label={t('settings.language.label')} isDark={isDark}>
          <select
            aria-label={t('settings.language.label')}
            value={language}
            onChange={(e) => {
              const code = e.target.value;
              const match = languages.find(l => l.code === code);
              if (match) setLanguage(match.code);
            }}
            className={`${getInputClass(isDark)} !w-auto !py-2 text-[13px]`}
          >
            {languages.map(l => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </Row>
      </Sec>

      {/* Appearance — theme cards only. The nav toggles used to share this card
          via a second nested card; they are their own section now. */}
      <Sec
        title={tSettings('appearance.title')}
        description={tSettings('appearance.description')}
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
              title={tSettings(opt.labelKey)}
              description={tSettings(opt.descriptionKey)}
              preview={<ThemePreview id={opt.id} />}
              isDark={isDark}
            />
          ))}
        </div>
        <Row
          label={tSettings('appearance.nebulaBackdrop.label')}
          description={tSettings('appearance.nebulaBackdrop.description')}
          isDark={isDark}
        >
          <Toggle
            checked={nebulaBackdrop}
            onChange={setNebulaBackdrop}
            disabled={theme !== 'dark'}
          />
        </Row>
      </Sec>

      {/* Navigation — every top-menu tab, reorderable by drag-and-drop (or the
          grip handle's arrow keys) and toggleable except Settings, which stays
          locked on since it's the only way back to this screen. */}
      <Sec
        title={tSettings('navigation.title')}
        description={tSettings('navigation.description')}
        isDark={isDark}
      >
        {orderedItems.map(item => {
          const locked = isLocked(item.id);
          const isDragging = draggedId === item.id;
          const isDragOver = dragOverId === item.id && draggedId !== null && draggedId !== item.id;
          return (
            <div
              key={item.id}
              draggable
              onDragStart={() => setDraggedId(item.id)}
              onDragOver={(e) => {
                e.preventDefault();
                if (draggedId && draggedId !== item.id) setDragOverId(item.id);
              }}
              onDragLeave={() => setDragOverId(prev => (prev === item.id ? null : prev))}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedId && draggedId !== item.id) reorderItems(draggedId, item.id);
                setDraggedId(null);
                setDragOverId(null);
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setDragOverId(null);
              }}
              className={`relative grid grid-cols-[auto_minmax(220px,2fr)_minmax(0,1fr)] items-center gap-3 md:gap-8 px-5 py-3.5 border-b last:border-b-0 transition-colors ${
                isDark ? 'border-slate-800/70' : 'border-slate-100'
              } ${isDragging ? 'opacity-40' : ''}`}
            >
              {/* Drop indicator: the item always lands directly above whichever
                  row is currently dragged over (reorderItems' "insert before"
                  semantics), so this line marks the real landing spot, not just
                  a generic hover state. */}
              {isDragOver && (
                <div className="pointer-events-none absolute -top-px left-5 right-5 z-10 flex items-center">
                  <span className="h-1.5 w-1.5 -ml-5 shrink-0 rounded-full bg-accent-500" />
                  <span className="h-0.5 flex-1 rounded-full bg-accent-500 shadow-[0_0_6px_var(--color-accent-500)]" />
                </div>
              )}
              <button
                type="button"
                aria-label={tSettings('navigation.reorder', { item: t(item.labelKey) })}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp') { e.preventDefault(); moveItem(item.id, -1); }
                  if (e.key === 'ArrowDown') { e.preventDefault(); moveItem(item.id, 1); }
                }}
                className={`shrink-0 p-1 rounded cursor-grab active:cursor-grabbing touch-none ${
                  isDark ? 'text-slate-600 hover:text-slate-400' : 'text-slate-300 hover:text-slate-500'
                }`}
              >
                <GripVertical className="w-4 h-4" />
              </button>
              <div className="min-w-0 flex items-center gap-2">
                <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                  {NAV_ITEM_ICONS[item.id]}
                </span>
                <span className={`text-[13px] font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {t(item.labelKey)}
                </span>
                {locked && (
                  <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full ${
                    isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'
                  }`}>
                    <Lock className="w-2.5 h-2.5" />
                    {tSettings('navigation.alwaysOn')}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex items-center justify-start md:justify-end">
                <Toggle checked={isVisible(item.id)} onChange={() => toggle(item.id)} disabled={locked} />
              </div>
            </div>
          );
        })}
      </Sec>

      {/* Units */}
      <Sec
        title={tSettings('units.title')}
        description={tSettings('units.description')}
        isDark={isDark}
      >
        <Row label={tSettings('units.temperature.label')} description={tSettings('units.temperature.description')} isDark={isDark}>
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
        <Row label={tSettings('units.windSpeed.label')} description={tSettings('units.windSpeed.description')} isDark={isDark}>
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
