import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { ObservingSite } from '../../lib/api/sites';

/**
 * Small overview map of the observing sites: one dot per site that has
 * coordinates, the default one in the accent colour. Hovering or clicking a
 * dot selects the matching list row (and vice versa), so the map and list
 * read as one control. Tiles are the same Esri gray set the Observations map
 * uses.
 */
export function SitesMap({
  sites,
  selectedId,
  onSelect,
  isDark,
}: {
  sites: ObservingSite[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  isDark: boolean;
}) {
  const { t } = useTranslation('settings');
  const containerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<Map<string, L.CircleMarker>>(new Map());
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  const located = sites.filter(s => s.latitude != null && s.longitude != null);
  const locatedKey = located.map(s => `${s.id}:${s.latitude}:${s.longitude}:${s.isDefault}`).join('|');

  useEffect(() => {
    const el = containerRef.current;
    if (!el || located.length === 0) return;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent-500').trim() || '#f59e0b';
    const map = L.map(el, { zoomControl: false, attributionControl: false, scrollWheelZoom: false });
    const variant = isDark ? 'Dark' : 'Light';
    for (const layer of [`World_${variant}_Gray_Base`, `World_${variant}_Gray_Reference`]) {
      L.tileLayer(`https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/${layer}/MapServer/tile/{z}/{y}/{x}`, {
        maxZoom: 19,
        maxNativeZoom: 16,
      }).addTo(map);
    }
    L.control.attribution({ prefix: false }).addAttribution('Tiles &copy; Esri').addTo(map);

    const markers = markersRef.current;
    markers.clear();
    const points: L.LatLngTuple[] = [];
    for (const site of located) {
      const point: L.LatLngTuple = [site.latitude as number, site.longitude as number];
      points.push(point);
      const marker = L.circleMarker(point, {
        radius: site.isDefault ? 8 : 6,
        color: site.isDefault ? accent : '#94a3b8',
        fillColor: site.isDefault ? accent : '#94a3b8',
        fillOpacity: 0.85,
        weight: 2,
      }).addTo(map);
      marker.bindTooltip(site.name, { direction: 'top' });
      marker.on('mouseover', () => onSelectRef.current(site.id));
      marker.on('mouseout', () => onSelectRef.current(null));
      marker.on('click', () => onSelectRef.current(site.id));
      markers.set(site.id, marker);
    }
    if (points.length === 1) map.setView(points[0], 6);
    else map.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 8 });

    return () => { markers.clear(); map.remove(); };
    // locatedKey covers every field the map reads from `located`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locatedKey, isDark]);

  useEffect(() => {
    markersRef.current.forEach((marker, id) => {
      const active = id === selectedId;
      marker.setStyle({ weight: active ? 4 : 2, fillOpacity: active ? 1 : 0.85 });
      if (active) marker.bringToFront();
    });
  }, [selectedId, locatedKey]);

  if (located.length === 0) return null;
  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={t('siteManager.mapAria')}
      className={`mb-3 h-56 w-full overflow-hidden rounded-xl border sm:h-64 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}
    />
  );
}
