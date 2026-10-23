import {
  Library,
  CalendarRange,
  CloudMoon,
  Compass,
  BookOpen,
  ScrollText,
  Telescope,
  RefreshCw,
  DatabaseBackup,
} from 'lucide-react';
import { WhatsNewReel, type ReelConfig, type WhatsNewReelProps } from './WhatsNewReel';

const CONFIG: ReelConfig = {
  ns: 'whatsNewV20',
  dir: 'v2-0',
  features: [
    { icon: CalendarRange, key: 'planner', screenshot: 'planner.webp' },
    { icon: CloudMoon, key: 'forecast', screenshot: 'forecast.webp' },
    { icon: Library, key: 'catalogs', screenshot: 'catalogs.webp' },
    { icon: Telescope, key: 'observations', screenshot: 'observations.webp' },
    { icon: Compass, key: 'guidedTour', screenshot: 'guided-tour.webp' },
    { icon: BookOpen, key: 'helpPage', screenshot: 'help-page.webp' },
    { icon: ScrollText, key: 'systemLog', screenshot: 'system-log.webp' },
    { icon: RefreshCw, key: 'backupStatus', screenshot: 'backup-status.webp' },
    { icon: DatabaseBackup, key: 'databaseBackup', screenshot: 'database-backup.webp' },
  ],
};

/** The 2.0 release reel. */
export function WhatsNewV20Modal(props: WhatsNewReelProps) {
  return <WhatsNewReel config={CONFIG} {...props} />;
}
