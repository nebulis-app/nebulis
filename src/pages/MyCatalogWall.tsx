/**
 * "My <Catalog>" wall: the user's own pictures as a poster-style mosaic.
 * Route: /catalogs/:catalog/mine
 *
 * Only the user's own images appear (processed first, then telescope stacks);
 * an object they have not imaged is a dark cell with its catalog number.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, Heart, LayoutGrid, Pencil, Rows3, Share2, Sparkles, Undo2, X } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useWishlist } from '../hooks/useWishlist';
import { useAuth } from '../contexts/AuthContext';
import {
  getCatalogProgress, getCatalogWall, resetWallOverrides, saveWallOverrides,
  type WallSpan, type WallTile,
} from '../lib/api/catalogs';
import { getCatalogMeta } from '../lib/catalogMeta';
import { WallGrid } from '../components/catalogs/wall/WallGrid';
import { tileLabel } from '../lib/catalogWallTile';
import { PosterDialog } from '../components/catalogs/wall/PosterDialog';
import { WallEditControls } from '../components/catalogs/wall/WallEditControls';
import { WallImageChooser } from '../components/catalogs/wall/WallImageChooser';
import { WALL_OVERRIDE_KEYS, type WallOverride, type WallOverrides } from '../lib/catalogWallOverrides';
import type { Placement } from '../lib/catalogWallLayout';

type KindFilter = 'all' | 'processed' | 'telescope';
const NO_OVERRIDES: WallOverrides = {};

export function MyCatalogWall() {
  const { t } = useTranslation('catalogs');
  const { catalog = 'messier' } = useParams<{ catalog: string }>();
  const { isNight, isSpace } = useTheme();
  const accent = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';
  const meta = getCatalogMeta(catalog);

  const [kind, setKind] = useState<KindFilter>('all');
  const [uniform, setUniform] = useState(false);
  const [popover, setPopover] = useState<{ tile: WallTile; x: number; y: number } | null>(null);

  // Edit mode works on a draft; nothing is saved until Done.
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<WallOverrides | null>(null);
  const editing = draft !== null;
  const [geometry, setGeometry] = useState({ columns: 12, cell: 100 });
  const [chooserId, setChooserId] = useState<string | null>(null);
  const [posterOpen, setPosterOpen] = useState(false);

  const wallQuery = useQuery({
    queryKey: ['catalog-wall', catalog],
    queryFn: () => getCatalogWall(catalog),
    staleTime: 60_000,
  });
  // Same key as the board and hub, so this is normally a cache hit. It supplies
  // the type/constellation/magnitude a wishlist entry needs.
  const progressQuery = useQuery({
    queryKey: ['catalog-progress', catalog],
    queryFn: () => getCatalogProgress(catalog),
    staleTime: 60_000,
  });
  const wishlist = useWishlist();

  const wall = wallQuery.data;
  const savedOverrides = wall?.overrides ?? NO_OVERRIDES;
  const overrides = draft ?? savedOverrides;
  const tiles = useMemo(() => {
    if (!wall) return [];
    if (editing || kind === 'all') return wall.tiles;
    return wall.tiles.filter(tile => tile.imaged && tile.image?.kind === kind);
  }, [wall, kind, editing]);

  const counts = useMemo(() => {
    const all = wall?.tiles ?? [];
    return {
      processed: all.filter(x => x.imaged && x.image?.kind === 'processed').length,
      telescope: all.filter(x => x.imaged && x.image?.kind === 'telescope').length,
    };
  }, [wall]);

  const openPopover = (tile: WallTile, anchor: HTMLElement) => {
    const r = anchor.getBoundingClientRect();
    setPopover({ tile, x: r.left + r.width / 2, y: r.bottom });
  };

  useEffect(() => {
    if (!popover) return;
    const close = () => setPopover(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [popover]);

  const label = wall?.label ?? (meta ? t(meta.labelKey) : catalog);
  const imaged = wall?.imagedCount ?? 0;
  const total = wall?.total ?? meta?.total ?? 0;
  const pct = total > 0 ? Math.round((imaged / total) * 100) : 0;

  const toggleWishlist = (tile: WallTile) => {
    const obj = progressQuery.data?.objects.find(o => o.id === tile.id);
    wishlist.toggle({
      objectId: tile.id,
      name: tile.name,
      type: obj?.type ?? '',
      constellation: obj?.constellation ?? null,
      magnitude: obj?.magnitude ?? null,
      majorAxisArcmin: tile.majorAxisArcmin,
    });
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      // Diff the draft against what is saved: changed tiles are `set`, tiles that
      // lost all their edits are `clear`.
      const set: WallOverrides = {};
      const clear: string[] = [];
      for (const [id, o] of Object.entries(draft ?? {})) {
        if (JSON.stringify(o) !== JSON.stringify(savedOverrides[id])) set[id] = o;
      }
      for (const id of Object.keys(savedOverrides)) if (!draft?.[id]) clear.push(id);
      return saveWallOverrides(catalog, { set, clear });
    },
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['catalog-wall', catalog] });
    },
  });
  const resetMutation = useMutation({
    mutationFn: () => resetWallOverrides(catalog),
    onSuccess: () => {
      setDraft({});
      void queryClient.invalidateQueries({ queryKey: ['catalog-wall', catalog] });
    },
  });

  const patchDraft = (id: string, patch: Partial<WallOverride> | null) => {
    setDraft(prev => {
      if (!prev) return prev;
      const next = { ...prev };
      const merged: WallOverride = patch === null ? {} : { ...next[id], ...patch };
      // An explicit undefined removes that field, so "Auto" and "default image" really clear.
      for (const k of WALL_OVERRIDE_KEYS) if (merged[k] === undefined) delete merged[k];
      if (Object.keys(merged).length === 0) delete next[id];
      else next[id] = merged;
      return next;
    });
  };

  const startEditing = () => { setKind('all'); setUniform(false); setDraft({ ...savedOverrides }); };
  const cancelEditing = () => { setDraft(null); setChooserId(null); };
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(savedOverrides);

  useEffect(() => {
    if (!editing || chooserId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDraft(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, chooserId]);

  const chooserTile = chooserId ? wall?.tiles.find(x => x.id === chooserId) ?? null : null;
  const spanFor = (tile: WallTile): WallSpan => overrides[tile.id]?.span ?? tile.span;

  const renderOverlay = (tile: WallTile, p: Placement) => {
    if (!editing || !tile.imaged) return null;
    return (
      <WallEditControls
        tile={tile}
        placed={p.placed}
        override={overrides[tile.id]?.span ?? null}
        columns={geometry.columns}
        cell={geometry.cell}
        accent={accent}
        hasEdits={!!overrides[tile.id]}
        onSpan={span => patchDraft(tile.id, { span: span ?? undefined })}
        onPickImage={() => setChooserId(tile.id)}
        onReset={() => patchDraft(tile.id, null)}
      />
    );
  };

  return (
    <div className="flex flex-col gap-5 pb-10">
      {/* Slim header: the wall is the star, so no hero banner here */}
      <header className="relative overflow-hidden rounded-3xl bg-slate-950 px-5 py-5 sm:px-7 sm:py-6 hero-panel">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{ background: `radial-gradient(60% 120% at 85% 0%, ${accent}22 0%, transparent 70%)` }}
        />
        <div className="pointer-events-none absolute inset-0 rounded-3xl" style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }} />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <Link
              to={`/catalogs/${catalog}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] py-1 pl-1.5 pr-3 text-[0.6875rem] font-medium text-white/70 ring-1 ring-inset ring-white/15 backdrop-blur-md transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              {t('wall.backToBoard', { label })}
            </Link>
            <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
              {t('wall.title', { label })}
            </h1>
            <div className="mt-3 flex items-center gap-3">
              <span className="font-display text-lg font-bold tabular-nums text-white">
                {imaged}<span className="font-medium text-white/40"> / {total}</span>
              </span>
              <div className="h-1.5 w-40 overflow-hidden rounded-full bg-white/10 sm:w-56">
                <div
                  className="h-full rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${accent}b3, ${accent})`, boxShadow: `0 0 12px ${accent}80` }}
                />
              </div>
              <span className="text-xs tabular-nums text-white/50">{pct}%</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <span className="mr-1 hidden text-xs text-white/55 md:inline">{t('wall.edit.hint')}</span>
                <button
                  type="button"
                  onClick={() => resetMutation.mutate()}
                  disabled={resetMutation.isPending}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1.5 text-xs font-medium text-white/75 ring-1 ring-inset ring-white/15 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  {t('wall.edit.resetWall')}
                </button>
                <button
                  type="button"
                  onClick={cancelEditing}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1.5 text-xs font-medium text-white/75 ring-1 ring-inset ring-white/15 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  <X className="h-3.5 w-3.5" />
                  {t('wall.edit.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => (dirty ? saveMutation.mutate() : cancelEditing())}
                  disabled={saveMutation.isPending}
                  className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold text-slate-950 transition-transform hover:scale-[1.03] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  style={{ background: accent }}
                >
                  <Check className="h-3.5 w-3.5" />
                  {t('wall.edit.done')}
                </button>
              </>
            ) : (
              <>
            <div role="group" aria-label={t('wall.filterAria')} className="inline-flex rounded-full bg-white/[0.07] p-0.5 ring-1 ring-inset ring-white/15 backdrop-blur-md">
              {(['all', 'processed', 'telescope'] as const).map(k => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60
                    ${kind === k ? 'bg-white/15 text-white' : 'text-white/60 hover:text-white'}`}
                >
                  {t(`wall.filter.${k}`)}
                  {k !== 'all' && <span className="ml-1.5 tabular-nums text-white/40">{counts[k]}</span>}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-pressed={uniform}
              onClick={() => setUniform(u => !u)}
              title={uniform ? t('wall.layoutMosaic') : t('wall.layoutUniform')}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1.5 text-xs font-medium text-white/75 ring-1 ring-inset ring-white/15 backdrop-blur-md transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              {uniform ? <Rows3 className="h-3.5 w-3.5" /> : <LayoutGrid className="h-3.5 w-3.5" />}
              {uniform ? t('wall.uniform') : t('wall.mosaic')}
            </button>
            {isAdmin && imaged > 0 && (
              <button
                type="button"
                onClick={startEditing}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1.5 text-xs font-medium text-white/75 ring-1 ring-inset ring-white/15 backdrop-blur-md transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <Pencil className="h-3.5 w-3.5" />
                {t('wall.edit.start')}
              </button>
            )}
            {imaged > 0 && (
              <button
                type="button"
                onClick={() => setPosterOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                style={{ background: accent }}
              >
                <Share2 className="h-3.5 w-3.5" />
                {t('wall.poster.open')}
              </button>
            )}
              </>
            )}
          </div>
        </div>
      </header>

      {(saveMutation.isError || resetMutation.isError) && (
        <p role="alert" className="text-center text-sm text-red-300">{t('wall.edit.saveFailed')}</p>
      )}

      {wallQuery.isLoading ? (
        <div className="aspect-[16/9] w-full animate-pulse rounded-2xl bg-slate-900" aria-hidden="true" />
      ) : wallQuery.isError || !wall ? (
        <p className="py-16 text-center text-sm text-slate-400">{t('wall.loadFailed')}</p>
      ) : imaged === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl bg-slate-950 py-20 text-center ring-1 ring-white/10">
          <Sparkles className="h-8 w-8 text-white/30" />
          <p className="max-w-sm text-sm text-white/60">{t('wall.empty', { label })}</p>
          <Link to={`/catalogs/${catalog}`} className="rounded-full bg-white/10 px-4 py-1.5 text-xs font-semibold text-white ring-1 ring-inset ring-white/15 hover:bg-white/15">
            {t('wall.backToBoard', { label })}
          </Link>
        </div>
      ) : (
        <WallGrid
          tiles={tiles}
          overrides={overrides}
          imagedCount={imaged}
          total={total}
          accent={accent}
          uniform={uniform}
          editing={editing}
          onEmptyClick={editing ? undefined : openPopover}
          renderOverlay={renderOverlay}
          onGeometry={setGeometry}
        />
      )}

      {posterOpen && wall && (
        <PosterDialog
          tiles={wall.tiles}
          overrides={savedOverrides}
          label={label}
          imagedCount={imaged}
          total={total}
          accent={accent}
          onClose={() => setPosterOpen(false)}
        />
      )}

      {chooserTile && (
        <WallImageChooser
          tile={chooserTile}
          span={spanFor(chooserTile)}
          value={overrides[chooserTile.id]}
          accent={accent}
          onChange={patch => patchDraft(chooserTile.id, patch)}
          onClose={() => setChooserId(null)}
        />
      )}

      {popover && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPopover(null)} aria-hidden="true" />
          <div
            role="dialog"
            aria-label={tileLabel(popover.tile)}
            className="fixed z-50 w-56 -translate-x-1/2 rounded-2xl bg-slate-900 p-3 shadow-2xl ring-1 ring-white/15"
            style={{
              left: Math.min(Math.max(popover.x, 128), window.innerWidth - 128),
              top: Math.min(popover.y + 8, window.innerHeight - 170),
            }}
          >
            <div className="font-display text-sm font-semibold text-white">{tileLabel(popover.tile)}</div>
            <div className="truncate text-xs text-white/55">{popover.tile.name}</div>
            <div className="mt-1 text-[0.6875rem] text-white/40">{t('wall.notImaged')}</div>
            <div className="mt-3 flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => { toggleWishlist(popover.tile); setPopover(null); }}
                className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white ring-1 ring-inset ring-white/15 hover:bg-white/15"
              >
                <Heart className="h-3.5 w-3.5" style={{ color: accent }} fill={wishlist.idSet.has(popover.tile.id) ? accent : 'none'} />
                {wishlist.idSet.has(popover.tile.id) ? t('wall.removeWishlist') : t('wall.addWishlist')}
              </button>
              <Link
                to={`/catalogs/${catalog}?object=${encodeURIComponent(popover.tile.id)}`}
                className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white ring-1 ring-inset ring-white/15 hover:bg-white/15"
              >
                <Sparkles className="h-3.5 w-3.5" style={{ color: accent }} />
                {t('wall.planIt')}
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
