import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface ObservationMapProps {
  lat: number;
  lon: number;
  isDark: boolean;
}

export function ObservationMap({ lat, lon, isDark }: ObservationMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;

    // Clean up previous instance
    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    const map = L.map(mapRef.current, {
      center: [lat, lon],
      zoom: 10,
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,
    });

    const tileUrl = isDark
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

    L.tileLayer(tileUrl, {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    // Custom marker icon
    const icon = L.divIcon({
      className: 'custom-marker',
      html: `<div style="
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: ${isDark ? '#6366f1' : '#4f46e5'};
        border: 3px solid white;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      "></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    L.marker([lat, lon], { icon })
      .addTo(map)
      .bindPopup(`
        <div style="font-size: 12px; font-family: system-ui;">
          <strong>Observation Site</strong><br/>
          ${lat.toFixed(2)}°, ${lon.toFixed(2)}°
        </div>
      `);

    mapInstanceRef.current = map;

    // Force resize after render
    const resizeTimer = setTimeout(() => map.invalidateSize(), 100);

    return () => {
      clearTimeout(resizeTimer);
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [lat, lon, isDark]);

  return (
    <div className="relative w-full h-full" style={{ isolation: 'isolate', zIndex: 0 }}>
      <div ref={mapRef} className="w-full h-full" style={{ zIndex: 0 }} />
    </div>
  );
}
