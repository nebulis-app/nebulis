/**
 * Where the session was shot from: the site it is tagged to, and that spot on
 * a map.
 *
 * The picker sits above the map rather than in a card of its own, which is what
 * used to put the site name on the page twice. The map is deliberately last:
 * it confirms the answer the picker already gave, so it should not be the first
 * thing the eye lands on.
 */
import { MapPin } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { ObservationMap } from '../ObservationMap';
import { ObservedFromControl } from './ObservedFromPanel';
import { PanelEmpty, SessionPanel } from '../ui/Panel';

export function SitePanel({
  objectId,
  date,
  siteId,
  coordinates,
  fileCoordinates,
  /** Reverse-geocoded place name, once it resolves. */
  locationName,
  isAdmin,
}: {
  objectId: string;
  date: string;
  siteId: string | null;
  coordinates: { lat: number; lon: number } | null | undefined;
  fileCoordinates: { lat: number; lon: number } | null | undefined;
  locationName: string | null;
  isAdmin: boolean;
}) {
  const { isDark } = useTheme();

  return (
    <SessionPanel
      title="Observed from"
      icon={MapPin}
      // Leaflet paints its panes at a z-index that will sit over anything later
      // in the document unless the card gets its own stacking context.
      className="relative isolate z-0"
    >
      <ObservedFromControl
        objectId={objectId}
        date={date}
        siteId={siteId}
        fileCoordinates={fileCoordinates}
        isAdmin={isAdmin}
      />

      {coordinates ? (
        <>
          {/* Grows into whatever height the tallest panel in the row sets,
              rather than leaving this card two thirds empty beside it. */}
          <div className="mt-4 min-h-[168px] flex-1 overflow-hidden rounded-xl">
            <ObservationMap lat={coordinates.lat} lon={coordinates.lon} isDark={isDark} />
          </div>
          <div className={`mt-2.5 flex items-center justify-between gap-3 text-[12.5px] ${
            isDark ? 'text-slate-400' : 'text-slate-500'
          }`}>
            <span className={`truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {locationName || 'Coordinates'}
            </span>
            <span className="shrink-0 font-medium tabular-nums">
              {coordinates.lat.toFixed(2)}°, {coordinates.lon.toFixed(2)}°
            </span>
          </div>
        </>
      ) : (
        <div className="mt-3">
          <PanelEmpty>
            No location recorded. The capture files carried no coordinates and this session is not
            tagged to a site.
          </PanelEmpty>
        </div>
      )}
    </SessionPanel>
  );
}
