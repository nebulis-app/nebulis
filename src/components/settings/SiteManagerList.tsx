import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MapPin, Pencil, Trash2, Star, Sparkles, Compass } from 'lucide-react';
import { getSites, deleteSite, setDefaultSite, updateSite, type ObservingSite } from '../../lib/api/sites';
import { AddListButton } from './SettingsUI';
import { SitesMap } from './SitesMap';
import { SiteEditorModal } from './SiteEditorModal';
import { VisibleSkyEditor } from '../ui/VisibleSkyEditor';
import { ConfirmModal } from '../ConfirmModal';
import type { VisibleSkyMap } from '../../lib/visibilityCheck';

/**
 * The observing-sites list: add/edit/delete/set-default, plus a per-row
 * "Set Visible Sky" action. Shared by the Settings page (inline) and
 * SiteManagerModal (as a popup reachable from Planner/Forecast), so there is
 * exactly one place this logic lives.
 *
 * Sky-mask editing is per-row rather than "whichever site is currently
 * active" — editing site B's mask must not require switching to site B
 * first.
 */
export function SiteManagerList({ isDark, showMap = false }: { isDark: boolean; showMap?: boolean }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [showAddModal, setShowAddModal] = useState(false);
  const [editing, setEditing] = useState<ObservingSite | null>(null);
  const [editingSky, setEditingSky] = useState<ObservingSite | null>(null);
  const [deleting, setDeleting] = useState<ObservingSite | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: getSites,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['sites'] });
    queryClient.invalidateQueries({ queryKey: ['settings'] });
    queryClient.invalidateQueries({ queryKey: ['active-site'] });
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSite(id),
    onSuccess: () => { invalidateAll(); setDeleting(null); },
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => setDefaultSite(id),
    onSuccess: invalidateAll,
  });

  const saveSkyMutation = useMutation({
    mutationFn: ({ id, map }: { id: string; map: VisibleSkyMap }) => updateSite(id, { visibleSkyMap: map }),
    onSuccess: () => { invalidateAll(); setEditingSky(null); },
  });

  // Narrow the mutation error to a display string once, with instanceof, rather
  // than asserting Error at the render site. A thrown non-Error still renders
  // the generic fallback instead of reading `.message` off something that
  // hasn't got one.
  const rawMutationError: unknown = deleteMutation.error ?? saveSkyMutation.error;
  const mutationError = rawMutationError
    ? (rawMutationError instanceof Error ? rawMutationError.message : t('siteManager.genericSaveError'))
    : null;

  return (
    <div>
      {showAddModal && (
        <SiteEditorModal isDark={isDark} onClose={() => setShowAddModal(false)} />
      )}
      {editing && (
        <SiteEditorModal isDark={isDark} existing={editing} onClose={() => setEditing(null)} />
      )}
      {editingSky && (
        <VisibleSkyEditor
          open
          initialMap={editingSky.visibleSkyMap}
          onSave={(map) => saveSkyMutation.mutate({ id: editingSky.id, map })}
          onClose={() => setEditingSky(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={t('siteManager.deleteSiteTitle')}
          message={t('siteManager.deleteSiteConfirm', { name: deleting.name })}
          confirmLabel={t('siteManager.delete')}
          pending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}

      {mutationError && (
        <p className="mb-3 text-sm text-red-400">{mutationError}</p>
      )}

      {showMap && <SitesMap sites={sites} selectedId={selectedId} onSelect={setSelectedId} isDark={isDark} />}

      <div className="space-y-2 mb-3">
        {sites.map(site => (
          <SiteRow
            key={site.id}
            site={site}
            isDark={isDark}
            highlighted={selectedId === site.id}
            onHover={(on) => setSelectedId(on ? site.id : null)}
            onEdit={() => setEditing(site)}
            onSetSky={() => setEditingSky(site)}
            onSetDefault={() => setDefaultMutation.mutate(site.id)}
            onDelete={() => setDeleting(site)}
            canDelete={sites.length > 1}
            isPending={deleteMutation.isPending || setDefaultMutation.isPending}
          />
        ))}
      </div>

      <AddListButton isDark={isDark} onClick={() => setShowAddModal(true)}>
        {t('siteManager.addSite')}
      </AddListButton>
    </div>
  );
}

function SiteRow({
  site,
  isDark,
  highlighted,
  onHover,
  onEdit,
  onSetSky,
  onSetDefault,
  onDelete,
  canDelete,
  isPending,
}: {
  site: ObservingSite;
  isDark: boolean;
  highlighted: boolean;
  onHover: (on: boolean) => void;
  onEdit: () => void;
  onSetSky: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
  canDelete: boolean;
  isPending: boolean;
}) {
  const { t } = useTranslation('settings');
  const hasSkyMap = site.visibleSkyMap.length > 0;

  return (
    <div
      onClick={onEdit}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className={`group flex items-center gap-3 p-3.5 rounded-xl border cursor-pointer transition ${
        isDark
          ? 'bg-slate-900 border-slate-700 hover:border-accent-400'
          : 'bg-white border-slate-200 hover:border-accent-400'
      } ${highlighted ? 'border-accent-400' : ''}`}
    >
      <div className={`shrink-0 p-2 rounded-lg ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
        <MapPin className={`w-4 h-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            {site.name}
          </span>
          {site.isDefault && (
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[0.625rem] font-medium border shrink-0 ${
              isDark ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200'
            }`}>
              <Star className="w-2.5 h-2.5" /> {t('siteManager.default')}
            </span>
          )}
        </div>
        <p className={`text-xs mt-0.5 truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {site.latitude != null && site.longitude != null ? `${site.latitude.toFixed(4)}, ${site.longitude.toFixed(4)}` : t('siteManager.noCoordinates')}
        </p>
        <div className={`mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          {site.timezone && <span>{site.timezone}</span>}
          {site.bortleClass != null && <span>{t('siteManager.bortle', { class: site.bortleClass })}</span>}
          <span>{t('siteManager.minAlt', { degrees: site.minAlt })}</span>
          <span className={`inline-flex items-center gap-1 ${hasSkyMap ? '' : isDark ? 'text-slate-600' : 'text-slate-400'}`}>
            <Sparkles className="w-3 h-3" /> {hasSkyMap ? t('siteManager.skyMapped') : t('siteManager.skyNotMapped')}
          </span>
        </div>
      </div>

      {/* Always visible: hiding these until hover made "set as default" and
          the sky map undiscoverable, and unreachable on touchscreens. */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={e => { e.stopPropagation(); onSetSky(); }}
          title={t('siteManager.setVisibleSky')}
          className={`p-2 rounded-lg transition ${isDark ? 'text-slate-400 hover:text-teal-400 hover:bg-slate-800' : 'text-slate-500 hover:text-teal-600 hover:bg-slate-100'}`}
        >
          <Compass className="w-4 h-4" />
        </button>
        {/* Every row gets the star so the icon columns line up: filled and
            inert on the default site, an outline button that sets it on the
            others. */}
        <button
          onClick={e => { e.stopPropagation(); if (!site.isDefault) onSetDefault(); }}
          disabled={isPending || site.isDefault}
          aria-pressed={site.isDefault}
          title={site.isDefault ? t('siteManager.default') : t('siteManager.setAsDefault')}
          className={`p-2 rounded-lg transition ${
            site.isDefault
              ? 'cursor-default text-amber-400'
              : `disabled:opacity-40 ${isDark ? 'text-slate-400 hover:text-amber-400 hover:bg-slate-800' : 'text-slate-500 hover:text-amber-600 hover:bg-slate-100'}`
          }`}
        >
          <Star className={`w-4 h-4 ${site.isDefault ? 'fill-current' : ''}`} />
        </button>
        <button
          onClick={e => { e.stopPropagation(); onEdit(); }}
          title={t('siteManager.edit')}
          className={`p-2 rounded-lg transition ${isDark ? 'text-slate-400 hover:text-white hover:bg-slate-800' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'}`}
        >
          <Pencil className="w-4 h-4" />
        </button>
        <button
          onClick={e => { e.stopPropagation(); onDelete(); }}
          disabled={isPending || !canDelete}
          title={canDelete ? t('siteManager.delete') : t('siteManager.cannotDeleteLast')}
          className={`p-2 rounded-lg transition disabled:opacity-40 ${
            isDark ? 'text-slate-400 hover:text-red-400 hover:bg-slate-800' : 'text-slate-500 hover:text-red-600 hover:bg-slate-100'
          }`}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
