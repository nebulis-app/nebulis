import {
  Settings,
  User,
  Cpu,
  Compass,
  HardDrive,
  AlertTriangle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface SettingsTabItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
  adminOnly?: boolean;
}

/** Consolidated 6-section grouping. Order is reading order in the tab strip. */
export const SETTINGS_TABS: SettingsTabItem[] = [
  { id: 'general',  label: 'General',  icon: Settings },
  { id: 'account',  label: 'Account',  icon: User, adminOnly: true },
  { id: 'hardware', label: 'Hardware', icon: Cpu, adminOnly: true },
  { id: 'sky',      label: 'Sky',      icon: Compass, adminOnly: true },
  { id: 'storage',  label: 'Storage',  icon: HardDrive, adminOnly: true },
  { id: 'danger',   label: 'Danger',   icon: AlertTriangle, danger: true, adminOnly: true },
];

export function SettingsTabs({
  activeId,
  onNavigate,
  isDark,
  isAdmin = true,
}: {
  activeId: string;
  onNavigate: (id: string) => void;
  isDark: boolean;
  isAdmin?: boolean;
}) {
  const visible = SETTINGS_TABS.filter(t => !t.adminOnly || isAdmin);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [underline, setUnderline] = useState<{ left: number; width: number } | null>(null);

  // Position the active underline. Re-measures on resize so it stays correct.
  useEffect(() => {
    function measure() {
      const el = refs.current[activeId];
      if (!el) return setUnderline(null);
      setUnderline({ left: el.offsetLeft, width: el.offsetWidth });
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [activeId, visible.length]);

  return (
    <div
      className={`sticky top-16 z-30 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 backdrop-blur-xl border-b ${
        isDark ? 'bg-slate-950/85 border-slate-800' : 'bg-white/85 border-slate-200'
      }`}
    >
      <div className="max-w-[1800px] mx-auto">
        <div className="relative flex items-center justify-center gap-1 h-12 overflow-x-auto">
          {visible.map(tab => {
            const Icon = tab.icon;
            const isActive = tab.id === activeId;
            const isDanger = tab.danger;
            return (
              <button
                key={tab.id}
                ref={el => { refs.current[tab.id] = el; }}
                onClick={() => onNavigate(tab.id)}
                className={`relative flex items-center gap-2 px-4 h-full text-[13px] font-medium whitespace-nowrap transition-colors ${
                  isActive
                    ? isDanger
                      ? isDark ? 'text-red-400' : 'text-red-600'
                      : isDark ? 'text-accent-400' : 'text-accent-600'
                    : isDanger
                      ? isDark ? 'text-slate-500 hover:text-red-400' : 'text-slate-400 hover:text-red-600'
                      : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
          {underline && (
            <span
              aria-hidden
              className={`absolute bottom-0 h-[2px] rounded-full transition-all duration-200 ease-out ${
                visible.find(t => t.id === activeId)?.danger
                  ? 'bg-red-500'
                  : 'bg-accent-500'
              }`}
              style={{ left: underline.left, width: underline.width }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
