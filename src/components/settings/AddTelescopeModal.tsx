import { useState, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, RotateCw, HelpCircle, Telescope as TelescopeIcon, Check, Wifi, WifiOff, Usb, Network, Settings2, ChevronDown } from 'lucide-react';
import {
  createTelescope,
  updateTelescope,
  testTelescopeConnection,
  probeTransportIdentity,
  addProfileTransport,
  type TelescopeProfile,
  type DetectedDrive,
} from '../../lib/api/telescopes';
import { DwarfLocalPathPicker } from './DwarfLocalPathPicker';
import { LocalPathPicker } from './LocalPathPicker';
import {
  TELESCOPE_PRESETS,
  TELESCOPE_KINDS,
  DEFAULT_COLOR_BY_KIND,
  TELESCOPE_COLOR_PALETTE,
  modelToKind,
  toTelescopeKind,
  type TelescopeKind,
} from '../../lib/telescopePresets';
import { getInputClass, getLabelClass, getHelperClass } from './SettingsUI';
import { Modal } from '../ui/Modal';
import { FileTypeToggle } from '../ui/FileTypeToggle';

/**
 * Add/Edit Telescope modal — creates or updates a `TelescopeProfile`.
 * Pass `existing` to edit; omit to create. Fields auto-fill based on
 * telescope kind on create; on edit, the saved values seed every field.
 *
 * On success the parent should invalidate the `telescopes` query.
 */
export function AddTelescopeModal({
  onClose,
  isDark,
  existing,
}: {
  onClose: (createdId?: string) => void;
  isDark: boolean;
  /** When supplied, the modal switches to edit mode for this profile. */
  existing?: TelescopeProfile;
}) {
  const queryClient = useQueryClient();
  const inputClass = getInputClass(isDark);
  const labelClass = getLabelClass(isDark);
  const helperClass = getHelperClass(isDark);
  const isEdit = !!existing;

  const initialKind: TelescopeKind = existing
    ? (existing.kind ?? modelToKind(existing.model))
    : 'seestar-s50';

  const [kind, setKind] = useState<TelescopeKind>(initialKind);
  const preset = TELESCOPE_PRESETS[kind];
  const [name, setName] = useState(existing?.name ?? '');
  const [hostname, setHostname] = useState(existing?.hostname ?? '');
  const [shareName, setShareName] = useState(existing?.shareName ?? preset.shareName);
  const [username, setUsername] = useState(existing?.username ?? preset.username);
  const [password, setPassword] = useState('');
  const [color, setColor] = useState(existing?.color ?? DEFAULT_COLOR_BY_KIND[initialKind]);
  const [autoImportEnabled, setAutoImportEnabled] = useState(existing?.autoImportEnabled ?? true);
  const [autoImportInterval, setAutoImportInterval] = useState(existing?.autoImportInterval ?? 60);
  // Per-telescope file-type filters. Default to JPG on, others
  // off — matches the previous global defaults. Edits seed from the existing
  // profile so users can flip a single toggle without re-checking everything.
  const [importJpg, setImportJpg] = useState(existing?.importJpg ?? true);
  const [importFits, setImportFits] = useState(existing?.importFits ?? false);
  const [importThumbnails, setImportThumbnails] = useState(existing?.importThumbnails ?? false);
  const [importSubFrames, setImportSubFrames] = useState(existing?.importSubFrames ?? false);
  const [importVideos, setImportVideos] = useState(existing?.importVideos ?? false);
  // Toggle for the hidden `.nebulis.dat` device-tracking file. On by default
  // so SMB + USB transports of the same telescope merge into one logical
  // device; user can opt out from inside Advanced share settings.
  const [trackDeviceIdentity, setTrackDeviceIdentity] = useState(existing?.trackDeviceIdentity ?? true);
  const [showOtherHelp, setShowOtherHelp] = useState(false);
  // Local-fs path for USB-mounted telescopes (eMMC over USB). Dwarf is local
  // only; Seestar can pick between SMB and local via the transport selector.
  const [localPath, setLocalPath] = useState(existing?.localPath ?? '');
  const isDwarfKind = kind === 'dwarf-2' || kind === 'dwarf-3' || kind === 'dwarf-mini';
  const isSeestarKind = kind === 'seestar-s50' || kind === 'seestar-s30';
  // Transport mode picks which set of inputs to render and which connection
  // type to save on the profile. Dwarf is always 'local'; for everything else
  // we default to whatever the existing profile uses (or SMB for fresh adds).
  const [transportMode, setTransportMode] = useState<'smb' | 'local'>(() => {
    if (existing) return existing.connectionType === 'local' ? 'local' : 'smb';
    return isDwarfKind ? 'local' : 'smb';
  });
  const isLocalKind = isDwarfKind || transportMode === 'local';
  // Tracks the drive picked from the LocalPathPicker so the merge prompt can
  // skip a redundant probe when the row already advertises an existing pairing.
  const [pickedDrive, setPickedDrive] = useState<DetectedDrive | null>(null);
  // Merge prompt state. When probe-identity finds an existing profile owning
  // this device, we present a confirm modal before creating a duplicate.
  const [mergeCandidate, setMergeCandidate] = useState<{ profileId: string; profileName: string } | null>(null);

  // Advanced share settings disclosure (shareName + username + password). Most
  // Seestar users never touch these — defaults are the firmware's published
  // "EMMC Images" share with guest auth. Auto-open for the "other" kind
  // (where the user *must* fill them in) and for edits that diverge from the
  // current preset (so an existing custom value isn't hidden behind a chevron).
  const divergesFromPreset =
    !!existing &&
    (existing.shareName !== preset.shareName ||
      existing.username !== preset.username ||
      // password is always masked on read; ignore — opening for that alone
      // would force every edit to expand.
      false);
  const [advancedShareOpen, setAdvancedShareOpen] = useState<boolean>(
    initialKind === 'other' || divergesFromPreset,
  );

  // When the user changes telescope kind, refill share/username/color from
  // the new preset *unconditionally*. The user's edits in the same kind stick.
  const kindMemo = useMemo(() => kind, [kind]);
  const [appliedKind, setAppliedKind] = useState<TelescopeKind>(kindMemo);
  if (appliedKind !== kindMemo) {
    if (!isEdit) {
      setShareName(preset.shareName);
      setUsername(preset.username);
    }
    setColor(DEFAULT_COLOR_BY_KIND[kindMemo]);
    // Dwarf has no SMB path so its transport is always local. Other kinds
    // keep whatever the user picked.
    if (!isEdit && (kindMemo === 'dwarf-2' || kindMemo === 'dwarf-3' || kindMemo === 'dwarf-mini')) {
      setTransportMode('local');
    } else if (!isEdit && (kindMemo === 'seestar-s50' || kindMemo === 'seestar-s30')) {
      setTransportMode('smb');
    }
    // "other" needs a custom share configured, so surface the advanced
    // section automatically. Switching to a known preset re-collapses it.
    if (kindMemo === 'other') setAdvancedShareOpen(true);
    else if (!isEdit) setAdvancedShareOpen(false);
    setAppliedKind(kindMemo);
  }

  const createMutation = useMutation({
    mutationFn: () => createTelescope({
      name: name.trim() || `${preset.label}${isLocalKind ? (localPath ? ` (${localPath})` : '') : (hostname ? ` (${hostname})` : '')}`,
      model: preset.model,
      // Always send both sets. Under multi-transport, a profile can have both
      // an SMB and a USB transport configured at once; zeroing the inactive
      // side on save would wipe the user's other transport's connection
      // details.
      hostname: hostname.trim(),
      shareName: shareName.trim(),
      username: username.trim(),
      password,
      kind,
      color,
      autoImportEnabled,
      autoImportInterval,
      connectionType: isLocalKind ? 'local' : 'smb',
      localPath: localPath.trim(),
      importJpg,
      importFits,
      importThumbnails,
      importSubFrames,
      importVideos,
      trackDeviceIdentity,
    }),
    onSuccess: (created: TelescopeProfile) => {
      queryClient.invalidateQueries({ queryKey: ['telescopes'] });
      // Header pill + popover read separate query keys; invalidate them too so
      // the count updates immediately instead of waiting on the 30 s refetch.
      queryClient.invalidateQueries({ queryKey: ['telescope-status'] });
      queryClient.invalidateQueries({ queryKey: ['telescope-status-all'] });
      onClose(created.id);
    },
  });

  // "Attach to existing" mutation, used when the merge prompt confirms that
  // this transport belongs to an already-known telescope. We add the transport
  // to that profile instead of creating a duplicate.
  const attachToExistingMutation = useMutation({
    mutationFn: (profileId: string) =>
      addProfileTransport(profileId, {
        kind: isLocalKind ? 'local' : 'smb',
        hostname: isLocalKind ? '' : hostname.trim(),
        shareName: isLocalKind ? '' : shareName.trim(),
        username: isLocalKind ? '' : username.trim(),
        password: isLocalKind ? '' : password,
        localPath: isLocalKind ? localPath.trim() : '',
      }),
    onSuccess: (_t, profileId) => {
      queryClient.invalidateQueries({ queryKey: ['telescopes'] });
      queryClient.invalidateQueries({ queryKey: ['telescope-status'] });
      queryClient.invalidateQueries({ queryKey: ['telescope-status-all'] });
      onClose(profileId);
    },
  });

  const updateMutationInner = useMutation({
    mutationFn: () => {
      if (!existing) throw new Error('No profile to edit');
      // Server treats the masked password as "no change". Send only when the
      // user actually typed a new one.
      const payload: Partial<TelescopeProfile> = {
        name: name.trim() || existing.name,
        model: preset.model,
        // Always send both sets. Under multi-transport, a Seestar may have
        // both SMB and USB configured at once; zeroing one side on save
        // would wipe the user's other transport's connection details.
        hostname: hostname.trim(),
        shareName: shareName.trim(),
        username: username.trim(),
        kind,
        color,
        autoImportEnabled,
        autoImportInterval,
        connectionType: isLocalKind ? 'local' : 'smb',
        localPath: localPath.trim(),
        importJpg,
        importFits,
        importThumbnails,
        importSubFrames,
        importVideos,
        trackDeviceIdentity,
      };
      if (password) payload.password = password;
      return updateTelescope(existing.id, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['telescopes'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['telescope-status'] });
      queryClient.invalidateQueries({ queryKey: ['telescope-status-all'] });
      onClose(existing?.id);
    },
  });

  const mutation = isEdit ? updateMutationInner : createMutation;
  const saveBusy = mutation.isPending || attachToExistingMutation.isPending;
  const canSave = !saveBusy && (
    isLocalKind
      ? localPath.trim().length > 0
      : (hostname.trim().length > 0 && shareName.trim().length > 0)
  );

  // Probe-then-create. The probe writes `.nebulis.dat` if missing and tells
  // us whether the device already belongs to a known profile. If it does, we
  // show the merge confirm modal instead of creating a duplicate.
  const [probing, setProbing] = useState(false);
  const handleAdd = async () => {
    // The drive picker already surfaced an existing pairing — go straight to
    // the merge prompt without re-probing over the wire.
    if (pickedDrive?.alreadyKnownProfileId && pickedDrive.alreadyKnownProfileName) {
      setMergeCandidate({
        profileId: pickedDrive.alreadyKnownProfileId,
        profileName: pickedDrive.alreadyKnownProfileName,
      });
      return;
    }
    setProbing(true);
    try {
      const result = await probeTransportIdentity({
        transport: {
          kind: isLocalKind ? 'local' : 'smb',
          hostname: isLocalKind ? '' : hostname.trim(),
          shareName: isLocalKind ? '' : shareName.trim(),
          username: isLocalKind ? '' : username.trim(),
          password: isLocalKind ? '' : password,
          localPath: isLocalKind ? localPath.trim() : '',
        },
        model: preset.model,
      });
      if (result.alreadyKnownProfileId && result.alreadyKnownProfileName) {
        setMergeCandidate({
          profileId: result.alreadyKnownProfileId,
          profileName: result.alreadyKnownProfileName,
        });
        return;
      }
    } catch {
      // Probe failures are non-fatal. We continue to the regular create path,
      // which will surface its own connection error if anything is wrong.
    } finally {
      setProbing(false);
    }
    createMutation.mutate();
  };

  // Test the connection against current form values without saving. Reuses
  // the existing password if the user left the masked sentinel in place;
  // otherwise tests with whatever they typed. Result is local to this modal.
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const handleTest = async () => {
    setTestStatus('testing');
    setTestMessage('');
    try {
      const result = await testTelescopeConnection({
        kind,
        hostname: hostname.trim(),
        shareName: shareName.trim(),
        username: username.trim(),
        password,
      });
      if (result.connected) {
        setTestStatus('success');
        setTestMessage(`Connected. Found ${result.objectCount ?? 0} object folder${result.objectCount === 1 ? '' : 's'}.`);
      } else {
        setTestStatus('error');
        setTestMessage(result.error || 'Connection failed');
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  };
  // Connection test is SMB-only — there's nothing analogous to "auth handshake"
  // for a local filesystem mount. For Dwarf, fs.existsSync at save time is the
  // closest equivalent and happens implicitly during the first scan.
  const canTest = !isLocalKind && hostname.trim().length > 0 && shareName.trim().length > 0 && testStatus !== 'testing';

  return (
    <Modal
      isOpen
      onClose={() => { if (!mutation.isPending) onClose(); }}
      title={isEdit ? `Edit ${existing?.name ?? 'Telescope'}` : 'Add Smart Telescope'}
      className={`w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl overflow-hidden ${
        isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white shadow-xl'
      }`}
    >
        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 border-b ${
          isDark ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-teal-500/10' : 'bg-teal-50'}`}>
              <TelescopeIcon className="w-5 h-5 text-teal-500" />
            </div>
            <h3 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {isEdit ? `Edit ${existing?.name ?? 'Telescope'}` : 'Add Smart Telescope'}
            </h3>
          </div>
          <button
            onClick={() => onClose()}
            disabled={mutation.isPending}
            className={`p-1.5 rounded-lg transition disabled:opacity-50 ${
              isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
            }`}
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body. Sections walk the user through three questions: what is this
            telescope, how do we reach it, and what should we do with it. */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* ── Identity ─────────────────────────────────────────── */}
          <SectionHeading isDark={isDark}>Identity</SectionHeading>

          {/* Telescope kind */}
          <div>
            <label className={labelClass}>Telescope Type</label>
            <select
              value={kind}
              onChange={e => setKind(toTelescopeKind(e.target.value))}
              className={inputClass}
            >
              {TELESCOPE_KINDS.map(k => (
                <option key={k} value={k}>{TELESCOPE_PRESETS[k].label}</option>
              ))}
            </select>
            <p className={helperClass}>Picks sensible connection defaults and badge color for your model.</p>
          </div>

          {/* Friendly name (optional) */}
          <div>
            <label className={labelClass}>Display Name <span className="opacity-60">(optional)</span></label>
            <input
              type="text"
              placeholder={preset.label}
              value={name}
              onChange={e => setName(e.target.value)}
              className={inputClass}
            />
            <p className={helperClass}>How this telescope appears in the list. Defaults to the type + IP if blank.</p>
          </div>

          {/* Badge color — visual identity, grouped with name + type. */}
          <div>
            <label className={labelClass}>Badge Color</label>
            <div className="flex items-center gap-2 flex-wrap">
              {TELESCOPE_COLOR_PALETTE.map(c => {
                const selected = c.toLowerCase() === color.toLowerCase();
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    aria-label={`Pick color ${c}`}
                    className={`relative w-7 h-7 rounded-full transition ring-offset-2 ${
                      isDark ? 'ring-offset-slate-900' : 'ring-offset-white'
                    } ${selected ? 'ring-2 ring-slate-400 scale-110' : 'hover:scale-110'}`}
                    style={{ backgroundColor: c }}
                  >
                    {selected && <Check className="w-3.5 h-3.5 text-white absolute inset-0 m-auto drop-shadow" />}
                  </button>
                );
              })}
            </div>
            <p className={helperClass}>Used for badges in the calendar and library when you have multiple telescopes.</p>
          </div>

          {/* ── Connection ───────────────────────────────────────── */}
          <SectionHeading isDark={isDark}>Connection</SectionHeading>

          {/* Seestar transport mode (SMB vs USB). Dwarf is local-only so we
              skip the selector for it; "other" is SMB-only by convention. */}
          {isSeestarKind && (
            <div>
              <label className={labelClass}>Connection</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTransportMode('smb')}
                  className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition ${
                    transportMode === 'smb'
                      ? (isDark ? 'bg-teal-500/15 border border-teal-500/50 text-teal-200' : 'bg-teal-50 border border-teal-300 text-teal-900')
                      : (isDark ? 'border border-slate-800 text-slate-400 hover:border-slate-700' : 'border border-slate-200 text-slate-600 hover:border-slate-300')
                  }`}
                >
                  <Network className="w-4 h-4" />
                  Wi-Fi (SMB)
                </button>
                <button
                  type="button"
                  onClick={() => setTransportMode('local')}
                  className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition ${
                    transportMode === 'local'
                      ? (isDark ? 'bg-teal-500/15 border border-teal-500/50 text-teal-200' : 'bg-teal-50 border border-teal-300 text-teal-900')
                      : (isDark ? 'border border-slate-800 text-slate-400 hover:border-slate-700' : 'border border-slate-200 text-slate-600 hover:border-slate-300')
                  }`}
                >
                  <Usb className="w-4 h-4" />
                  USB cable
                </button>
              </div>
              <p className={helperClass}>
                Wi-Fi reads files over the LAN. USB is faster and works without a network, when the eMMC is mounted as an external drive.
              </p>
            </div>
          )}

          {/* Local-path picker for Dwarf (USB-mounted storage) */}
          {isDwarfKind && (
            <DwarfLocalPathPicker
              localPath={localPath}
              setLocalPath={setLocalPath}
              inputClass={inputClass}
              labelClass={labelClass}
              helperClass={helperClass}
              isDark={isDark}
              autoFocus={!isEdit}
            />
          )}

          {/* Local-path picker for Seestar over USB */}
          {isSeestarKind && transportMode === 'local' && (
            <LocalPathPicker
              kind="seestar"
              localPath={localPath}
              setLocalPath={setLocalPath}
              onDriveSelected={d => setPickedDrive(d)}
              inputClass={inputClass}
              labelClass={labelClass}
              helperClass={helperClass}
              isDark={isDark}
              autoFocus={!isEdit}
            />
          )}

          {/* Hostname / IP + share + credentials (SMB only) */}
          {!isLocalKind && (
          <>
          <div>
            <label className={labelClass}>Hostname / IP Address</label>
            <input
              type="text"
              placeholder="192.168.1.100"
              value={hostname}
              onChange={e => setHostname(e.target.value)}
              className={inputClass}
              autoFocus={!isEdit}
            />
            <p className={helperClass}>For reliable connectivity, assign a static IP or DHCP reservation.</p>
          </div>

          {/* Advanced share settings — share name, username, password.
              Collapsed by default; the firmware-published defaults work for
              every stock Seestar. Auto-expands for "other" (where the user
              must configure these) and on edit when values diverge. */}
          <div className={`rounded-xl border ${isDark ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'}`}>
            <button
              type="button"
              onClick={() => setAdvancedShareOpen(o => !o)}
              className={`w-full flex items-center justify-between gap-2 px-4 py-3 text-sm font-medium ${
                isDark ? 'text-slate-300 hover:text-white' : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              <span className="flex items-center gap-2">
                <Settings2 className="w-4 h-4" />
                Advanced share settings
              </span>
              <span className="flex items-center gap-2">
                {!advancedShareOpen && (
                  <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {shareName || preset.shareName} · {username || preset.username || 'guest'}
                  </span>
                )}
                <ChevronDown className={`w-4 h-4 transition-transform ${advancedShareOpen ? 'rotate-180' : ''}`} />
              </span>
            </button>
            {advancedShareOpen && (
              <div className="px-4 pb-4 space-y-4">
                <div>
                  <label className={labelClass}>SMB Share Name</label>
                  <input
                    type="text"
                    placeholder={kind === 'other' ? 'e.g. Astronomy' : preset.shareName}
                    value={shareName}
                    onChange={e => setShareName(e.target.value)}
                    className={inputClass}
                  />
                  <p className={helperClass}>{preset.shareHelp}</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>Username</label>
                    <input
                      type="text"
                      placeholder={preset.username || 'guest'}
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Password</label>
                    <input
                      type="password"
                      placeholder={isEdit ? 'leave blank to keep existing' : '(optional)'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>

                {/* Device-identity tracking toggle. Lives in Advanced because
                    most users should leave it on; defaults true so SMB + USB
                    transports of the same telescope merge automatically. */}
                <div className={`flex items-start gap-3 pt-3 border-t ${isDark ? 'border-slate-800/70' : 'border-slate-200'}`}>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={trackDeviceIdentity}
                    onClick={() => setTrackDeviceIdentity(v => !v)}
                    className={`mt-0.5 relative inline-flex h-5 w-9 items-center rounded-full transition shrink-0 ${
                      trackDeviceIdentity ? 'bg-teal-500' : isDark ? 'bg-slate-700' : 'bg-slate-300'
                    }`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${
                      trackDeviceIdentity ? 'translate-x-[18px]' : 'translate-x-1'
                    }`} />
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                      Track this telescope across SMB and USB
                    </div>
                    <p className={helperClass}>
                      Writes a small hidden file (.nebulis.dat) to the device so reaching it over Wi-Fi or USB resolves to the same telescope. Disable if your firmware rejects unknown files or you'd rather we not write to the device. Files imported with this off use the per-profile dedup fallback.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Test Connection — adjacent to the SMB fields it tests. Verifies
              credentials reach the share before the user commits to saving. */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={!canTest}
              className={`inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 ${
                isDark
                  ? 'bg-teal-500/10 text-teal-400 hover:bg-teal-500/20 border border-teal-500/30'
                  : 'bg-teal-50 text-teal-700 hover:bg-teal-100 border border-teal-200'
              }`}
            >
              {testStatus === 'testing' ? (
                <RotateCw className="w-4 h-4 animate-spin" />
              ) : testStatus === 'error' ? (
                <WifiOff className="w-4 h-4" />
              ) : (
                <Wifi className="w-4 h-4" />
              )}
              Test Connection
            </button>
            {testStatus === 'success' && (
              <div className={`px-3 py-2 rounded-lg text-xs ${
                isDark ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-emerald-50 text-emerald-700 border border-emerald-100'
              }`}>
                {testMessage}
              </div>
            )}
            {testStatus === 'error' && (
              <div className={`px-3 py-2 rounded-lg text-xs ${
                isDark ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-red-50 text-red-700 border border-red-100'
              }`}>
                {testMessage}
              </div>
            )}
          </div>
          </>
          )}

          {/* ── Import behavior ──────────────────────────────────── */}
          <SectionHeading isDark={isDark}>Import behavior</SectionHeading>

          {/* Auto-import toggle + interval */}
          <div className="flex items-start gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={autoImportEnabled}
              onClick={() => setAutoImportEnabled(v => !v)}
              className={`mt-1 relative inline-flex h-5 w-9 items-center rounded-full transition ${
                autoImportEnabled
                  ? 'bg-teal-500'
                  : isDark ? 'bg-slate-700' : 'bg-slate-300'
              }`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition ${
                autoImportEnabled ? 'translate-x-[18px]' : 'translate-x-1'
              }`} />
            </button>
            <div className="flex-1">
              <div className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                {kind === 'other' ? 'Auto-import from this SMB Share' : 'Auto-import from this telescope'}
              </div>
              <p className={helperClass}>
                When off, the auto-import scheduler skips this telescope. You can still trigger imports manually.
              </p>
              {autoImportEnabled && (
                <div className="mt-2.5 flex items-center gap-2">
                  <label className={`text-xs whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    Check every
                  </label>
                  <select
                    value={autoImportInterval}
                    onChange={e => setAutoImportInterval(Number(e.target.value))}
                    className={`border rounded-lg px-2 py-1 text-xs outline-none transition ${inputClass}`}
                  >
                    <option value={5}>5 minutes</option>
                    <option value={15}>15 minutes</option>
                    <option value={30}>30 minutes</option>
                    <option value={60}>1 hour</option>
                    <option value={120}>2 hours</option>
                    <option value={360}>6 hours</option>
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* Per-telescope file-type filters. Each scope decides which kinds
              of files the importer pulls off it — useful when one telescope
              has a big eMMC and you want everything, and another is on a
              smaller disk where subframes would burn through storage. */}
          <div className="space-y-1.5">
            <div className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              Files to import from this telescope
            </div>
            <p className={helperClass}>
              Applies whenever this telescope is imported, manually or on schedule.
            </p>
            <div className="space-y-2 pt-1">
              <FileTypeToggle
                label="Stacked images (.jpg)"
                description="Final stacked JPG images. The main library content."
                checked={importJpg}
                onChange={setImportJpg}
                isDark={isDark}
              />
              <FileTypeToggle
                label="Thumbnails (_thn.jpg)"
                description="Small previews used for gallery cards."
                checked={importThumbnails}
                onChange={setImportThumbnails}
                isDark={isDark}
              />
              <FileTypeToggle
                label="Stacked FITS (.fit)"
                description="The stacked FITS file per session. Larger, needed for quality scoring."
                checked={importFits}
                onChange={setImportFits}
                isDark={isDark}
              />
              <FileTypeToggle
                label="Sub-frames (.fit)"
                description="Individual .fit exposure frames only. Very large, hundreds of files per session."
                checked={importSubFrames}
                onChange={setImportSubFrames}
                isDark={isDark}
              />
              <FileTypeToggle
                label="Videos (.avi, .mp4)"
                description="Lunar and planetary video captures."
                checked={importVideos}
                onChange={setImportVideos}
                isDark={isDark}
              />
            </div>
          </div>

          {/* Custom layout help — only when kind is "other" */}
          {kind === 'other' && (
            <div className={`rounded-xl border ${isDark ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'}`}>
              <button
                onClick={() => setShowOtherHelp(s => !s)}
                className={`w-full flex items-center justify-between gap-2 px-4 py-3 text-sm font-medium ${
                  isDark ? 'text-slate-300 hover:text-white' : 'text-slate-700 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-2">
                  <HelpCircle className="w-4 h-4" />
                  Generic SMB Layout: folder format the import expects
                </span>
                <span className="text-xs opacity-70">{showOtherHelp ? 'Hide' : 'Show'}</span>
              </button>
              {showOtherHelp && (
                <div className={`px-4 pb-4 text-xs leading-relaxed space-y-3 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  <p>
                    For non-SeeStar / non-Dwarf shares, organize your files like this on the SMB share root:
                  </p>
                  <pre className={`overflow-x-auto p-3 rounded-lg ${isDark ? 'bg-slate-900 text-slate-300' : 'bg-white text-slate-700'} border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>{`<share root>/
├── M31/                              ← one folder per object (catalog id or common name)
│   ├── 2026-04-26_2030/              ← session folder: <YYYY-MM-DD>_<HHMM>
│   │   ├── lights/                   ← stacked or single-shot finals (required)
│   │   │   ├── M31_stacked.fit
│   │   │   └── M31_stacked.jpg
│   │   ├── subframes/                ← individual sub-frames (optional)
│   │   │   ├── M31_001.fit
│   │   │   └── M31_002.fit
│   │   └── meta.json                 ← optional per-session metadata
│   └── 2026-05-03_2115/
│       └── lights/...
├── NGC1788/
│   └── 2026-04-15_2200/
│       └── lights/...`}</pre>
                  <div>
                    <p className="font-semibold mb-1">Rules the importer cares about:</p>
                    <ul className="list-disc pl-4 space-y-1">
                      <li><strong>Object folder name</strong> = catalog id (<code>M31</code>, <code>NGC1788</code>, <code>IC1805</code>) or a common name (<code>Andromeda</code>, <code>Heart</code>). Catalog ids resolve to better metadata.</li>
                      <li><strong>Session folder</strong> = <code>YYYY-MM-DD_HHMM</code> in local time. The date drives the calendar view; the time disambiguates multiple sessions in one night.</li>
                      <li><strong><code>lights/</code> is required:</strong> at least one stacked or single image (.fit / .fits / .jpg / .png).</li>
                      <li><strong><code>subframes/</code> is optional:</strong> used for quality scoring and per-frame review.</li>
                      <li><strong><code>meta.json</code> is optional:</strong> JSON with <code>exposureSec</code>, <code>gain</code>, <code>filter</code>, <code>frameCount</code>, <code>integrationSec</code>. Anything missing is inferred from filenames or left blank.</li>
                      <li>Filenames are flexible. Anything ending in a recognized extension under <code>lights/</code> or <code>subframes/</code> is picked up.</li>
                    </ul>
                  </div>
                  <p className="opacity-80">
                    The importer skips object folders with no <code>lights/</code> subfolder, so partial uploads won't pollute your library.
                  </p>
                </div>
              )}
            </div>
          )}

          {mutation.isError && (
            <div className={`px-3 py-2 rounded-lg text-xs ${
              isDark ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-red-50 text-red-700 border border-red-100'
            }`}>
              {mutation.error instanceof Error ? mutation.error.message : `Failed to ${isEdit ? 'update' : 'create'} telescope`}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`flex items-center justify-end gap-3 px-6 py-4 border-t ${
          isDark ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <button
            onClick={() => onClose()}
            disabled={mutation.isPending}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 ${
              isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
            }`}
          >
            Cancel
          </button>
          <button
            onClick={() => { if (isEdit) mutation.mutate(); else void handleAdd(); }}
            disabled={!canSave || probing}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {(saveBusy || probing) && <RotateCw className="w-4 h-4 animate-spin" />}
            {isEdit ? 'Save Changes' : 'Add Telescope'}
          </button>
        </div>

        {/* Merge prompt — appears when probe-identity finds this device is
            already paired to an existing profile. Confirming adds the new
            transport to that profile instead of creating a duplicate. */}
        {mergeCandidate && (
          <div className={`absolute inset-0 flex items-center justify-center p-4 ${isDark ? 'bg-slate-950/70' : 'bg-slate-900/30'} backdrop-blur-sm`}>
            <div className={`max-w-md w-full p-6 rounded-2xl shadow-xl ${isDark ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'}`}>
              <h4 className={`font-display font-semibold text-base mb-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>
                Same telescope as {mergeCandidate.profileName}?
              </h4>
              <p className={`text-sm mb-4 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                This device is already paired to your telescope {mergeCandidate.profileName}. Add this connection to it so files don't import twice.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setMergeCandidate(null)}
                  className={`px-3 py-2 rounded-lg text-sm ${isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}
                >
                  Cancel
                </button>
                <button
                  onClick={() => { setMergeCandidate(null); createMutation.mutate(); }}
                  className={`px-3 py-2 rounded-lg text-sm ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}
                >
                  Create new anyway
                </button>
                <button
                  onClick={() => attachToExistingMutation.mutate(mergeCandidate.profileId)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600"
                >
                  {attachToExistingMutation.isPending && <RotateCw className="w-4 h-4 animate-spin" />}
                  Add to {mergeCandidate.profileName}
                </button>
              </div>
            </div>
          </div>
        )}
    </Modal>
  );
}

/** Section heading inside the modal body. Three of these (Identity,
 *  Connection, Import behavior) walk the user through the form in order
 *  without making it feel like a wall of fields. */
function SectionHeading({ isDark, children }: { isDark: boolean; children: React.ReactNode }) {
  return (
    <div className={`text-xs font-semibold uppercase tracking-wider pb-1 border-b ${
      isDark ? 'text-slate-500 border-slate-800/70' : 'text-slate-400 border-slate-200'
    }`}>
      {children}
    </div>
  );
}

