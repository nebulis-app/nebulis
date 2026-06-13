import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Telescope as TelescopeIcon,
  Trash2,
  Pencil,
  Archive,
  ArchiveRestore,
  Move,
  Usb,
  Network,
  RefreshCw,
} from 'lucide-react';
import {
  listTelescopes,
  deleteTelescope,
  updateTelescope,
  archiveTelescope,
  unarchiveTelescope,
  type TelescopeProfile,
} from '../../lib/api/telescopes';
import { triggerImport, getImportStatus } from '../../lib/api/library';
import { AddTelescopeModal } from './AddTelescopeModal';
import { ReassignTelescopeModal } from './ReassignTelescopeModal';

/**
 * Connection settings — the per-telescope card grid.
 *
 * After multi-telescope support landed, this section is *only* a list of
 * cards. Each row links to the Edit modal which owns the connection form,
 * password, color, and auto-import toggle. The legacy single-telescope form
 * (model/hostname/share/username/password) and the "Active" concept were
 * removed because they no longer drive any user-visible behavior:
 *  - Imports fan out across every auto-import-enabled scope (Gallery button,
 *    auto-import scheduler).
 *  - Per-session re-syncs target the captured scope, not the active one.
 *  - The status pill in the top nav probes every configured scope.
 *
 * `isActive` still lives in the database as a backwards-compat fallback for
 * any code path that hasn't been threaded through with an explicit
 * `telescopeId`, but users no longer pick it.
 */
export function ConnectionSection({ isDark }: { isDark: boolean }) {
  const queryClient = useQueryClient();
  const [showAddModal, setShowAddModal] = useState(false);
  const [editing, setEditing] = useState<TelescopeProfile | null>(null);
  const [reassigning, setReassigning] = useState<TelescopeProfile | null>(null);

  const { data: telescopes = [] } = useQuery({
    queryKey: ['telescopes'],
    queryFn: listTelescopes,
  });

  // Active telescopes drive auto-import + are valid reassign targets;
  // archived ones live below in their own list with restore + reassign actions.
  const active = telescopes.filter(t => t.archivedAt === null);
  const archived = telescopes.filter(t => t.archivedAt !== null);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['telescopes'] });
    queryClient.invalidateQueries({ queryKey: ['settings'] });
    // Header pill ("1/3 online") + popover both read from these. Without
    // explicit invalidation here they only refresh on TanStack's 30 s tick,
    // so the user sees stale archived/deleted scopes until then.
    queryClient.invalidateQueries({ queryKey: ['telescope-status'] });
    queryClient.invalidateQueries({ queryKey: ['telescope-status-all'] });
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTelescope(id),
    onSuccess: invalidateAll,
  });

  const toggleAutoImportMutation = useMutation({
    mutationFn: ({ id, autoImportEnabled }: { id: string; autoImportEnabled: boolean }) =>
      updateTelescope(id, { autoImportEnabled }),
    onSuccess: invalidateAll,
  });

  const archiveMutation = useMutation({
    mutationFn: archiveTelescope,
    onSuccess: invalidateAll,
  });

  const unarchiveMutation = useMutation({
    mutationFn: unarchiveTelescope,
    onSuccess: invalidateAll,
  });

  // Per-row sync — fires runImport against a specific telescope. The button
  // shows a spinner while the import is running; we poll status during the
  // run so it accurately reflects the backend's state, not just whether the
  // mutation is in-flight (the mutation resolves immediately after kickoff).
  const syncMutation = useMutation({
    mutationFn: (id: string) => triggerImport({ telescopeId: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['import-status'] });
    },
  });
  const { data: importStatus } = useQuery({
    queryKey: ['import-status'],
    queryFn: getImportStatus,
    // Only poll while the row is showing a spinner. Once an import finishes,
    // the next status fetch flips `running` to false and polling stops.
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
  });

  const isAnyPending = deleteMutation.isPending
    || toggleAutoImportMutation.isPending
    || archiveMutation.isPending
    || unarchiveMutation.isPending;

  function handleArchive(t: TelescopeProfile) {
    const sessionCount = t.sessionCount ?? 0;
    const msg = sessionCount > 0
      ? `Archive "${t.name}"? It will stop auto-importing but its ${sessionCount} session${sessionCount === 1 ? '' : 's'} stay attributed to it. You can restore or move sessions later.`
      : `Archive "${t.name}"? It will stop auto-importing.`;
    if (confirm(msg)) archiveMutation.mutate(t.id);
  }

  return (
    <div>
      {showAddModal && (
        <AddTelescopeModal isDark={isDark} onClose={() => setShowAddModal(false)} />
      )}
      {editing && (
        <AddTelescopeModal
          isDark={isDark}
          existing={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {reassigning && (
        <ReassignTelescopeModal
          isDark={isDark}
          source={reassigning}
          // Targets must be active and not the source itself.
          candidates={active.filter(c => c.id !== reassigning.id)}
          onClose={() => setReassigning(null)}
        />
      )}

      <div className="mb-5">
        <h2 className={`font-display text-2xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
          Telescopes
        </h2>
        <p className={`mt-1 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Each telescope imports independently. Click a card to edit its connection, color, or auto-import setting.
        </p>
      </div>

      {archiveMutation.error && (
        <p className="mb-3 text-sm text-red-400">
          {archiveMutation.error instanceof Error ? archiveMutation.error.message : 'Failed to archive telescope. Try again.'}
        </p>
      )}

      <div className="space-y-2 mb-3">
        {active.map(t => (
          <TelescopeRow
            key={t.id}
            telescope={t}
            isDark={isDark}
            onEdit={() => setEditing(t)}
            onArchive={() => handleArchive(t)}
            onReassign={() => setReassigning(t)}
            onToggleAutoImport={() => toggleAutoImportMutation.mutate({ id: t.id, autoImportEnabled: !t.autoImportEnabled })}
            onSync={() => syncMutation.mutate(t.id)}
            // Disable sync when this telescope (or any other) is already
            // syncing — runImport holds a global lock, so a second click
            // would just fail server-side.
            isSyncingThis={!!importStatus?.running && importStatus.telescopeId === t.id}
            isAnyImportRunning={!!importStatus?.running}
            canReassign={active.length > 1}
            isPending={isAnyPending}
          />
        ))}
      </div>

      <button
        onClick={() => setShowAddModal(true)}
        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border transition w-full justify-center ${
          isDark
            ? 'bg-slate-900/50 border-slate-800 text-slate-300 hover:border-teal-500/50 hover:bg-slate-800/50'
            : 'bg-white border-slate-200 text-slate-700 hover:border-teal-300 hover:bg-teal-50/50'
        }`}
      >
        <Plus className="w-4 h-4" />
        Add Smart Telescope
      </button>

      {archived.length > 0 && (
        <div className="mt-7">
          <h3 className={`text-[12px] font-semibold uppercase tracking-wider mb-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Archived
          </h3>
          <p className={`text-[12px] mb-3 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Retired telescopes. Their historical sessions stay attributed for accurate reporting; auto-import is paused.
          </p>
          <div className="space-y-2">
            {archived.map(t => (
              <ArchivedTelescopeRow
                key={t.id}
                telescope={t}
                isDark={isDark}
                onUnarchive={() => unarchiveMutation.mutate(t.id)}
                onReassign={() => setReassigning(t)}
                onDelete={() => {
                  if (confirm(`Delete "${t.name}" permanently? This removes the connection record. Imported observations remain on disk.`)) {
                    deleteMutation.mutate(t.id);
                  }
                }}
                canReassign={active.length > 0}
                isPending={isAnyPending}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Single row in the active telescope list. The whole row is the click target
 * for Edit. Auto-import toggles inline. Archive replaces hard delete as the
 * primary "retire this scope" action — historical sessions keep their
 * attribution. Reassign opens the bulk-move modal for hardware swaps.
 */
function TelescopeRow({
  telescope,
  isDark,
  onEdit,
  onArchive,
  onReassign,
  onToggleAutoImport,
  onSync,
  isSyncingThis,
  isAnyImportRunning,
  canReassign,
  isPending,
}: {
  telescope: TelescopeProfile;
  isDark: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onReassign: () => void;
  onToggleAutoImport: () => void;
  onSync: () => void;
  isSyncingThis: boolean;
  isAnyImportRunning: boolean;
  canReassign: boolean;
  isPending: boolean;
}) {
  const sessions = telescope.sessionCount ?? 0;
  const transports = telescope.transports ?? [];
  const smbCount = transports.filter(t => t.kind === 'smb').length;
  const localCount = transports.filter(t => t.kind === 'local').length;
  // Compose the secondary line. When the profile has more than one transport,
  // show the breakdown (1 Wi-Fi + 1 USB) instead of just the SMB hostname so
  // the user can see at a glance that this telescope has both reachable.
  let transportLine: string;
  if (transports.length > 1) {
    const parts: string[] = [];
    if (smbCount > 0) parts.push(`${smbCount} Wi-Fi`);
    if (localCount > 0) parts.push(`${localCount} USB`);
    transportLine = parts.join(' + ');
  } else if (transports.length === 1) {
    const t = transports[0];
    transportLine = t.kind === 'local' ? (t.localPath || 'USB drive not set') : (t.hostname || 'no host set');
  } else {
    transportLine = telescope.hostname || telescope.localPath || 'no transport set';
  }
  return (
    <div
      onClick={onEdit}
      className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition cursor-pointer ${
        isDark
          ? 'bg-slate-900/50 border-slate-800 hover:border-slate-700'
          : 'bg-white border-slate-200 hover:border-slate-300'
      } ${isPending ? 'opacity-60 pointer-events-none' : ''}`}
    >
      <span
        className="w-3 h-3 rounded-full shrink-0 ring-1 ring-black/10"
        style={{ backgroundColor: telescope.color || '#8b5cf6' }}
        aria-hidden="true"
      />
      <TelescopeIcon className={`w-4 h-4 shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className={`text-sm font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
            {telescope.name}
          </div>
          <TransportPills telescope={telescope} isDark={isDark} />
        </div>
        <div className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {telescope.model} · {transportLine} · {sessions} session{sessions === 1 ? '' : 's'}
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onSync(); }}
        disabled={isAnyImportRunning || isPending}
        title={isSyncingThis
          ? 'Syncing this telescope now'
          : isAnyImportRunning
            ? 'Another import is in progress'
            : 'Sync now (pull new files from this telescope)'}
        className={`p-1.5 rounded-lg transition disabled:opacity-30 disabled:cursor-not-allowed ${
          isDark ? 'hover:bg-slate-800 text-slate-400 hover:text-emerald-400' : 'hover:bg-slate-100 text-slate-500 hover:text-emerald-600'
        }`}
      >
        <RefreshCw className={`w-3.5 h-3.5 ${isSyncingThis ? 'animate-spin text-emerald-500' : ''}`} />
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={telescope.autoImportEnabled}
        onClick={(e) => { e.stopPropagation(); onToggleAutoImport(); }}
        disabled={isPending}
        title={telescope.autoImportEnabled ? 'Auto-import on: click to disable' : 'Auto-import off: click to enable'}
        className={`relative inline-flex h-4 w-7 items-center rounded-full transition shrink-0 ${
          telescope.autoImportEnabled
            ? 'bg-teal-500'
            : isDark ? 'bg-slate-700' : 'bg-slate-300'
        } ${isPending ? 'opacity-50' : ''}`}
      >
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${
          telescope.autoImportEnabled ? 'translate-x-3.5' : 'translate-x-0.5'
        }`} />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onReassign(); }}
        disabled={!canReassign || isPending}
        title={canReassign
          ? 'Move all sessions to another telescope'
          : 'Add another telescope to enable bulk reassignment'}
        className={`p-1.5 rounded-lg transition disabled:opacity-30 disabled:cursor-not-allowed ${
          isDark ? 'hover:bg-slate-800 text-slate-400 hover:text-violet-400' : 'hover:bg-slate-100 text-slate-500 hover:text-violet-600'
        }`}
      >
        <Move className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
        disabled={isPending}
        title="Edit telescope"
        className={`p-1.5 rounded-lg transition disabled:opacity-30 disabled:cursor-not-allowed ${
          isDark ? 'hover:bg-slate-800 text-slate-400 hover:text-teal-400' : 'hover:bg-slate-100 text-slate-500 hover:text-teal-600'
        }`}
      >
        <Pencil className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onArchive(); }}
        disabled={isPending}
        title="Archive telescope (keeps historical sessions attributed)"
        className={`p-1.5 rounded-lg transition disabled:opacity-30 disabled:cursor-not-allowed ${
          isDark ? 'hover:bg-slate-800 text-slate-400 hover:text-amber-400' : 'hover:bg-slate-100 text-slate-500 hover:text-amber-600'
        }`}
      >
        <Archive className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/**
 * Archived row — visually muted, separate action set. No edit on click since
 * editing a retired profile rarely makes sense; restore first if you want
 * to change connection details.
 */
function ArchivedTelescopeRow({
  telescope,
  isDark,
  onUnarchive,
  onReassign,
  onDelete,
  canReassign,
  isPending,
}: {
  telescope: TelescopeProfile;
  isDark: boolean;
  onUnarchive: () => void;
  onReassign: () => void;
  onDelete: () => void;
  canReassign: boolean;
  isPending: boolean;
}) {
  const sessions = telescope.sessionCount ?? 0;
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition opacity-70 ${
        isDark ? 'bg-slate-900/30 border-slate-800/60' : 'bg-slate-50/60 border-slate-200/60'
      } ${isPending ? 'pointer-events-none' : ''}`}
    >
      <span
        className="w-3 h-3 rounded-full shrink-0 ring-1 ring-black/10 grayscale"
        style={{ backgroundColor: telescope.color || '#8b5cf6' }}
        aria-hidden="true"
      />
      <TelescopeIcon className={`w-4 h-4 shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium truncate ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
          {telescope.name}
        </div>
        <div className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {telescope.model} · {sessions} session{sessions === 1 ? '' : 's'} · archived
        </div>
      </div>
      <button
        onClick={onReassign}
        disabled={!canReassign || isPending || sessions === 0}
        title={
          sessions === 0 ? 'No sessions to move'
            : canReassign ? 'Move sessions to another telescope'
              : 'Add or restore a telescope to move sessions'}
        className={`p-1.5 rounded-lg transition disabled:opacity-30 disabled:cursor-not-allowed ${
          isDark ? 'hover:bg-slate-800 text-slate-400 hover:text-violet-400' : 'hover:bg-slate-100 text-slate-500 hover:text-violet-600'
        }`}
      >
        <Move className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={onUnarchive}
        disabled={isPending}
        title="Restore telescope"
        className={`p-1.5 rounded-lg transition disabled:opacity-30 disabled:cursor-not-allowed ${
          isDark ? 'hover:bg-slate-800 text-slate-400 hover:text-teal-400' : 'hover:bg-slate-100 text-slate-500 hover:text-teal-600'
        }`}
      >
        <ArchiveRestore className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={onDelete}
        disabled={isPending}
        title="Delete permanently"
        className={`p-1.5 rounded-lg transition disabled:opacity-30 disabled:cursor-not-allowed ${
          isDark ? 'hover:bg-slate-800 text-slate-400 hover:text-red-400' : 'hover:bg-slate-100 text-slate-500 hover:text-red-600'
        }`}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/** Small pills showing how each telescope is reachable. Dwarf is USB-only by
 *  spec so it always renders the USB pill regardless of transport state.
 *  Everything else renders one pill per configured transport kind, so a
 *  Seestar with both SMB and USB shows both pills. The pill matching the
 *  profile's `activeTransportId` (the one selectActiveTransport would pick
 *  right now) renders bright; the inactive transport renders dim. */
function TransportPills({ telescope, isDark }: { telescope: TelescopeProfile; isDark: boolean }) {
  const isDwarf = telescope.kind === 'dwarf-2' || telescope.kind === 'dwarf-3' || telescope.kind === 'dwarf-mini';
  const transports = telescope.transports ?? [];
  const smbTransport = transports.find(t => t.kind === 'smb');
  const localTransport = transports.find(t => t.kind === 'local');

  const hasSmb = !isDwarf && !!smbTransport;
  const hasLocal = isDwarf || !!localTransport;

  // If the transports array is empty (older profile that hasn't been re-read
  // yet) fall back to the legacy mirror so the row still shows something.
  const fallbackSmb = !isDwarf && !hasSmb && !hasLocal && telescope.connectionType !== 'local';
  const fallbackLocal = !isDwarf && !hasSmb && !hasLocal && telescope.connectionType === 'local';

  const showSmb = hasSmb || fallbackSmb;
  const showLocal = hasLocal || fallbackLocal;
  if (!showSmb && !showLocal) return null;

  // Active transport: highlight the one selectActiveTransport picked. When
  // only one transport is configured it's trivially active. The
  // activeTransportId is null when no transport is reachable right now (we
  // dim both in that case so the user can tell the import won't run).
  const activeId = telescope.activeTransportId;
  const noActive = activeId === null && (showSmb || showLocal);
  const isSmbActive = hasSmb && (transports.length === 1 || smbTransport?.id === activeId);
  const isLocalActive = (hasLocal && (transports.length === 1 || localTransport?.id === activeId)) ||
    (isDwarf && transports.length === 0);

  return (
    <div className="flex items-center gap-1 shrink-0">
      {showSmb && <TransportPill kind="smb" active={!noActive && isSmbActive} isDark={isDark} />}
      {showLocal && <TransportPill kind="local" active={!noActive && isLocalActive} isDark={isDark} />}
    </div>
  );
}

function TransportPill({ kind, active, isDark }: { kind: 'smb' | 'local'; active: boolean; isDark: boolean }) {
  const isSmb = kind === 'smb';
  const Icon = isSmb ? Network : Usb;
  const label = isSmb ? 'Wi-Fi' : 'USB';
  // Bright tones for the active transport (sky-blue for SMB, amber for USB)
  // and a muted slate tone for the inactive one so the user's eye lands on
  // the transport actually in use.
  const tone = !active
    ? (isDark ? 'bg-slate-800/60 text-slate-500 border-slate-700/60' : 'bg-slate-100 text-slate-400 border-slate-200')
    : isSmb
      ? (isDark ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-sky-50 text-sky-700 border-sky-200')
      : (isDark ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200');
  const title = active
    ? `${label}: active transport for this telescope right now`
    : `${label}: configured but not the active transport right now`;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${tone}`} title={title}>
      <Icon className="w-2.5 h-2.5" />
      {label}
    </span>
  );
}
