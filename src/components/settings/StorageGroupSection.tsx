import { StorageDashboard } from '../StorageDashboard';
import { LibraryLocationSection } from './LibraryLocationSection';

export function StorageGroupSection({ isDark }: { isDark: boolean }) {
  return (
    <div className="space-y-10">
      <LibraryLocationSection isDark={isDark} />
      <StorageDashboard embedded />
    </div>
  );
}
