import { StorageDashboard } from '../StorageDashboard';
import { LibraryLocationSection } from './LibraryLocationSection';
import { ReorganizeLibrarySection } from './ReorganizeLibrarySection';

export function StorageGroupSection({ isDark }: { isDark: boolean }) {
  return (
    <div className="space-y-10">
      <LibraryLocationSection isDark={isDark} />
      <ReorganizeLibrarySection isDark={isDark} />
      <StorageDashboard embedded />
    </div>
  );
}
