import { useState, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, RotateCw, HelpCircle, Telescope as TelescopeIcon, Check, Wifi, WifiOff, Usb, Network, Settings2, ChevronDown, Frame, Radar, Pin, Pencil, Trash2, Plus, ArrowLeft, ArrowRight } from 'lucide-react';
import { HelpBlockText } from '../ui/HelpBlockText';
import {
  createTelescope,
  updateTelescope,
  testTelescopeConnection,
  probeTransportIdentity,
  scanForDevices,
  type FoundDevice,
  addProfileTransport,
  listTelescopes,
  addTelescopeOpticalConfig,
  updateTelescopeOpticalConfig,
  deleteTelescopeOpticalConfig,
  type TelescopeProfile,
  type TelescopeOpticalConfig,
  type OpticalConfigInput,
  type DetectedDrive,
  type ConnectionType,
} from '../../lib/api/telescopes';
import { DwarfLocalPathPicker } from '../ui/DwarfLocalPathPicker';
import { LocalPathPicker } from '../ui/LocalPathPicker';
import {
  TELESCOPE_PRESETS,
  TELESCOPE_KINDS,
  DEFAULT_COLOR_BY_KIND,
  TELESCOPE_COLOR_PALETTE,
  modelToKind,
  toTelescopeKind,
  isDwarfKind as isDwarfTelescopeKind,
  isSeestarKind as isSeestarTelescopeKind,
  isAsiairKind as isAsiairTelescopeKind,
  type TelescopeKind,
} from '../../lib/telescopePresets';
import { shareNameError } from '../../lib/shareName';
import { hostAddressError } from '../../lib/hostAddress';
import { getInputClass, getLabelClass, getHelperClass } from './SettingsUI';
import { Modal } from '../ui/Modal';
import { FileTypeToggle } from '../ui/FileTypeToggle';
import { TelescopePhotoEditor } from './TelescopePhotoEditor';

/** The generic folder layout drawn in the "Other telescope" help panel. Each
 *  line may carry an i18n key for the trailing `← comment`. */
const GENERIC_LAYOUT_TREE: ReadonlyArray<{ text: string; commentKey?: string }> = [
  { text: '<share root>/' },
  { text: '├── M31/', commentKey: 'addTelescopeModal.genericLayoutTree.objectFolder' },
  { text: '│   ├── 2026-04-26_2030/', commentKey: 'addTelescopeModal.genericLayoutTree.sessionFolder' },
  { text: '│   │   ├── lights/', commentKey: 'addTelescopeModal.genericLayoutTree.lights' },
  { text: '│   │   │   ├── M31_stacked.fit' },
  { text: '│   │   │   └── M31_stacked.jpg' },
  { text: '│   │   ├── subframes/', commentKey: 'addTelescopeModal.genericLayoutTree.subframes' },
  { text: '│   │   │   ├── M31_001.fit' },
  { text: '│   │   │   └── M31_002.fit' },
  { text: '│   │   └── meta.json', commentKey: 'addTelescopeModal.genericLayoutTree.metaJson' },
  { text: '│   └── 2026-05-03_2115/' },
  { text: '│       └── lights/...' },
  { text: '├── NGC1788/' },
  { text: '│   └── 2026-04-15_2200/' },
  { text: '│       └── lights/...' },
];

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
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const inputClass = getInputClass(isDark);
  const labelClass = getLabelClass(isDark);
  const helperClass = getHelperClass(isDark);
  const isEdit = !!existing;
  // Adding walks through three short steps with Back / Next. Editing shows the
  // same three parts as tabs, so any one setting is a single click away.
  const wizard = !isEdit;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const show = (n: 1 | 2 | 3) => step === n;

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
  const [importFits, setImportFits] = useState(existing?.importFits ?? true);
  const [importThumbnails, setImportThumbnails] = useState(existing?.importThumbnails ?? false);
  // ASIAIR writes no stacked result unless the user ran Live mode, so its
  // entire output is light frames, which are sub-frames. Left off, a correctly
  // configured ASIAIR would import nothing at all. Mirrors the server-side
  // default in createProfile (server/lib/telescopes.ts).
  const [importSubFrames, setImportSubFrames] = useState(
    existing?.importSubFrames ?? initialKind === 'asiair',
  );
  const [archiveAllFiles, setArchiveAllFiles] = useState(existing?.archiveAllFiles ?? false);
  // On by default: calibration frames have nowhere else to go, and Dwarf and
  // ASIAIR have always been copied. Mirrors the server default.
  const [syncCalibrationFrames, setSyncCalibrationFrames] = useState(existing?.syncCalibrationFrames ?? true);
  const [importVideos, setImportVideos] = useState(existing?.importVideos ?? false);
  // Toggle for the hidden `.nebulis.dat` device-tracking file. On by default
  // so SMB + USB transports of the same telescope merge into one logical
  // device; user can opt out from inside Advanced share settings.
  const [trackDeviceIdentity, setTrackDeviceIdentity] = useState(existing?.trackDeviceIdentity ?? true);
  const [showOtherHelp, setShowOtherHelp] = useState(false);
  // Local-fs path for USB-mounted telescopes (eMMC over USB). Both Dwarf and
  // Seestar can pick between a network transport and USB.
  const [localPath, setLocalPath] = useState(existing?.localPath ?? '');
  const isDwarfKind = isDwarfTelescopeKind(kind);
  const isSeestarKind = isSeestarTelescopeKind(kind);
  const isAsiairKind = isAsiairTelescopeKind(kind);
  // No known FOV_PROFILES entry for these kinds — the only ones where an
  // optical configuration can actually change anything (see resolveFov in
  // telescopeFov.ts). Configs are managed only once the profile exists (see
  // OpticalConfigsEditor below), so this only matters in edit mode.
  const showOptics = kind === 'other' || isAsiairKind;
  // Transport mode picks which set of inputs to render and which connection
  // type to save on the profile. Dwarf gets FTP (its only network interface)
  // or USB; everything else, ASIAIR included, gets SMB or USB. Edits seed from
  // the saved value.
  const [transportMode, setTransportMode] = useState<ConnectionType>(() => {
    if (existing) return existing.connectionType;
    return isDwarfKind ? 'ftp' : 'smb';
  });
  const isLocalKind = transportMode === 'local';
  const isFtpMode = transportMode === 'ftp';
  /** The network transport this kind offers. Dwarf serves FTP and no SMB
   *  share at all; everything else is SMB. */
  const networkMode: ConnectionType = isDwarfKind ? 'ftp' : 'smb';
  // Tracks the drive picked from the LocalPathPicker so the merge prompt can
  // skip a redundant probe when the row already advertises an existing pairing.
  const [pickedDrive, setPickedDrive] = useState<DetectedDrive | null>(null);
  // Merge prompt state. When probe-identity finds an existing profile owning
  // this device, we present a confirm modal before creating a duplicate.
  // "Find device": sweeps the server's LAN and lists what looks like a
  // SeeStar / ASIAIR / Dwarf. Picking one fills the address (and the type).
  const scanMutation = useMutation({ mutationFn: scanForDevices });
  const pickFound = (d: FoundDevice) => {
    setHostname(d.host);
    if (!isEdit) setKind(toTelescopeKind(d.kind));
  };
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
      // The address field is never auto-filled, even for Dwarf's fixed
      // AP-mode IP: the placeholder hints at it, but the user must type it
      // themselves so a wrong/stale address is never silently submitted.
    }
    setColor(DEFAULT_COLOR_BY_KIND[kindMemo]);
    // Dwarf serves FTP over Wi-Fi and no SMB share; everything else is SMB.
    // Both keep USB as the alternative, which the user picks explicitly.
    if (!isEdit && isDwarfTelescopeKind(kindMemo)) {
      setTransportMode('ftp');
    } else if (!isEdit && (isSeestarTelescopeKind(kindMemo) || isAsiairTelescopeKind(kindMemo))) {
      setTransportMode('smb');
    }
    // Follow the sub-frame default for the newly picked kind, for the reason
    // spelled out where the state is declared: ASIAIR needs it on to import
    // anything, every other kind is better off with it left alone.
    if (!isEdit) setImportSubFrames(isAsiairTelescopeKind(kindMemo));
    // "other" needs a custom share configured, so surface the advanced
    // section automatically. Switching to a known preset re-collapses it.
    if (kindMemo === 'other') setAdvancedShareOpen(true);
    else if (!isEdit) setAdvancedShareOpen(false);
    setAppliedKind(kindMemo);
  }

  // Adding offers three presets instead of six switches. Thumbnails come only
  // with Everything (Nebulis draws its own); videos stay a separate switch.
  const importPreset: ImportPreset = archiveAllFiles ? 'everything' : importSubFrames ? 'subframes' : 'images';
  const recommendedPreset: ImportPreset = isAsiairKind ? 'subframes' : 'images';
  const chooseImportPreset = (id: ImportPreset) => {
    setImportJpg(true);
    setImportFits(true);
    setImportSubFrames(id !== 'images');
    setArchiveAllFiles(id === 'everything');
    setImportThumbnails(id === 'everything');
  };

  const createMutation = useMutation({
    mutationFn: () => createTelescope({
      // Never bake the raw local filesystem path into the default name — it
      // leaks a folder path (and whatever username is in it) into every place
      // the telescope name is displayed (session headers, TV hero subtitle).
      // A bare transport mechanism ("USB") isn't worth appending either — it's
      // not identifying information, just noise on every display surface. A
      // hostname is a real network address though, so that still helps
      // disambiguate two profiles of the same model and stays.
      name: name.trim() || `${preset.label}${!isLocalKind && hostname ? ` (${hostname})` : ''}`,
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
      connectionType: transportMode,
      localPath: localPath.trim(),
      importJpg,
      importFits,
      importThumbnails,
      importSubFrames,
      archiveAllFiles,
      syncCalibrationFrames,
      importVideos: importVideos || archiveAllFiles,
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

  // Connection fields for the currently selected transport mode. USB carries
  // only a path; FTP carries a host (and optional credentials, though the
  // Dwarf's FTP server is anonymous); SMB carries the full share tuple.
  const transportPayload = (): {
    kind: ConnectionType;
    hostname: string;
    shareName: string;
    username: string;
    password: string;
    localPath: string;
  } => {
    if (isLocalKind) {
      return { kind: 'local', hostname: '', shareName: '', username: '', password: '', localPath: localPath.trim() };
    }
    if (isFtpMode) {
      return { kind: 'ftp', hostname: hostname.trim(), shareName: '', username: username.trim(), password, localPath: '' };
    }
    return {
      kind: 'smb',
      hostname: hostname.trim(),
      shareName: shareName.trim(),
      username: username.trim(),
      password,
      localPath: '',
    };
  };

  // "Attach to existing" mutation, used when the merge prompt confirms that
  // this transport belongs to an already-known telescope. We add the transport
  // to that profile instead of creating a duplicate.
  const attachToExistingMutation = useMutation({
    mutationFn: (profileId: string) =>
      addProfileTransport(profileId, transportPayload()),
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
        connectionType: transportMode,
        localPath: localPath.trim(),
        importJpg,
        importFits,
        importThumbnails,
        importSubFrames,
        archiveAllFiles,
        syncCalibrationFrames,
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
  // Only meaningful for SMB: FTP has no share and USB has no host. The server
  // rejects the same values on write, so this is purely to fail fast.
  const shareError = !isLocalKind && !isFtpMode ? shareNameError(shareName) : null;
  // A USB telescope has no address; every other transport must have a real one.
  // This catches the host and share pasted together as "10.0.1.5/SeeStar/",
  // which saved fine and then failed every connection.
  const hostError = isLocalKind ? null : hostAddressError(hostname);
  const canSave = !saveBusy && !shareError && !hostError && (
    isLocalKind
      ? localPath.trim().length > 0
      // FTP needs only an address: the Dwarf's server is anonymous and the
      // storage root is auto-detected. SMB additionally needs a share name.
      : isFtpMode
        ? hostname.trim().length > 0
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
        transport: transportPayload(),
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
        connectionType: transportMode,
      });
      if (result.connected) {
        setTestStatus('success');
        const found = t('addTelescopeModal.connectedFound', {
          count: result.objectCount ?? 0,
          unit: isFtpMode ? t('addTelescopeModal.unitSession') : t('addTelescopeModal.unitObject'),
        });
        // The Dwarf models each serve their storage under a different prefix,
        // so tell the user which layout was detected. It is the fastest way to
        // spot a wrong model selection.
        setTestMessage(isFtpMode && result.remoteRoot ? `${found} ${t('addTelescopeModal.storageRootSuffix', { root: result.remoteRoot })}` : found);
      } else {
        setTestStatus('error');
        setTestMessage(result.error || t('addTelescopeModal.connectionFailed'));
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : t('addTelescopeModal.connectionFailed'));
    }
  };
  // Connection test covers the network transports only — there's nothing
  // analogous to an auth handshake for a local filesystem mount, where
  // fs.stat at save time is the closest equivalent.
  const canTest = !isLocalKind
    && hostname.trim().length > 0
    && (isFtpMode || shareName.trim().length > 0)
    && !shareError
    && !hostError
    && testStatus !== 'testing';

  return (
    <Modal
      isOpen
      onClose={() => { if (!mutation.isPending) onClose(); }}
      title={isEdit ? (existing?.name ? t('addTelescopeModal.editTitle', { name: existing.name }) : t('addTelescopeModal.editTitleFallback')) : t('addTelescopeModal.addTitle')}
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
              {isEdit ? (existing?.name ? t('addTelescopeModal.editTitle', { name: existing.name }) : t('addTelescopeModal.editTitleFallback')) : t('addTelescopeModal.addTitle')}
            </h3>
          </div>
          <button
            onClick={() => onClose()}
            disabled={mutation.isPending}
            className={`p-1.5 rounded-lg transition disabled:opacity-50 ${
              isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
            }`}
            aria-label={t('addTelescopeModal.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body. Sections walk the user through three questions: what is this
            telescope, how do we reach it, and what should we do with it. */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6">
          {wizard ? (
            <StepIndicator step={step} isDark={isDark} />
          ) : (
            <EditTabs step={step} onChange={setStep} isDark={isDark} errorSteps={[hostError || shareError ? 2 : null]} />
          )}

          {/* ── Step 1: Identity ─────────────────────────────────── */}
          {show(1) && (
          <div className="space-y-6">
          <StepHeading isDark={isDark} wizard={wizard} title={t('addTelescopeModal.step1Title')} />

          {/* Telescope kind */}
          <div>
            <label className={labelClass}>{t('addTelescopeModal.telescopeType')}</label>
            <select
              value={kind}
              onChange={e => setKind(toTelescopeKind(e.target.value))}
              className={inputClass}
            >
              {TELESCOPE_KINDS.map(k => (
                <option key={k} value={k}>{TELESCOPE_PRESETS[k].label}</option>
              ))}
            </select>
            <p className={helperClass}>{t('addTelescopeModal.telescopeTypeHelp')}</p>
          </div>

          {/* Friendly name (optional) */}
          <div>
            <label className={labelClass}>{t('addTelescopeModal.displayName')} <span className="opacity-60">{t('addTelescopeModal.optional')}</span></label>
            <input
              type="text"
              placeholder={preset.label}
              value={name}
              onChange={e => setName(e.target.value)}
              className={inputClass}
            />
            <p className={helperClass}>{t('addTelescopeModal.displayNameHelp')}</p>
          </div>

          {/* Badge color — visual identity, grouped with name + type. */}
          <div>
            <label className={labelClass}>{t('addTelescopeModal.badgeColor')}</label>
            <div className="flex items-center gap-2 flex-wrap">
              {TELESCOPE_COLOR_PALETTE.map(c => {
                const selected = c.toLowerCase() === color.toLowerCase();
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    aria-label={t('addTelescopeModal.pickColor', { color: c })}
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
            <p className={helperClass}>{t('addTelescopeModal.badgeColorHelp')}</p>
          </div>

          </div>
          )}

          {/* ── Step 2: Connection ───────────────────────────────── */}
          {show(2) && (
          <div className="space-y-6">
          <StepHeading isDark={isDark} wizard={wizard} title={t('addTelescopeModal.step2Title')} />

          {/* Transport mode (network vs USB). "other" is SMB-only by
              convention so it skips the selector. The network option differs
              per vendor: Seestar publishes an SMB share, Dwarf runs an FTP
              server and no SMB at all. */}
          {(isSeestarKind || isDwarfKind || isAsiairKind) && (
            <div>
              <label className={labelClass}>{t('addTelescopeModal.connectionLabel')}</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTransportMode(networkMode)}
                  className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition ${
                    transportMode === networkMode
                      ? (isDark ? 'bg-teal-500/15 border border-teal-500/50 text-teal-200' : 'bg-teal-50 border border-teal-300 text-teal-900')
                      : (isDark ? 'border border-slate-800 text-slate-400 hover:border-slate-700' : 'border border-slate-200 text-slate-600 hover:border-slate-300')
                  }`}
                >
                  <Network className="w-4 h-4" />
                  {isDwarfKind ? t('addTelescopeModal.wifiFtp') : t('addTelescopeModal.wifiSmb')}
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
                  {t('addTelescopeModal.usbCable')}
                </button>
              </div>
              <p className={helperClass}>
                {isDwarfKind
                  ? t('addTelescopeModal.transportHelpDwarf')
                  : isAsiairKind
                    ? t('addTelescopeModal.transportHelpAsiair')
                    : t('addTelescopeModal.transportHelpDefault')}
              </p>
            </div>
          )}

          {/* Local-path picker for Dwarf (USB-mounted storage) */}
          {isDwarfKind && isLocalKind && (
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

          {/* Local-path picker for ASIAIR removable storage */}
          {isAsiairKind && transportMode === 'local' && (
            <LocalPathPicker
              kind="asiair"
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
            <label className={labelClass}>{t('addTelescopeModal.hostnameLabel')}</label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder={preset.defaultHostname || '192.168.1.100'}
                value={hostname}
                onChange={e => setHostname(e.target.value)}
                className={inputClass}
                autoFocus={!isEdit}
                aria-invalid={!!hostError}
              />
              <button
                type="button"
                onClick={() => scanMutation.mutate()}
                disabled={scanMutation.isPending}
                className={`shrink-0 inline-flex items-center gap-2 px-3 rounded-lg border text-sm font-medium disabled:opacity-60 ${
                  isDark ? 'border-slate-700 text-slate-200 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                <Radar className={`w-4 h-4 ${scanMutation.isPending ? 'animate-pulse' : ''}`} />
                {scanMutation.isPending ? t('addTelescopeModal.findDeviceScanning') : t('addTelescopeModal.findDevice')}
              </button>
            </div>
            {scanMutation.isError && (
              <p className={`text-xs mt-1 ${isDark ? 'text-red-400' : 'text-red-600'}`}>{t('addTelescopeModal.findDeviceFailed')}</p>
            )}
            {scanMutation.data && scanMutation.data.devices.length === 0 && (
              <p className={helperClass}>
                {scanMutation.data.subnets.length === 0
                  ? t('addTelescopeModal.findDeviceNoNetwork')
                  : t('addTelescopeModal.findDeviceNone', { subnets: scanMutation.data.subnets.join(', ') })}
              </p>
            )}
            {scanMutation.data && scanMutation.data.devices.length > 0 && (
              <div className="mt-2 space-y-1">
                <p className={helperClass}>{t('addTelescopeModal.findDevicePick', { count: scanMutation.data.devices.length })}</p>
                {scanMutation.data.devices.map(d => (
                  <button
                    key={d.host}
                    type="button"
                    onClick={() => pickFound(d)}
                    className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg border text-sm text-left ${
                      hostname.trim() === d.host
                        ? (isDark ? 'border-sky-500 bg-sky-500/10 text-white' : 'border-sky-500 bg-sky-50 text-slate-900')
                        : (isDark ? 'border-slate-700 text-slate-200 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-100')
                    }`}
                  >
                    <span className="font-medium">{d.label}</span>
                    <span className="opacity-70 tabular-nums">{d.name ?? d.host}{d.name ? ` · ${d.host}` : ''}</span>
                  </button>
                ))}
              </div>
            )}
            {hostError
              ? <p className={`text-xs mt-1 ${isDark ? 'text-red-400' : 'text-red-600'}`}>{hostError}</p>
              : (
                isFtpMode && preset.addressHelp
                  ? <HelpBlockText block={preset.addressHelp} className={helperClass} />
                  : <p className={helperClass}>{t('addTelescopeModal.hostnameHelp')}</p>
              )}
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
                {isFtpMode ? t('addTelescopeModal.advancedConnectionSettings') : t('addTelescopeModal.advancedShareSettings')}
              </span>
              <span className="flex items-center gap-2">
                {!advancedShareOpen && (
                  <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {isFtpMode
                      ? t('addTelescopeModal.advancedSummaryFtp', { username: username || t('addTelescopeModal.anonymous') })
                      : t('addTelescopeModal.advancedSummarySmb', { share: shareName || preset.shareName, username: username || preset.username || t('addTelescopeModal.guest') })}
                  </span>
                )}
                <ChevronDown className={`w-4 h-4 transition-transform ${advancedShareOpen ? 'rotate-180' : ''}`} />
              </span>
            </button>
            {advancedShareOpen && (
              <div className="px-4 pb-4 space-y-4">
                {/* FTP has no share concept, and the Dwarf storage root is
                    detected automatically, so there is nothing to fill in. */}
                {!isFtpMode && (
                  <div>
                    <label className={labelClass}>{t('addTelescopeModal.smbShareName')}</label>
                    <input
                      type="text"
                      placeholder={kind === 'other' ? t('addTelescopeModal.sharePlaceholderOther') : preset.shareName}
                      value={shareName}
                      onChange={e => setShareName(e.target.value)}
                      className={inputClass}
                      aria-invalid={!!shareError}
                    />
                    {shareError
                      ? <p className={`text-xs mt-1 ${isDark ? 'text-red-400' : 'text-red-600'}`}>{shareError}</p>
                      : preset.shareHelp && <HelpBlockText block={preset.shareHelp} className={helperClass} />}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>{t('addTelescopeModal.username')}</label>
                    <input
                      type="text"
                      placeholder={isFtpMode ? t('addTelescopeModal.usernamePlaceholderFtp') : (preset.username || t('addTelescopeModal.usernamePlaceholderDefault'))}
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>{t('addTelescopeModal.password')}</label>
                    <input
                      type="password"
                      placeholder={isEdit ? t('addTelescopeModal.passwordPlaceholderEdit') : t('addTelescopeModal.passwordPlaceholderCreate')}
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
                      {t('addTelescopeModal.trackIdentityLabel')}
                    </div>
                    <p className={helperClass}>
                      {t('addTelescopeModal.trackIdentityHelp')}
                      {isFtpMode && ` ${t('addTelescopeModal.trackIdentityFtpNote')}`}
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
              {t('addTelescopeModal.testConnection')}
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
                  {t('addTelescopeModal.genericLayoutTitle')}
                </span>
                <span className="text-xs opacity-70">{showOtherHelp ? t('addTelescopeModal.hide') : t('addTelescopeModal.show')}</span>
              </button>
              {showOtherHelp && (
                <div className={`px-4 pb-4 text-xs leading-relaxed space-y-3 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  <p>
                    {t('addTelescopeModal.genericLayoutIntro')}
                  </p>
                  <pre className={`overflow-x-auto p-3 rounded-lg ${isDark ? 'bg-slate-900 text-slate-300' : 'bg-white text-slate-700'} border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                    {GENERIC_LAYOUT_TREE.map((line, i) => (
                      <div key={i}>{line.commentKey ? `${line.text}  ← ${t(line.commentKey)}` : line.text}</div>
                    ))}
                  </pre>
                  <div>
                    <p className="font-semibold mb-1">{t('addTelescopeModal.genericLayoutRulesTitle')}</p>
                    <ul className="list-disc pl-4 space-y-1">
                      <li><strong>{t('addTelescopeModal.genericLayoutRule1Bold')}</strong> {t('addTelescopeModal.genericLayoutRule1')}</li>
                      <li><strong>{t('addTelescopeModal.genericLayoutRule2Bold')}</strong> {t('addTelescopeModal.genericLayoutRule2')}</li>
                      <li><strong>{t('addTelescopeModal.genericLayoutRule3Bold')}</strong> {t('addTelescopeModal.genericLayoutRule3')}</li>
                      <li><strong>{t('addTelescopeModal.genericLayoutRule4Bold')}</strong> {t('addTelescopeModal.genericLayoutRule4')}</li>
                      <li><strong>{t('addTelescopeModal.genericLayoutRule5Bold')}</strong> {t('addTelescopeModal.genericLayoutRule5')}</li>
                      <li>{t('addTelescopeModal.genericLayoutRule6')}</li>
                    </ul>
                  </div>
                  <p className="opacity-80">
                    {t('addTelescopeModal.genericLayoutFooter')}
                  </p>
                </div>
              )}
            </div>
          )}

          </div>
          )}

          {/* ── Step 3: Import behavior ──────────────────────────── */}
          {show(3) && (
          <div className="space-y-6">
          <StepHeading isDark={isDark} wizard={wizard} title={t('addTelescopeModal.step3Title')} />

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
                {kind === 'other' ? t('addTelescopeModal.autoImportOther') : t('addTelescopeModal.autoImportDefault')}
              </div>
              <p className={helperClass}>
                {t('addTelescopeModal.autoImportHelp')}
              </p>
              {autoImportEnabled && (
                <div className="mt-2.5 flex items-center gap-2">
                  <label className={`text-xs whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {t('addTelescopeModal.checkEvery')}
                  </label>
                  <select
                    value={autoImportInterval}
                    onChange={e => setAutoImportInterval(Number(e.target.value))}
                    className={`border rounded-lg px-2 py-1 text-xs outline-none transition ${inputClass}`}
                  >
                    <option value={5}>{t('addTelescopeModal.interval5')}</option>
                    <option value={15}>{t('addTelescopeModal.interval15')}</option>
                    <option value={30}>{t('addTelescopeModal.interval30')}</option>
                    <option value={60}>{t('addTelescopeModal.interval60')}</option>
                    <option value={120}>{t('addTelescopeModal.interval120')}</option>
                    <option value={360}>{t('addTelescopeModal.interval360')}</option>
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
              {t('addTelescopeModal.filesToImport')}
            </div>
            <p className={helperClass}>
              {t('addTelescopeModal.filesToImportHelp')}
            </p>
            {wizard ? (
              <div className="space-y-3 pt-1">
                <div role="radiogroup" aria-label={t('addTelescopeModal.filesToImport')} className="space-y-2">
                  {IMPORT_PRESETS.map(id => {
                    const selected = importPreset === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => chooseImportPreset(id)}
                        className={`w-full text-left rounded-xl border p-3.5 transition ${
                          selected
                            ? isDark ? 'border-accent-500 bg-accent-500/10' : 'border-accent-500 bg-accent-50'
                            : isDark ? 'border-slate-700 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-medium ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                            {t(`addTelescopeModal.presets.${id}.label`)}
                          </span>
                          {id === recommendedPreset && (
                            <span className={`text-[0.6875rem] font-medium px-1.5 py-0.5 rounded-full ${isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-100 text-emerald-700'}`}>
                              {t('addTelescopeModal.recommended')}
                            </span>
                          )}
                        </div>
                        <p className={helperClass}>{t(`addTelescopeModal.presets.${id}.description`)}</p>
                      </button>
                    );
                  })}
                </div>
                <FileTypeToggle
                  label={t('addTelescopeModal.fileTypes.videos.label')}
                  description={t('addTelescopeModal.fileTypes.videos.description')}
                  checked={importVideos || archiveAllFiles}
                  onChange={archiveAllFiles ? () => {} : setImportVideos}
                  isDark={isDark}
                />
              </div>
            ) : (
              <div className="space-y-2 pt-1">
                <FileTypeToggle
                  label={t('addTelescopeModal.fileTypes.stackedImages.label')}
                  description={t('addTelescopeModal.fileTypes.stackedImages.description')}
                  checked={importJpg}
                  onChange={setImportJpg}
                  isDark={isDark}
                />
                <FileTypeToggle
                  label={t('addTelescopeModal.fileTypes.thumbnails.label')}
                  description={t('addTelescopeModal.fileTypes.thumbnails.description')}
                  checked={importThumbnails}
                  onChange={setImportThumbnails}
                  isDark={isDark}
                />
                <FileTypeToggle
                  label={t('addTelescopeModal.fileTypes.stackedFits.label')}
                  description={t('addTelescopeModal.fileTypes.stackedFits.description')}
                  checked={importFits}
                  onChange={setImportFits}
                  isDark={isDark}
                />
                <FileTypeToggle
                  label={t('addTelescopeModal.fileTypes.subFrames.label')}
                  description={t('addTelescopeModal.fileTypes.subFrames.description')}
                  checked={importSubFrames}
                  onChange={setImportSubFrames}
                  isDark={isDark}
                />
                <FileTypeToggle
                  label={t('addTelescopeModal.fileTypes.videos.label')}
                  description={t('addTelescopeModal.fileTypes.videos.description')}
                  checked={importVideos}
                  onChange={setImportVideos}
                  isDark={isDark}
                />
                <FileTypeToggle
                  label={t('addTelescopeModal.fileTypes.archiveAll.label')}
                  description={t('addTelescopeModal.fileTypes.archiveAll.description')}
                  checked={archiveAllFiles}
                  onChange={setArchiveAllFiles}
                  isDark={isDark}
                />
              </div>
            )}
            <div className="pt-2">
              <FileTypeToggle
                label={t('addTelescopeModal.fileTypes.calibration.label')}
                description={t('addTelescopeModal.fileTypes.calibration.description')}
                checked={syncCalibrationFrames}
                onChange={setSyncCalibrationFrames}
                isDark={isDark}
              />
            </div>
          </div>

          {/* Optical configurations — only for kinds with no known fixed field
              of view. Lets the Framing & Mosaic FOV preview draw a real frame
              for a bare camera/lens rig, including a named entry per optical
              train (e.g. "Native" vs "0.8x Reducer") instead of only an
              unsaved, ad-hoc "Custom" entry picked fresh every preview.
              Configs attach to a profile id, so this only exists once one has
              been saved: the add flow leaves it out and the editor appears on
              the next Edit. */}
          {!wizard && existing && <TelescopePhotoEditor profile={existing} isDark={isDark} />}
          {!wizard && showOptics && existing && (
            <OpticalConfigsEditor
              profile={existing}
              isDark={isDark}
              inputClass={inputClass}
              labelClass={labelClass}
              helperClass={helperClass}
            />
          )}
          </div>
          )}

          {mutation.isError && (
            <div className={`px-3 py-2 rounded-lg text-xs ${
              isDark ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-red-50 text-red-700 border border-red-100'
            }`}>
              {mutation.error instanceof Error ? mutation.error.message : t('addTelescopeModal.saveFailed', { action: isEdit ? t('addTelescopeModal.actionUpdate') : t('addTelescopeModal.actionCreate') })}
            </div>
          )}
        </div>

        {/* Footer. Kept outside the scroll area so the way forward is always on
            screen. Adding: Back / Next, then Add on the last step. */}
        <div className={`shrink-0 flex items-center justify-between gap-3 px-6 py-4 border-t ${
          isDark ? 'border-slate-800' : 'border-slate-200'
        }`}>
          {wizard && step > 1 ? (
            <button
              type="button"
              onClick={() => setStep(step === 3 ? 2 : 1)}
              disabled={saveBusy || probing}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border transition disabled:opacity-50 ${
                isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <ArrowLeft className="w-4 h-4" />
              {t('addTelescopeModal.back')}
            </button>
          ) : (
            <button
              onClick={() => onClose()}
              disabled={mutation.isPending}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 ${
                isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
              }`}
            >
              {t('addTelescopeModal.cancel')}
            </button>
          )}

          {wizard && step < 3 ? (
            <button
              type="button"
              onClick={() => setStep(step === 1 ? 2 : 3)}
              disabled={step === 2 && !canSave}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('addTelescopeModal.next')}
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => { if (isEdit) mutation.mutate(); else void handleAdd(); }}
              disabled={!canSave || probing}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {(saveBusy || probing) && <RotateCw className="w-4 h-4 animate-spin" />}
              {isEdit ? t('addTelescopeModal.saveChanges') : t('addTelescopeModal.addTelescopeButton')}
            </button>
          )}
        </div>

        {/* Merge prompt — appears when probe-identity finds this device is
            already paired to an existing profile. Confirming adds the new
            transport to that profile instead of creating a duplicate. */}
        {mergeCandidate && (
          <div className={`absolute inset-0 flex items-center justify-center p-4 ${isDark ? 'bg-slate-950/70' : 'bg-slate-900/30'} backdrop-blur-sm`}>
            <div className={`max-w-md w-full p-6 rounded-2xl shadow-xl ${isDark ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'}`}>
              <h4 className={`font-display font-semibold text-base mb-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {t('addTelescopeModal.mergeTitle', { name: mergeCandidate.profileName })}
              </h4>
              <p className={`text-sm mb-4 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                {t('addTelescopeModal.mergeBody', { name: mergeCandidate.profileName })}
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setMergeCandidate(null)}
                  className={`px-3 py-2 rounded-lg text-sm ${isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}
                >
                  {t('addTelescopeModal.mergeCancel')}
                </button>
                <button
                  onClick={() => { setMergeCandidate(null); createMutation.mutate(); }}
                  className={`px-3 py-2 rounded-lg text-sm ${isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}
                >
                  {t('addTelescopeModal.mergeCreateNew')}
                </button>
                <button
                  onClick={() => attachToExistingMutation.mutate(mergeCandidate.profileId)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600"
                >
                  {attachToExistingMutation.isPending && <RotateCw className="w-4 h-4 animate-spin" />}
                  {t('addTelescopeModal.mergeAddTo', { name: mergeCandidate.profileName })}
                </button>
              </div>
            </div>
          </div>
        )}
    </Modal>
  );
}

/** Heading for one part of the form. Adding shows it as the step's question;
 *  editing has the tab bar for that, so it renders nothing. */
function StepHeading({ isDark, wizard, title }: {
  isDark: boolean;
  wizard: boolean;
  title: string;
}) {
  if (!wizard) return null;
  return (
    <h3 className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
      {title}
    </h3>
  );
}

type ImportPreset = 'images' | 'subframes' | 'everything';
const IMPORT_PRESETS: ImportPreset[] = ['images', 'subframes', 'everything'];

const STEP_KEYS = ['step1Name', 'step2Name', 'step3Name'] as const;

/** Edit mode's version of StepIndicator: the same three parts as free tabs. A
 *  dot marks a tab that holds a validation error, since Save is disabled and
 *  the offending field may be on another tab. */
function EditTabs({ step, onChange, isDark, errorSteps }: {
  step: 1 | 2 | 3;
  onChange: (n: 1 | 2 | 3) => void;
  isDark: boolean;
  errorSteps: Array<1 | 2 | 3 | null>;
}) {
  const { t } = useTranslation('settings');
  return (
    <div role="tablist" className={`flex p-1 rounded-xl gap-1 ${isDark ? 'bg-slate-800/60' : 'bg-slate-100'}`}>
      {STEP_KEYS.map((key, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const active = n === step;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(n)}
            className={`relative flex-1 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              active
                ? isDark ? 'bg-slate-700 text-white shadow-sm' : 'bg-white text-slate-900 shadow-sm'
                : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {t(`addTelescopeModal.${key}`)}
            {errorSteps.includes(n) && (
              <span aria-hidden className="absolute top-1.5 right-2 w-1.5 h-1.5 rounded-full bg-red-500" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function StepIndicator({ step, isDark }: { step: 1 | 2 | 3; isDark: boolean }) {
  const { t } = useTranslation('settings');
  return (
    <ol className="flex items-center justify-center gap-2" aria-label={t('addTelescopeModal.stepOf', { current: step, total: 3 })}>
      {STEP_KEYS.map((key, i) => {
        const n = i + 1;
        const done = n < step;
        const active = n === step;
        return (
          <li key={key} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
            <span
              className={`flex items-center justify-center w-5 h-5 rounded-full text-[0.6875rem] font-semibold ${
                active
                  ? 'bg-accent-500 text-white'
                  : done
                    ? isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-700'
                    : isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'
              }`}
            >
              {done ? '✓' : n}
            </span>
            <span className={`text-xs ${active ? (isDark ? 'text-slate-200 font-medium' : 'text-slate-800 font-medium') : isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t(`addTelescopeModal.${key}`)}
            </span>
            {n < 3 && <span aria-hidden className={`w-6 h-px ${isDark ? 'bg-slate-700' : 'bg-slate-300'}`} />}
          </li>
        );
      })}
    </ol>
  );
}

interface OpticalConfigFormState {
  name: string;
  focalLengthMm: string;
  sensorWidthMm: string;
  sensorHeightMm: string;
  pixelSizeUm: string;
}

function blankOpticalConfigForm(): OpticalConfigFormState {
  return { name: '', focalLengthMm: '', sensorWidthMm: '', sensorHeightMm: '', pixelSizeUm: '' };
}

function opticalConfigFormFrom(c: TelescopeOpticalConfig): OpticalConfigFormState {
  return {
    name: c.name,
    focalLengthMm: String(c.focalLengthMm),
    sensorWidthMm: String(c.sensorWidthMm),
    sensorHeightMm: String(c.sensorHeightMm),
    pixelSizeUm: c.pixelSizeUm != null ? String(c.pixelSizeUm) : '',
  };
}

/** `null` when the form isn't submittable — name and every dimension are
 *  required; pixel size stays optional (only drives the arcsec/pixel readout). */
function parseOpticalConfigForm(f: OpticalConfigFormState): OpticalConfigInput | null {
  const focalLengthMm = Number(f.focalLengthMm);
  const sensorWidthMm = Number(f.sensorWidthMm);
  const sensorHeightMm = Number(f.sensorHeightMm);
  if (!f.name.trim() || !(focalLengthMm > 0) || !(sensorWidthMm > 0) || !(sensorHeightMm > 0)) return null;
  const pixelSizeUm = f.pixelSizeUm.trim() !== '' ? Number(f.pixelSizeUm) : null;
  return {
    name: f.name.trim(),
    focalLengthMm, sensorWidthMm, sensorHeightMm,
    pixelSizeUm: pixelSizeUm != null && pixelSizeUm > 0 ? pixelSizeUm : null,
  };
}

/**
 * Manage the optical configurations ("Native", "0.8x Reducer", ...) on an
 * existing `other`/`asiair` telescope profile, for the Framing & Mosaic FOV
 * preview: add, edit, delete, and mark one as currently mounted
 * (`activeOpticalConfigId`). Only opened for a saved profile — configs
 * attach to a profile id, so a brand-new profile has nowhere to attach them
 * to yet (see the note AddTelescopeModal shows instead during create).
 *
 * Reads the profile fresh from the `['telescopes']` query rather than the
 * `profile` prop directly, so it reflects its own mutations without the
 * parent needing to re-derive `existing` on every keystroke elsewhere in the
 * form (mirrors ConnectionSection's `managingTransportsId`-by-id pattern).
 */
function OpticalConfigsEditor({
  profile, isDark, inputClass, labelClass, helperClass,
}: {
  profile: TelescopeProfile;
  isDark: boolean;
  inputClass: string;
  labelClass: string;
  helperClass: string;
}) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const { data: telescopes } = useQuery({ queryKey: ['telescopes'], queryFn: listTelescopes });
  const live = telescopes?.find(tel => tel.id === profile.id) ?? profile;
  const configs = live.opticalConfigs;
  const activeId = live.activeOpticalConfigId;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<OpticalConfigFormState>(blankOpticalConfigForm());
  const [formError, setFormError] = useState('');

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['telescopes'] });

  const activeMutation = useMutation({
    mutationFn: (activeOpticalConfigId: string | null) => updateTelescope(profile.id, { activeOpticalConfigId }),
    onSuccess: invalidate,
  });
  const addMutation = useMutation({
    mutationFn: (data: OpticalConfigInput) => addTelescopeOpticalConfig(profile.id, data),
    onSuccess: () => { invalidate(); setAdding(false); },
    onError: (err: Error) => setFormError(err.message),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: OpticalConfigInput }) => updateTelescopeOpticalConfig(profile.id, id, data),
    onSuccess: () => { invalidate(); setEditingId(null); },
    onError: (err: Error) => setFormError(err.message),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTelescopeOpticalConfig(profile.id, id),
    onSuccess: invalidate,
  });

  function startAdd() {
    setForm(blankOpticalConfigForm());
    setFormError('');
    setEditingId(null);
    setAdding(true);
  }
  function startEdit(c: TelescopeOpticalConfig) {
    setForm(opticalConfigFormFrom(c));
    setFormError('');
    setAdding(false);
    setEditingId(c.id);
  }
  function cancelForm() {
    setAdding(false);
    setEditingId(null);
    setFormError('');
  }
  function submitForm() {
    const parsed = parseOpticalConfigForm(form);
    if (!parsed) {
      setFormError(t('addTelescopeModal.configFormError'));
      return;
    }
    setFormError('');
    if (editingId) updateMutation.mutate({ id: editingId, data: parsed });
    else addMutation.mutate(parsed);
  }

  const canSubmit = parseOpticalConfigForm(form) !== null;

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${isDark ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex items-center gap-2">
        <Frame className="w-4 h-4 text-sky-500" />
        <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
          {t('addTelescopeModal.opticalConfigsTitle')} <span className="opacity-60 font-normal">{t('addTelescopeModal.optional')}</span>
        </span>
      </div>
      <p className={helperClass}>
        {t('addTelescopeModal.opticalConfigsHelp')}
      </p>

      <div className="space-y-2">
        {configs.map(cfg => {
          const isActive = cfg.id === activeId;
          const isEditingThis = editingId === cfg.id;
          return (
            <div key={cfg.id} className={`rounded-lg border overflow-hidden ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
              <div className={`flex items-center gap-3 px-3 py-2 ${isDark ? 'bg-slate-800/30' : 'bg-white'}`}>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    {cfg.name}
                    {isActive && (
                      <span className={`ml-1.5 text-[0.625rem] font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>{t('addTelescopeModal.activeLabel')}</span>
                    )}
                  </div>
                  <div className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {cfg.pixelSizeUm
                      ? t('addTelescopeModal.opticalConfigSummaryWithPixel', {
                          focal: cfg.focalLengthMm, width: cfg.sensorWidthMm, height: cfg.sensorHeightMm, pixel: cfg.pixelSizeUm,
                        })
                      : t('addTelescopeModal.opticalConfigSummary', {
                          focal: cfg.focalLengthMm, width: cfg.sensorWidthMm, height: cfg.sensorHeightMm,
                        })}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => activeMutation.mutate(cfg.id)}
                      disabled={activeMutation.isPending}
                      title={t('addTelescopeModal.markActiveTitle')}
                      className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-700 text-slate-400' : 'hover:bg-slate-200 text-slate-500'}`}
                    >
                      <Pin className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => (isEditingThis ? cancelForm() : startEdit(cfg))}
                    title={t('addTelescopeModal.editConfigTitle')}
                    className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-700 text-slate-400' : 'hover:bg-slate-200 text-slate-500'}`}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteMutation.mutate(cfg.id)}
                    disabled={deleteMutation.isPending}
                    title={t('addTelescopeModal.deleteConfigTitle')}
                    className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-red-500/10 text-slate-400 hover:text-red-400' : 'hover:bg-red-50 text-slate-500 hover:text-red-600'}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {isEditingThis && (
                <OpticalConfigForm
                  form={form}
                  setForm={setForm}
                  isDark={isDark}
                  inputClass={inputClass}
                  labelClass={labelClass}
                  error={formError}
                  onCancel={cancelForm}
                  onSubmit={submitForm}
                  canSubmit={canSubmit}
                  submitting={updateMutation.isPending}
                  submitLabel={t('addTelescopeModal.saveConfigButton')}
                />
              )}
            </div>
          );
        })}
      </div>

      {adding ? (
        <div className={`rounded-lg border overflow-hidden ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <OpticalConfigForm
            form={form}
            setForm={setForm}
            isDark={isDark}
            inputClass={inputClass}
            labelClass={labelClass}
            error={formError}
            onCancel={cancelForm}
            onSubmit={submitForm}
            canSubmit={canSubmit}
            submitting={addMutation.isPending}
            submitLabel={t('addTelescopeModal.addConfigButton')}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={startAdd}
          className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium border border-dashed transition ${
            isDark ? 'border-slate-700 text-slate-400 hover:bg-slate-800/50' : 'border-slate-300 text-slate-500 hover:bg-slate-50'
          }`}
        >
          <Plus className="w-4 h-4" />
          {t('addTelescopeModal.addConfigButton')}
        </button>
      )}
    </div>
  );
}

function OpticalConfigForm({
  form, setForm, isDark, inputClass, labelClass, error, onCancel, onSubmit, canSubmit, submitting, submitLabel,
}: {
  form: OpticalConfigFormState;
  setForm: (f: OpticalConfigFormState) => void;
  isDark: boolean;
  inputClass: string;
  labelClass: string;
  error: string;
  onCancel: () => void;
  onSubmit: () => void;
  canSubmit: boolean;
  submitting: boolean;
  submitLabel: string;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className={`px-3 py-3 space-y-3 ${isDark ? 'bg-slate-900' : 'bg-white'}`}>
      <div>
        <label className={labelClass}>{t('addTelescopeModal.configNameLabel')}</label>
        <input
          type="text"
          placeholder={t('addTelescopeModal.configNamePlaceholder')}
          value={form.name}
          onChange={e => setForm({ ...form, name: e.target.value })}
          className={inputClass}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>{t('addTelescopeModal.focalLengthLabel')}</label>
          <input
            type="number"
            min={1}
            placeholder={t('addTelescopeModal.focalLengthPlaceholder')}
            value={form.focalLengthMm}
            onChange={e => setForm({ ...form, focalLengthMm: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>{t('addTelescopeModal.pixelSizeLabel')} <span className="opacity-60">{t('addTelescopeModal.optional')}</span></label>
          <input
            type="number"
            min={0}
            step={0.01}
            placeholder={t('addTelescopeModal.pixelSizePlaceholder')}
            value={form.pixelSizeUm}
            onChange={e => setForm({ ...form, pixelSizeUm: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>{t('addTelescopeModal.sensorWidthLabel')}</label>
          <input
            type="number"
            min={0.1}
            step={0.1}
            placeholder={t('addTelescopeModal.sensorWidthPlaceholder')}
            value={form.sensorWidthMm}
            onChange={e => setForm({ ...form, sensorWidthMm: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>{t('addTelescopeModal.sensorHeightLabel')}</label>
          <input
            type="number"
            min={0.1}
            step={0.1}
            placeholder={t('addTelescopeModal.sensorHeightPlaceholder')}
            value={form.sensorHeightMm}
            onChange={e => setForm({ ...form, sensorHeightMm: e.target.value })}
            className={inputClass}
          />
        </div>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
        >
          {t('addTelescopeModal.cancel')}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit || submitting}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

