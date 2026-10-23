import {
  Compass,
  ScanSearch,
  Activity,
  LayoutDashboard,
  Images,
  Hourglass,
  Sparkles,
  Grid3x3,
  Package,
} from 'lucide-react';
import { WhatsNewReel, type ReelConfig, type WhatsNewReelProps } from './WhatsNewReel';

const CONFIG: ReelConfig = {
  ns: 'whatsNewV22',
  dir: 'v2-2',
  features: [
    { icon: Compass, key: 'explore', screenshot: 'explore.webp' },
    { icon: ScanSearch, key: 'annotate', screenshot: 'annotate.webp' },
    { icon: Activity, key: 'frameQuality', screenshot: 'frame-quality.webp' },
    { icon: LayoutDashboard, key: 'myCatalog', screenshot: 'my-catalog.webp' },
    { icon: Images, key: 'myMedia', screenshot: 'my-media.webp' },
    { icon: Hourglass, key: 'integration', screenshot: 'integration.webp' },
    { icon: Sparkles, key: 'planMyNight', screenshot: 'plan-my-night.webp' },
    { icon: Grid3x3, key: 'mosaic', screenshot: 'mosaic.webp' },
    { icon: Package, key: 'exportStacking', screenshot: 'export-stacking.webp' },
  ],
};

/** The 2.2 release reel. */
export function WhatsNewV22Modal(props: WhatsNewReelProps) {
  return <WhatsNewReel config={CONFIG} {...props} />;
}
