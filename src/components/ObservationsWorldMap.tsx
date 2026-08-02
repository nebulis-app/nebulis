import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { ObservationLocation } from '../lib/api/observations';
import type { TelescopeProfile } from '../lib/api/telescopes';
import { cleanCatalogId, formatObjectName } from '../lib/utils';

interface ObservationsWorldMapProps {
  locations: ObservationLocation[];
  telescopeById: Map<string, TelescopeProfile>;
  showTelescopeUI: boolean;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
}

export interface ObservationsWorldMapHandle {
  /**
   * Rasterizes exactly what's currently on screen — tiles and site markers —
   * to a canvas, for the "share the map" flow. Kept inside this component
   * rather than handing the container node to the caller: whoever captures
   * the map also needs to know the tile CORS story and the marker geometry
   * below, and that's this component's problem, not the page's.
   */
  captureImage(): Promise<HTMLCanvasElement>;
}

/** A group of observations that share (roughly) the same location. */
interface Site {
  key: string;
  lat: number;
  lon: number;
  observations: ObservationLocation[];
  approximate: boolean;
}

// Round to ~1.1 km so one backyard collapses to a single marker while distinct
// dark-sky sites stay separate.
const siteKey = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

interface SiteStyle {
  size: number;
  color: string;
}

/**
 * Diameter and color for one site's marker. Shared between the live divIcon
 * markers and the canvas capture below — one source of truth for what a
 * marker looks like, so the exported image can never drift from the map as
 * actually displayed.
 */
function computeSiteStyle(
  site: Site,
  maxCount: number,
  accent: string,
  telescopeById: Map<string, TelescopeProfile>,
  showTelescopeUI: boolean,
): SiteStyle {
  const count = site.observations.length;
  // Marker diameter scales with observation count (sqrt keeps large sites
  // from dwarfing small ones), clamped to a comfortable range.
  const size = Math.round(22 + 20 * Math.sqrt(count / maxCount));

  // Colour by telescope when every observation at the site is from the same
  // scope; otherwise use the brand accent.
  const scopeIds = new Set(site.observations.map(o => o.telescopeId ?? ''));
  const singleScope = showTelescopeUI && scopeIds.size === 1 ? [...scopeIds][0] : '';
  const scopeColor = singleScope ? telescopeById.get(singleScope)?.color : undefined;
  return { size, color: scopeColor || accent };
}

/**
 * Best-effort wait for in-flight tiles to finish loading before a capture.
 * Leaflet keeps a buffer ring of tiles loading around the viewport during and
 * just after a pan/zoom; capturing mid-load would bake permanent gaps into
 * the exported image. Resolves once nothing is pending, or after `timeoutMs`
 * regardless — a slightly stale tile is a smaller problem than a capture that
 * never completes because one tile request stalled.
 */
function waitForTilesSettled(container: HTMLElement, timeoutMs = 1200): Promise<void> {
  return new Promise(resolve => {
    const start = performance.now();
    const check = () => {
      const pending = container.querySelectorAll('.leaflet-tile-pane img:not(.leaflet-tile-loaded)').length;
      if (pending === 0 || performance.now() - start > timeoutMs) {
        resolve();
        return;
      }
      setTimeout(check, 80);
    };
    check();
  });
}

export const ObservationsWorldMap = forwardRef<ObservationsWorldMapHandle, ObservationsWorldMapProps>(
  function ObservationsWorldMap({
  locations,
  telescopeById,
  showTelescopeUI,
  isDark,
  isNight,
  isSpace,
}, captureRef) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);

  const accent = isNight ? '#ef4444' : isSpace ? '#8b5cf6' : '#f59e0b';

  // Cluster observations into sites, newest observation first within each site.
  const sites = useMemo<Site[]>(() => {
    const byKey = new Map<string, Site>();
    for (const loc of locations) {
      const key = siteKey(loc.lat, loc.lon);
      let site = byKey.get(key);
      if (!site) {
        site = { key, lat: loc.lat, lon: loc.lon, observations: [], approximate: true };
        byKey.set(key, site);
      }
      site.observations.push(loc);
      if (loc.source === 'fits') site.approximate = false;
    }
    for (const site of byKey.values()) {
      site.observations.sort((a, b) => b.date.localeCompare(a.date));
    }
    return [...byKey.values()];
  }, [locations]);

  useEffect(() => {
    if (!mapRef.current) return;

    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    const map = L.map(mapRef.current, {
      center: [20, 0],
      zoom: 2,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
      minZoom: 1,
    });

    const tileUrl = isDark
      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
    L.tileLayer(tileUrl, {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
      // CARTO's basemap CDN sends CORS headers permitting this; without it,
      // the tile <img>s taint the canvas the moment "share the map" tries to
      // read them back, and the export silently comes out blank.
      crossOrigin: true,
    }).addTo(map);

    const maxCount = sites.reduce((m, s) => Math.max(m, s.observations.length), 1);

    for (const site of sites) {
      const count = site.observations.length;
      const { size, color } = computeSiteStyle(site, maxCount, accent, telescopeById, showTelescopeUI);

      const icon = L.divIcon({
        className: 'nebulis-site-marker',
        html: `<div style="
          width:${size}px;height:${size}px;border-radius:50%;
          display:flex;align-items:center;justify-content:center;
          background:${color}cc;border:2px solid ${isDark ? '#0f172a' : '#ffffff'};
          box-shadow:0 0 0 2px ${color}66, 0 2px 10px rgba(0,0,0,0.45);
          color:#fff;font:600 ${Math.max(11, Math.min(15, size / 3))}px system-ui;
          ${site.approximate ? 'opacity:0.85;border-style:dashed;' : ''}
        ">${count}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      const shown = site.observations.slice(0, 12);
      const rows = shown.map(o => {
        const name = formatObjectName(cleanCatalogId(o.objectId), cleanCatalogId(o.objectName));
        return `<a class="nebulis-obs-link" href="#" data-obj="${escapeHtml(o.objectId)}" data-date="${escapeHtml(o.date)}"
          style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;text-decoration:none;color:inherit;">
          <span style="font-weight:600;">${escapeHtml(name)}</span>
          <span style="opacity:0.6;">${escapeHtml(o.date)}</span>
        </a>`;
      }).join('');
      const more = count > shown.length ? `<div style="opacity:0.6;padding-top:4px;">+${count - shown.length} more</div>` : '';

      L.marker([site.lat, site.lon], { icon })
        .addTo(map)
        .bindPopup(
          `<div style="font:12px system-ui;min-width:200px;max-width:260px;">
             <div style="font-weight:700;margin-bottom:2px;">${count} observation${count === 1 ? '' : 's'}</div>
             <div style="opacity:0.6;margin-bottom:6px;">${site.lat.toFixed(3)}°, ${site.lon.toFixed(3)}°${site.approximate ? ' · approximate' : ''}</div>
             <div style="max-height:180px;overflow-y:auto;">${rows}${more}</div>
           </div>`,
          { maxWidth: 300 },
        );
    }

    // Frame all sites. A single site would otherwise zoom to street level.
    if (sites.length > 0) {
      const bounds = L.latLngBounds(sites.map(s => [s.lat, s.lon] as [number, number]));
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: sites.length === 1 ? 9 : 12 });
    }

    // Keep popup links inside the SPA instead of triggering a full reload.
    map.on('popupopen', (e: L.PopupEvent) => {
      const el = e.popup.getElement();
      if (!el) return;
      el.querySelectorAll<HTMLAnchorElement>('.nebulis-obs-link').forEach(link => {
        link.addEventListener('click', ev => {
          ev.preventDefault();
          const obj = link.getAttribute('data-obj');
          const date = link.getAttribute('data-date');
          if (obj && date) {
            navigateRef.current(`/observations/${encodeURIComponent(obj)}/${encodeURIComponent(date)}`);
          }
        });
      });
    });

    mapInstanceRef.current = map;
    const resizeTimer = setTimeout(() => map.invalidateSize(), 100);

    return () => {
      clearTimeout(resizeTimer);
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [sites, telescopeById, showTelescopeUI, isDark, accent]);

  useImperativeHandle(captureRef, () => ({
    captureImage: async () => {
      const container = mapRef.current;
      const mapInst = mapInstanceRef.current;
      if (!container || !mapInst) throw new Error('Map is not mounted');

      // A generic DOM-to-canvas library (html2canvas) was tried here first and
      // rejected: it reimplements CSS layout rather than using the browser's
      // real engine, and its flexbox + border-radius handling is unreliable —
      // the site markers came out as off-center ovals instead of circles with
      // centered numbers. Compositing tiles and markers by hand sidesteps that
      // entirely: canvas arc()/textAlign are exact, not approximated.
      mapInst.closePopup();
      await waitForTilesSettled(container);

      const rect = container.getBoundingClientRect();
      const scale = Math.min(2, window.devicePixelRatio || 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(rect.width * scale));
      canvas.height = Math.max(1, Math.round(rect.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas is not supported');
      ctx.scale(scale, scale);

      const bg = isDark ? '#0f172a' : '#ffffff';
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, rect.width, rect.height);

      // ── Tiles ────────────────────────────────────────────────────────
      // Composited from the already-loaded <img> elements Leaflet keeps in
      // the DOM. Geometry is read via getBoundingClientRect() rather than
      // re-deriving Leaflet's own pane transform math, so this stays correct
      // regardless of Leaflet's internal layering or zoom-animation state.
      const tiles = container.querySelectorAll<HTMLImageElement>('.leaflet-tile-loaded');
      for (const tile of Array.from(tiles)) {
        const r = tile.getBoundingClientRect();
        if (r.right <= rect.left || r.left >= rect.right || r.bottom <= rect.top || r.top >= rect.bottom) continue;
        try {
          ctx.drawImage(tile, r.left - rect.left, r.top - rect.top, r.width, r.height);
        } catch {
          // One unreadable tile (a transient CORS/CDN hiccup) is skipped
          // rather than aborting the whole capture.
        }
      }

      // ── Site markers ────────────────────────────────────────────────
      // Same size/color rule as the live divIcon markers (computeSiteStyle),
      // positioned via the map's own projection so they land exactly where
      // the real markers are drawn.
      const maxCount = sites.reduce((m, s) => Math.max(m, s.observations.length), 1);
      for (const site of sites) {
        const { size, color } = computeSiteStyle(site, maxCount, accent, telescopeById, showTelescopeUI);
        const pt = mapInst.latLngToContainerPoint([site.lat, site.lon]);
        if (pt.x < -size || pt.x > rect.width + size || pt.y < -size || pt.y > rect.height + size) continue;
        const radius = size / 2;

        // Outer glow ring, matching the live marker's box-shadow.
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius + 2, 0, Math.PI * 2);
        ctx.strokeStyle = hexToRgba(color, 0.4);
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.stroke();

        // Fill + border. Dashed border marks an approximate (non-FITS) location.
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(color, 0.8);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = bg;
        ctx.setLineDash(site.approximate ? [3, 3] : []);
        ctx.stroke();
        ctx.setLineDash([]);

        // Count, genuinely centered — textAlign/textBaseline are exact, unlike
        // the flex-centered HTML version html2canvas couldn't reproduce.
        ctx.font = `600 ${Math.max(11, Math.min(15, size / 3))}px system-ui, -apple-system, sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(site.observations.length), pt.x, pt.y + 0.5);
      }

      // ── Attribution ──────────────────────────────────────────────────
      // Required by the tile provider's terms. Drawn as plain text rather
      // than lifted from Leaflet's own control, which is a tiny interactive
      // link with nothing to click in a static image.
      const attribText = 'Leaflet · © OpenStreetMap contributors · © CARTO';
      ctx.font = '10px system-ui, -apple-system, sans-serif';
      const textW = ctx.measureText(attribText).width;
      const boxH = 16;
      const boxW = textW + 12;
      const boxX = rect.width - boxW - 4;
      const boxY = rect.height - boxH - 4;
      ctx.fillStyle = isDark ? 'rgba(15,23,42,0.7)' : 'rgba(255,255,255,0.75)';
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.65)' : 'rgba(15,23,42,0.65)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(attribText, boxX + 6, boxY + boxH / 2 + 1);

      return canvas;
    },
  }), [isDark, sites, telescopeById, showTelescopeUI, accent]);

  return (
    <div className="relative w-full h-full" style={{ isolation: 'isolate', zIndex: 0 }}>
      <div ref={mapRef} className="w-full h-full" style={{ zIndex: 0 }} />
    </div>
  );
});
