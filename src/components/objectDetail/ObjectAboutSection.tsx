/**
 * The catalog write-up for an object, tucked behind a toggle at the foot of the
 * page. It is reference material: you read it once, then come back for the
 * pictures and the nights. The numbers people check often (magnitude,
 * distance, size) and tonight's visibility live in the hero instead.
 */
import { forwardRef, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import { ObjectPanel } from '../observationDetail/ObjectPanel';
import { useTheme } from '../../hooks/useTheme';

type Props = ComponentProps<typeof ObjectPanel> & {
  /** Owned by the page, so the banner's "More" link can open this section. */
  open: boolean;
  onToggle: () => void;
};

export const ObjectAboutSection = forwardRef<HTMLDivElement, Props>(function ObjectAboutSection(
  { open, onToggle, ...panelProps },
  ref,
) {
  const { isDark, isNight, isSpace } = useTheme();
  const { t } = useTranslation('observations');
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    // The button's inset matches the Integration card above (1px border + 16px
    // padding), so the two chevrons and icons line up down the page.
    <div ref={ref} className="scroll-mt-6">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 rounded-xl px-[17px] py-2 text-left transition ${
          isDark ? 'hover:bg-slate-900' : 'hover:bg-slate-100'
        }`}
      >
        <Chevron className={`h-4 w-4 shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
        <Info className={`h-4 w-4 shrink-0 ${accentText}`} />
        <span className={`font-display text-[0.9375rem] font-semibold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
          {t('observationDetail.objectPanel.about', { name: panelProps.displayName })}
        </span>
      </button>
      {open && <div className="mt-2"><ObjectPanel {...panelProps} hideHeader /></div>}
    </div>
  );
});
