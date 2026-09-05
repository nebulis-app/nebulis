import { TemporaryFilesSection } from './TemporaryFilesSection';

export function StorageCleanupSection({ isDark }: { isDark: boolean }) {
  return <TemporaryFilesSection isDark={isDark} />;
}
