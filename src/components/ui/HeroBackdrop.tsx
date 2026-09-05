/**
 * Deep-sky artwork behind a page banner.
 *
 * The banners were flat panels with a gradient bloom, which left the right half
 * of a wide screen doing nothing. This fills it with a real picture and then
 * spends most of its effort making sure the picture never costs legibility:
 *
 *   - The image is full-bleed and `object-cover`, but a horizontal scrim runs
 *     opaque at the left and thins out to the right, so the picture reads as
 *     living on the right while text sits on flat panel colour. No width maths,
 *     nothing to keep in step with the content column.
 *   - Narrow screens get a near-flat scrim instead of the gradient, because
 *     there is no empty right side there: the text spans the whole panel, so
 *     the image has to sit right under it and must be much quieter.
 *   - Night mode drops it almost to nothing. `.night img` already dims every
 *     image for dark adaptation, and a bright nebula behind text is exactly
 *     what that rule exists to prevent, so this leans further the same way.
 *
 * Sits inside the banner's own `relative overflow-hidden` box and paints
 * nothing but background: it is `aria-hidden` and never takes pointer events.
 */
import { useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import type { HeroImage } from '../../lib/heroImagery';

interface Props {
  image: HeroImage;
  /**
   * Peak opacity of the artwork on a wide screen. The default suits a banner
   * whose right side is empty; a banner that puts content over the picture
   * (a chart, a dial) should pass something lower.
   */
  intensity?: number;
  /** Matches the banner's own corner radius so the scrim cannot square it off. */
  rounded?: string;
}

export function HeroBackdrop({ image, intensity = 0.75, rounded = 'rounded-3xl' }: Props) {
  const { isNight } = useTheme();
  const [loaded, setLoaded] = useState(false);

  // Night mode is for keeping dark adaptation. The picture is decoration, so it
  // is the first thing to give way.
  const peak = isNight ? Math.min(intensity, 0.12) : intensity;

  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${rounded}`} aria-hidden="true">
      <img
        src={image.src}
        alt=""
        decoding="async"
        // Decorative and below the fold's real content in importance: it must
        // never compete with the page's data for bandwidth on a slow LAN.
        fetchPriority="low"
        onLoad={() => setLoaded(true)}
        className="absolute inset-0 h-full w-full object-cover transition-opacity duration-1000 ease-out"
        style={{ opacity: loaded ? peak : 0 }}
      />

      {/* Narrow: the text covers the whole panel, so the picture stays a texture. */}
      <div className="absolute inset-0 bg-slate-950/82 lg:hidden" />

      {/* Wide: opaque under the text, clearing towards the empty right side.
          These three scrims multiply, so each is lighter than it looks: pushing
          any one of them up turns the artwork into a brown smear. */}
      <div className="absolute inset-0 hidden bg-gradient-to-r from-slate-950 from-12% via-slate-950/72 via-45% to-slate-950/10 lg:block" />

      {/* Settles the top and bottom edges so the crop never ends on a hard line. */}
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950/70 via-transparent to-slate-950/30" />
    </div>
  );
}
