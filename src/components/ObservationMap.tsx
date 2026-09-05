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

    // Esri's Canvas Gray Base tiles: free, no API key, no rate-limit signup.
    // (CARTO's old basemaps.cartocdn.com CDN now requires a paid API key and
    // serves a watermarked "API KEY REQUIRED" tile without one.) The base
    // layer's native tiles stop at zoom 16; maxNativeZoom lets Leaflet
    // upscale those tiles for deeper zoom instead of showing blank squares.
    const tileUrl = isDark
      ? 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
      : 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';

    L.tileLayer(tileUrl, {
      attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, DeLorme, NAVTEQ',
      maxZoom: 19,
      maxNativeZoom: 16,
    }).addTo(map);

    // Esri ships place/road labels as a separate transparent-PNG layer on
    // top of the gray base — without this the map has no city names on it.
    const referenceUrl = isDark
      ? 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
      : 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}';

    // No pane override needed: Leaflet stacks tile layers within the shared
    // tilePane in insertion order, so adding this after the base layer is
    // enough to put labels on top of it.
    L.tileLayer(referenceUrl, {
      maxZoom: 19,
      maxNativeZoom: 16,
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
