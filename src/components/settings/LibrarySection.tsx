import type { Settings as SettingsType } from '../../types';
import { Sec, Row, Toggle } from './SettingsUI';
import { Telescope, Globe } from 'lucide-react';

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

export function LibrarySection({
  isDark,
  form,
  setForm,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
}) {
  const imageSource = form.galleryImageSource ?? 'sky-survey';

  return (
    <>
      <Sec
        title="Display"
        description="How object cards and slideshow show images and information."
        isDark={isDark}
      >
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
        <Row
          label="Gallery: Show processed images only"
          description='Gallery opens with the "Processed only" filter on by default.'
          isDark={isDark}
        >
          <Toggle
            checked={form.galleryProcessedOnlyDefault ?? false}
            onChange={v => setForm(f => ({ ...f, galleryProcessedOnlyDefault: v }))}
          />
        </Row>
        <Row
          label="Slideshow: Show object information"
          description="Shows the name, type, and distance while images play."
          isDark={isDark}
        >
          <Toggle
            checked={form.planetariumShowInfo ?? true}
            onChange={v => setForm(f => ({ ...f, planetariumShowInfo: v }))}
          />
        </Row>
        <Row
          label="Slideshow: Start with processed images only"
          description="Slideshow opens with only processed images; switch anytime."
          isDark={isDark}
        >
          <Toggle
            checked={form.planetariumProcessedOnlyDefault ?? false}
            onChange={v => setForm(f => ({ ...f, planetariumProcessedOnlyDefault: v }))}
          />
        </Row>
      </Sec>

      <Sec title="Image behavior" isDark={isDark}>
        <Row
          label="Rotate images 90° counter-clockwise"
          description="Corrects telescopes that capture rotated, slideshow included."
          isDark={isDark}
        >
          <Toggle
            checked={form.slideshowRotateCCW ?? false}
            onChange={v => setForm(f => ({ ...f, slideshowRotateCCW: v }))}
          />
        </Row>
      </Sec>

      <Sec title="Organization" isDark={isDark}>
        <Row
          label="Prefer Caldwell numbers"
          description={'New objects are named "C5" instead of "IC342." Existing folders are unchanged.'}
          isDark={isDark}
        >
          {/* A 2-value enum rendered as a toggle. If PREFERRED_CATALOGS in
             server/lib/types/appSettings.ts ever grows a third value, this
             must become a select — as-is, saving from here would silently
             overwrite that third value back to 'default'. */}
          <Toggle
            checked={(form.preferredCatalog ?? 'default') === 'caldwell'}
            onChange={v => setForm(f => ({ ...f, preferredCatalog: v ? 'caldwell' : 'default' }))}
          />
        </Row>
        <Row
          label="Group by observing night"
          description="An 11pm–1am session counts as one night, not two calendar dates."
          isDark={isDark}
        >
          <Toggle
            checked={form.groupObservingNights ?? true}
            onChange={v => setForm(f => ({ ...f, groupObservingNights: v }))}
          />
        </Row>
      </Sec>
    </>
  );
}
