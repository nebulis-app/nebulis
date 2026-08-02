import { MapPin, X } from 'lucide-react';
import { SiteManagerList } from './settings/SiteManagerList';
import { Modal } from './ui/Modal';

/**
 * Full location manager, reachable from the Planner/Forecast site picker
 * ("Manage locations...") without a detour through Settings. Same
 * SiteManagerList component Settings → Observing Sites renders inline, so
 * add/edit/delete/set-default/set-visible-sky behave identically everywhere.
 */
export function SiteManagerModal({ isDark, onClose }: { isDark: boolean; onClose: () => void }) {
  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Manage Locations"
      className={`w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl border shadow-2xl ${
        isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
      }`}
    >
      <div className={`flex items-center justify-between p-5 border-b shrink-0 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDark ? 'bg-teal-500/10' : 'bg-teal-50'}`}>
            <MapPin className="w-4 h-4 text-teal-500" />
          </div>
          <h3 className={`font-display font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
            Manage Locations
          </h3>
        </div>
        <button
          onClick={onClose}
          className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="p-5 overflow-y-auto">
        <SiteManagerList isDark={isDark} />
      </div>
    </Modal>
  );
}
