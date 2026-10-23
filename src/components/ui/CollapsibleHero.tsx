/**
 * The shared shell for a page's hero banner, with a slim collapsed form.
 *
 * Every banner used to repeat the same dark panel, artwork, two accent blooms
 * and inner ring. This owns that chrome once and adds the fold the Planner's
 * night hero introduced: a chevron in the corner collapses the banner to one
 * row (icon, title, a one-line summary, the page's action, the chevron) so the
 * content underneath gets the room. The choice is remembered per page.
 *
 * Dark in every theme, like the banners it wraps, so text here is white and
 * the accent arrives as a hex rather than an `accent-*` utility.
 *
 * The artwork sits in its own clipped layer rather than clipping the section,
 * so a banner can hang a dropdown below itself (Explore's search results).
 */
import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { HeroBackdrop } from './HeroBackdrop';
import { useCollapsedHero } from '../../hooks/useCollapsedHero';
import type { HeroImage } from '../../lib/heroImagery';

interface Props {
  /** Short page name, the key the collapsed state is remembered under. */
  page: string;
  image: HeroImage;
  /** Artwork strength when expanded; the collapsed bar always runs lower. */
  intensity?: number;
  accent: string;
  /** The page icon, already coloured and sized for the expanded title. */
  icon: ReactNode;
  title: ReactNode;
  /** One line of the banner's headline facts, shown beside the title when collapsed. */
  summary?: ReactNode;
  /** Replaces the summary with a live control that must stay reachable while
   *  collapsed (Explore's search box). It is not clipped, so it can hang a dropdown. */
  collapsedBody?: ReactNode;
  /** The banner's own action(s). Rendered by the caller inside the expanded
   *  layout as well, so this is only the copy that rides in the slim bar. */
  actions?: ReactNode;
  /** Layout classes for the expanded content box (flex direction, gaps...). The
   *  shell adds the padding that keeps content clear of the chevron. */
  contentClassName: string;
  /** Colour of the top-left bloom when it should track something other than the
   *  accent, such as a rating. */
  bloom?: string;
  /** The second bloom, bottom-right. Banners with content over that corner omit it. */
  bottomBloom?: boolean;
  className?: string;
  /** Expanded content. */
  children: ReactNode;
}

export function CollapsibleHero({
  page, image, intensity, accent, bloom, icon, title, summary, collapsedBody, actions,
  contentClassName, bottomBloom = true, className = '', children,
}: Props) {
  const { t } = useTranslation('common');
  const [collapsed, setCollapsed] = useCollapsedHero(page);
  const label = collapsed ? t('heroToggle.expand') : t('heroToggle.collapse');

  const toggle = (
    <button
      type="button"
      onClick={() => setCollapsed(!collapsed)}
      aria-expanded={!collapsed}
      aria-label={label}
      title={label}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/50 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
    >
      {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
    </button>
  );

  const rounded = collapsed ? 'rounded-2xl' : 'rounded-3xl';

  return (
    <section className={`relative ${rounded} bg-slate-950 hero-panel ${className}`}>
      <div className={`absolute inset-0 overflow-hidden ${rounded}`}>
        <HeroBackdrop
          image={image}
          intensity={collapsed ? Math.min(intensity ?? 0.75, 0.2) : intensity}
          rounded={rounded}
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{ background: `radial-gradient(90% 140% at 8% 0%, ${bloom ?? accent}1f 0%, transparent 60%)` }}
        />
        {bottomBloom && !collapsed && (
          <div
            className="pointer-events-none absolute inset-0 opacity-50"
            style={{ background: `radial-gradient(70% 130% at 95% 100%, ${accent}14 0%, transparent 62%)` }}
          />
        )}
        <div
          className={`pointer-events-none absolute inset-0 ${rounded}`}
          style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }}
        />
      </div>

      {collapsed ? (
        <div className="relative flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 sm:px-5">
          <h1 className="font-display flex shrink-0 items-center gap-2 text-lg font-bold tracking-tight text-white [&>svg]:h-4 [&>svg]:w-4">
            {icon}
            {title}
          </h1>
          {collapsedBody ? (
            <div className="min-w-0 flex-1 basis-64">{collapsedBody}</div>
          ) : summary && (
            <p className="hidden min-w-0 flex-1 truncate text-[0.8125rem] text-white/55 tabular-nums sm:block">{summary}</p>
          )}
          <div className="ml-auto flex items-center gap-2">
            {actions}
            {toggle}
          </div>
        </div>
      ) : (
        <>
          <div className={`relative ${contentClassName} pr-12 sm:pr-14`}>{children}</div>
          <div className="absolute right-3 top-3 z-10">{toggle}</div>
        </>
      )}
    </section>
  );
}

/** The collapsed bar's headline facts: the same figures the expanded stat row
 *  shows, run together on one line as "108 Sessions | 53 Objects". A thin rule
 *  divides them, because a dot vanished between figures like "3 GB Library Size". */
export function HeroSummary({ stats }: { stats: { value: string; label: string }[] }) {
  return (
    <>
      {stats.map(({ value, label }, i) => (
        <span key={label}>
          {i > 0 && (
            <span aria-hidden="true" className="mx-2.5 inline-block h-3.5 w-px translate-y-[2px] bg-white/20" />
          )}
          <span className="font-semibold text-white">{value}</span>{' '}
          <span className="text-white/50">{label}</span>
        </span>
      ))}
    </>
  );
}
