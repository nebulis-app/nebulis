import { LibraryLocationSection } from './LibraryLocationSection';
import { StorageDashboard } from '../StorageDashboard';

export function StorageLocationSection({ isDark }: { isDark: boolean }) {
  // No wrapping space-y: every Sec (SettingsUI.tsx) already carries its own
  // `mt-10 first:mt-0`, the same convention General/Library/Sky rely on.
  return (
    <>
      <LibraryLocationSection isDark={isDark} />
      <StorageDashboard embedded />
    </>
  );
}
