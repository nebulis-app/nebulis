import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapPin, Plus, Pencil, Trash2, Star, Sparkles, Compass } from 'lucide-react';
import { getSites, deleteSite, setDefaultSite, updateSite, type ObservingSite } from '../../lib/api/sites';
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
export function SiteManagerList({ isDark }: { isDark: boolean }) {
  const queryClient = useQueryClient();
  const [showAddModal, setShowAddModal] = useState(false);
  const [editing, setEditing] = useState<ObservingSite | null>(null);
  const [editingSky, setEditingSky] = useState<ObservingSite | null>(null);
  const [deleting, setDeleting] = useState<ObservingSite | null>(null);

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
    ? (rawMutationError instanceof Error ? rawMutationError.message : 'That site could not be saved. Try again, and check the system log if it keeps failing.')
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
          title="Delete observing site"
          message={`Delete "${deleting.name}"? Sessions tagged to it will show under your default site instead; nothing on disk is affected.`}
          confirmLabel="Delete"
          pending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}

      {mutationError && (
        <p className="mb-3 text-sm text-red-400">{mutationError}</p>
      )}

      <div className="space-y-2 mb-3">
        {sites.map(site => (
          <SiteRow
            key={site.id}
            site={site}
            isDark={isDark}
            onEdit={() => setEditing(site)}
            onSetSky={() => setEditingSky(site)}
            onSetDefault={() => setDefaultMutation.mutate(site.id)}
            onDelete={() => setDeleting(site)}
            canDelete={sites.length > 1}
            isPending={deleteMutation.isPending || setDefaultMutation.isPending}
          />
        ))}
      </div>

      <button
        onClick={() => setShowAddModal(true)}
        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border transition w-full justify-center ${
          isDark
            ? 'bg-slate-900 border-slate-700 text-slate-300 hover:border-teal-500/50 hover:bg-slate-800/50'
            : 'bg-white border-slate-200 text-slate-700 hover:border-teal-300 hover:bg-teal-50/50'
        }`}
      >
        <Plus className="w-4 h-4" />
        Add observing site
      </button>
    </div>
  );
}

function SiteRow({
  site,
  isDark,
  onEdit,
  onSetSky,
  onSetDefault,
  onDelete,
  canDelete,
  isPending,
}: {
  site: ObservingSite;
  isDark: boolean;
  onEdit: () => void;
  onSetSky: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
  canDelete: boolean;
  isPending: boolean;
}) {
  const hasLocation = site.latitude != null && site.longitude != null;
  const hasSkyMap = site.visibleSkyMap.length > 0;

  return (
    <div
      onClick={onEdit}
      className={`group flex items-center gap-3 p-3.5 rounded-xl border cursor-pointer transition ${
        isDark
          ? 'bg-slate-900 border-slate-700 hover:border-accent-400'
          : 'bg-white border-slate-200 hover:border-accent-400'
      }`}
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
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border shrink-0 ${
              isDark ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200'
            }`}>
              <Star className="w-2.5 h-2.5" /> Default
            </span>
          )}
        </div>
        <p className={`text-xs mt-0.5 truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {hasLocation ? `${site.latitude!.toFixed(4)}, ${site.longitude!.toFixed(4)}` : 'No coordinates set'}
          {' · '}min alt {site.minAlt}°
          {hasSkyMap && (
            <span className="inline-flex items-center gap-1 ml-1">
              <Sparkles className="w-3 h-3 inline" /> sky mapped
            </span>
          )}
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={e => { e.stopPropagation(); onSetSky(); }}
          title="Set visible sky"
          className={`p-2 rounded-lg transition ${isDark ? 'text-slate-400 hover:text-teal-400 hover:bg-slate-800' : 'text-slate-500 hover:text-teal-600 hover:bg-slate-100'}`}
        >
          <Compass className="w-4 h-4" />
        </button>
        {!site.isDefault && (
          <button
            onClick={e => { e.stopPropagation(); onSetDefault(); }}
            disabled={isPending}
            title="Set as default"
            className={`p-2 rounded-lg transition disabled:opacity-40 ${
              isDark ? 'text-slate-400 hover:text-amber-400 hover:bg-slate-800' : 'text-slate-500 hover:text-amber-600 hover:bg-slate-100'
            }`}
          >
            <Star className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={e => { e.stopPropagation(); onEdit(); }}
          title="Edit"
          className={`p-2 rounded-lg transition ${isDark ? 'text-slate-400 hover:text-white hover:bg-slate-800' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'}`}
        >
          <Pencil className="w-4 h-4" />
        </button>
        <button
          onClick={e => { e.stopPropagation(); onDelete(); }}
          disabled={isPending || !canDelete}
          title={canDelete ? 'Delete' : 'Cannot delete the last observing site. Add another first.'}
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
