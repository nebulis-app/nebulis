import {
  useCallback, useEffect, useReducer, useRef, useState,
} from 'react';
import {
  Heart, X, ChevronLeft, ChevronRight, Play, Pause, Maximize, Minimize,
} from 'lucide-react';
import type { LibraryImage } from '../../lib/api/library';
import { fisherYates, preload, TOTAL_MS } from './galleryUtils';
import { slotReducer, type SlotState } from './galleryReducer';
import { KenBurnsSlide } from './KenBurnsSlide';

export interface PlanetariumModeProps {
  initialImages: LibraryImage[];
  favoritesOnly: boolean;
  showInfo: boolean;
  rotateCCW: boolean;
  onExit: () => void;
  onToggleFavorite: (img: LibraryImage) => void;
}

export function PlanetariumMode({
  initialImages,
  favoritesOnly,
  showInfo,
  rotateCCW,
  onExit,
  onToggleFavorite,
}: PlanetariumModeProps) {
  // Snapshot on mount, immune to parent re-renders caused by optimistic updates.
  // We manage isFavorite locally via PATCH_FAV dispatches.
  const [images] = useState(initialImages);
  const [favOnly, setFavOnly] = useState(favoritesOnly);
  const [isPlaying, setIsPlaying] = useState(true);
  const [showUI, setShowUI] = useState(true);

  // Pool lives in a ref so `advance` never needs to be recreated (stable callback,
  // stable interval, no timer restarts during playback).
  const poolRef = useRef<LibraryImage[]>([]);
  const posRef = useRef(0);
  const playRef = useRef(true);
  playRef.current = isPlaying;

  // Build the initial pool synchronously so slots are ready on first render.
  const buildPool = useCallback((src: LibraryImage[], fav: boolean) => {
    const filtered = fav ? src.filter(i => i.isFavorite) : src;
    return fisherYates(filtered.length > 0 ? filtered : src);
  }, []);

  const initSlot = (pool: LibraryImage[]): SlotState => ({
    active: 0,
    s0: pool[0],
    s1: pool[Math.min(1, pool.length - 1)],
  });

  const [slot, dispatch] = useReducer(slotReducer, undefined, () => {
    const pool = buildPool(images, favoritesOnly);
    poolRef.current = pool;
    posRef.current = 0;
    return initSlot(pool);
  });

  // Stable advance, reads from refs, zero dependencies.
  const advance = useCallback((dir: 1 | -1 = 1) => {
    if (!playRef.current) return;
    const pool = poolRef.current;
    const nextPos = ((posRef.current + dir) % pool.length + pool.length) % pool.length;
    posRef.current = nextPos;
    const next = pool[nextPos];
    dispatch({ type: 'ADVANCE', next });
    // Warm the cache for the image after that
    preload(pool[(nextPos + 1) % pool.length].downloadUrl);
  }, []);

  // Rebuild pool when favOnly changes, intentional user action, interruption OK.
  useEffect(() => {
    const pool = buildPool(images, favOnly);
    poolRef.current = pool;
    posRef.current = 0;
    dispatch({ type: 'RESET', s0: pool[0], s1: pool[Math.min(1, pool.length - 1)] });
    preload(pool[Math.min(2, pool.length - 1)]?.downloadUrl);
  }, [favOnly, buildPool, images]);

  // Preload the 3rd image on first mount (slots already hold 0 and 1).
  useEffect(() => {
    const pool = poolRef.current;
    if (pool.length > 2) preload(pool[2].downloadUrl);
  }, []);

  // Auto-advance timer, only depends on `isPlaying` (advance is stable).
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => advance(1), TOTAL_MS);
    return () => clearInterval(id);
  }, [isPlaying, advance]);

  // Ambient background music, loops, follows isPlaying, fully cleans up on exit.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const audio = new Audio('/planetarium_ambient.mp3');
    audio.loop = true;
    audio.volume = 0.35;
    audioRef.current = audio;
    audio.play().catch(() => {});
    return () => {
      audio.pause();
      audio.src = '';
      audioRef.current = null;
    };
  }, []);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) audio.play().catch(() => {});
    else audio.pause();
  }, [isPlaying]);

  // Fullscreen, enter on mount, track state so we can show a re-enter button
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    document.documentElement.requestFullscreen?.().catch(() => {});
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.exitFullscreen?.().catch(() => {});
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    } else {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, []);

  // Keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Let the browser handle Escape for fullscreen exit natively; don't exit planetarium
      if (e.key === ' ') { e.preventDefault(); setIsPlaying(p => !p); }
      if (e.key === 'ArrowRight') { e.preventDefault(); advance(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); advance(-1); }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [advance, toggleFullscreen]);

  // Auto-hide UI
  const uiTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const resetUI = useCallback(() => {
    setShowUI(true);
    clearTimeout(uiTimer.current);
    uiTimer.current = setTimeout(() => setShowUI(false), 3500);
  }, []);
  useEffect(() => { resetUI(); return () => clearTimeout(uiTimer.current); }, [resetUI]);

  const current = slot.active === 0 ? slot.s0 : slot.s1;

  function handleFavorite(img: LibraryImage) {
    const next = !img.isFavorite;
    dispatch({ type: 'PATCH_FAV', path: img.path, isFavorite: next });
    onToggleFavorite({ ...img, isFavorite: next });
  }

  return (
    <div
      className="fixed inset-0 z-[100] bg-black overflow-hidden"
      style={{ cursor: showUI ? 'default' : 'none' }}
      onMouseMove={resetUI}
    >
      {/* Two composited layers, only transform + opacity, no layout */}
      <KenBurnsSlide image={slot.s0} opacity={slot.active === 0 ? 1 : 0} rotateCCW={rotateCCW} />
      <KenBurnsSlide image={slot.s1} opacity={slot.active === 1 ? 1 : 0} rotateCCW={rotateCCW} />

      {/* Click-to-exit backdrop, sits between slides and UI, invisible */}
      <div className="absolute inset-0 z-10" onClick={onExit} />

      {/* Always-visible object info, never fades with the controls */}
      {showInfo && (
        <div
          className="absolute top-0 left-0 right-0 z-[15] px-8 pt-8 pb-20 pointer-events-none"
          style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.6) 0%, transparent 100%)' }}
        >
          <p className="text-white font-display text-2xl font-bold drop-shadow-lg leading-tight">
            {current.objectName}
          </p>
          {current.objectType && (
            <p className="text-white/55 text-sm mt-1 uppercase tracking-widest">
              {current.objectType}
            </p>
          )}
          {current.distanceLy != null && (
            <p className="text-white/40 text-xs mt-1">
              {current.distanceLy.toLocaleString()} ly from Earth
            </p>
          )}
        </div>
      )}

      {/* UI overlay */}
      <div
        className="absolute inset-0 z-20 flex flex-col"
        style={{
          opacity: showUI ? 1 : 0,
          transition: 'opacity 0.6s ease',
          pointerEvents: showUI ? 'auto' : 'none',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Top, exit + controls (no object info here anymore) */}
        <div
          className="flex-shrink-0 flex items-start justify-between px-8 pt-8 pb-20"
          style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.72) 0%, transparent 100%)' }}
        >
          <div />
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleFavorite(current)}
              title={current.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              className={`p-2.5 rounded-full backdrop-blur-md transition-all ${
                current.isFavorite
                  ? 'bg-rose-500/80 text-white'
                  : 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
              }`}
            >
              <Heart className={`w-5 h-5 ${current.isFavorite ? 'fill-current' : ''}`} />
            </button>
            <button
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit fullscreen (F)' : 'Enter fullscreen (F)'}
              className="p-2.5 rounded-full backdrop-blur-md bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-all"
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
            <button
              onClick={onExit}
              title="Exit Planetarium Mode"
              className="p-2.5 rounded-full backdrop-blur-md bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1" />

        {/* Bottom, controls */}
        <div
          className="flex-shrink-0 flex flex-col items-center gap-5 px-8 pb-8 pt-20"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.72) 0%, transparent 100%)' }}
        >
          {/* Source pill */}
          <div
            className="flex items-center gap-0.5 rounded-full p-1"
            style={{ background: 'rgba(255,255,255,0.12)', backdropFilter: 'blur(8px)' }}
          >
            <button
              onClick={() => setFavOnly(false)}
              className={`px-5 py-1.5 rounded-full text-sm font-medium transition-all ${
                !favOnly ? 'bg-white text-slate-900' : 'text-white/60 hover:text-white'
              }`}
            >
              All Images
            </button>
            <button
              onClick={() => setFavOnly(true)}
              className={`flex items-center gap-1.5 px-5 py-1.5 rounded-full text-sm font-medium transition-all ${
                favOnly ? 'bg-white text-slate-900' : 'text-white/60 hover:text-white'
              }`}
            >
              <Heart className={`w-3.5 h-3.5 ${favOnly ? 'fill-current text-rose-500' : ''}`} />
              Favorites
            </button>
          </div>

          {/* Playback */}
          <div className="flex items-center gap-4">
            <button
              onClick={() => advance(-1)}
              className="p-2.5 rounded-full bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-all"
              style={{ backdropFilter: 'blur(8px)' }}
              title="Previous (←)"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => setIsPlaying(p => !p)}
              className="p-4 rounded-full bg-white/15 text-white hover:bg-white/25 transition-all"
              style={{ backdropFilter: 'blur(8px)' }}
              title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            >
              {isPlaying
                ? <Pause className="w-6 h-6" />
                : <Play className="w-6 h-6 ml-0.5" />
              }
            </button>
            <button
              onClick={() => advance(1)}
              className="p-2.5 rounded-full bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-all"
              style={{ backdropFilter: 'blur(8px)' }}
              title="Next (→)"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          <p className="text-white/25 text-xs tracking-wide select-none">
            Move mouse to show controls &nbsp;·&nbsp; Space to pause &nbsp;·&nbsp; ← → to navigate &nbsp;·&nbsp; Esc to exit
          </p>
        </div>
      </div>
    </div>
  );
}
