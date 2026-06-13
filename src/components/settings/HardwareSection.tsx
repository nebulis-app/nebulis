import { ConnectionSection } from './ConnectionSection';
import { ConnectedDevicesSection } from './ConnectedDevicesSection';

export function HardwareSection({ isDark }: { isDark: boolean }) {
  return (
    <div className="space-y-10">
      <ConnectionSection isDark={isDark} />
      <ConnectedDevicesSection isDark={isDark} />
    </div>
  );
}
