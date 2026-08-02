import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Usb, Network, Wifi, Trash2, Pencil, Plus, Pin, PinOff, RotateCw, Check } from 'lucide-react';
import {
  updateTelescope,
  addProfileTransport,
  updateProfileTransport,
  deleteProfileTransport,
  testTelescopeConnection,
  type TelescopeProfile,
  type TelescopeTransport,
  type ConnectionType,
} from '../../lib/api/telescopes';
import { isDwarfKind } from '../../lib/telescopePresets';
import { getInputClass, getLabelClass, getHelperClass } from './SettingsUI';
import { Modal } from '../ui/Modal';

const KIND_LABEL: Record<ConnectionType, string> = { smb: 'SMB (LAN share)', ftp: 'FTP (Wi-Fi)', local: 'USB / local path' };
const KIND_ICON: Record<ConnectionType, typeof Usb> = { smb: Network, ftp: Wifi, local: Usb };

interface FormState {
  kind: ConnectionType;
  hostname: string;
  shareName: string;
  username: string;
  password: string;
  localPath: string;
}

function blankForm(kind: ConnectionType): FormState {
  return { kind, hostname: '', shareName: '', username: '', password: '', localPath: '' };
}

function formFromTransport(t: TelescopeTransport): FormState {
  return {
    kind: t.kind,
    hostname: t.hostname,
    shareName: t.shareName,
    username: t.username,
    password: t.password,
    localPath: t.localPath,
  };
}

/**
 * Manage the transports (ways to reach a telescope) on an existing profile:
 * add, edit, delete, test, and pin one as the manual override for
 * `selectActiveTransport`. Only opened for saved profiles — a brand-new
 * profile's first transport is created alongside it by AddTelescopeModal.
 */
export function TransportEditorModal({ profile, isDark, onClose }: {
  profile: TelescopeProfile;
  isDark: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const inputClass = getInputClass(isDark);
  const labelClass = getLabelClass(isDark);
  const helperClass = getHelperClass(isDark);
  const isDwarf = isDwarfKind(profile.kind);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm(isDwarf ? 'ftp' : 'smb'));
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [formError, setFormError] = useState('');

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['telescopes'] });

  const pinMutation = useMutation({
    mutationFn: (pinnedTransportId: string | null) => updateTelescope(profile.id, { pinnedTransportId }),
    onSuccess: invalidate,
  });

  const addMutation = useMutation({
    mutationFn: (data: FormState) => addProfileTransport(profile.id, data),
    onSuccess: () => { invalidate(); setAdding(false); },
    onError: (err: Error) => setFormError(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: FormState }) => updateProfileTransport(profile.id, id, data),
    onSuccess: () => { invalidate(); setEditingId(null); },
    onError: (err: Error) => setFormError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProfileTransport(profile.id, id),
    onSuccess: invalidate,
    onError: (err: Error) => setFormError(err.message),
  });

  const transports = profile.transports ?? [];
  const availableKinds: ConnectionType[] = isDwarf ? ['ftp', 'local'] : ['smb', 'ftp', 'local'];

  function startAdd() {
    setForm(blankForm(availableKinds[0]));
    setFormError('');
    setTestStatus('idle');
    setEditingId(null);
    setAdding(true);
  }

  function startEdit(t: TelescopeTransport) {
    setForm(formFromTransport(t));
    setFormError('');
    setTestStatus('idle');
    setAdding(false);
    setEditingId(t.id);
  }

  function cancelForm() {
    setAdding(false);
    setEditingId(null);
    setFormError('');
  }

  async function handleTest() {
    setTestStatus('testing');
    setTestMessage('');
    try {
      const result = await testTelescopeConnection({
        kind: profile.kind,
        hostname: form.hostname.trim(),
        shareName: form.shareName.trim(),
        username: form.username.trim(),
        password: form.password,
        connectionType: form.kind,
      });
      if (result.connected) {
        setTestStatus('success');
        setTestMessage(`Connected. Found ${result.objectCount ?? 0} folder${result.objectCount === 1 ? '' : 's'}.`);
      } else {
        setTestStatus('error');
        setTestMessage(result.error || 'Connection failed');
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  }

  function submitForm() {
    setFormError('');
    if (editingId) {
      updateMutation.mutate({ id: editingId, data: form });
    } else {
      addMutation.mutate(form);
    }
  }

  const canTest = form.kind !== 'local' && form.hostname.trim().length > 0;
  const canSubmit = form.kind === 'local'
    ? form.localPath.trim().length > 0
    : form.hostname.trim().length > 0 && (form.kind === 'ftp' || form.shareName.trim().length > 0);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Manage connections for ${profile.name}`}
      className={`relative w-full max-w-lg rounded-2xl shadow-2xl flex flex-col max-h-[85vh] ${
        isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white shadow-xl'
      }`}
    >
      <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        <h2 className={`font-display font-semibold text-base ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
          Manage connections
        </h2>
        <button
          onClick={onClose}
          className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        <p className={helperClass}>
          {profile.name} can be reached several ways. Nebulis picks the best one
          automatically (a plugged-in USB drive wins, then FTP, then SMB) unless you pin
          one below.
        </p>

        {profile.pinnedTransportId && (
          <button
            onClick={() => pinMutation.mutate(null)}
            disabled={pinMutation.isPending}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition ${
              isDark ? 'bg-slate-800/60 text-slate-300 hover:bg-slate-800' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            <PinOff className="w-3.5 h-3.5" />
            Using a manual pin — switch back to automatic selection
          </button>
        )}

        <div className="space-y-2">
          {transports.map(t => {
            const Icon = KIND_ICON[t.kind];
            const isActive = t.id === profile.activeTransportId;
            const isPinned = t.id === profile.pinnedTransportId;
            const isEditingThis = editingId === t.id;
            return (
              <div
                key={t.id}
                className={`rounded-xl border overflow-hidden ${
                  isDark ? 'border-slate-800' : 'border-slate-200'
                }`}
              >
                <div className={`flex items-center gap-3 px-3 py-2.5 ${isDark ? 'bg-slate-800/30' : 'bg-slate-50'}`}>
                  <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-accent-500' : isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                      {KIND_LABEL[t.kind]}
                      {isPinned && <span className="ml-1.5 text-[10px] font-semibold text-accent-500">PINNED</span>}
                      {isActive && !isPinned && <span className={`ml-1.5 text-[10px] font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>ACTIVE</span>}
                    </div>
                    <div className={`text-xs font-mono truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {t.kind === 'local' ? (t.localPath || '(no path set)') : (t.shareName ? `${t.hostname} / ${t.shareName}` : t.hostname || '(no host set)')}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {!isPinned && (
                      <button
                        onClick={() => pinMutation.mutate(t.id)}
                        disabled={pinMutation.isPending}
                        title="Pin this transport"
                        className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-700 text-slate-400' : 'hover:bg-slate-200 text-slate-500'}`}
                      >
                        <Pin className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => (isEditingThis ? cancelForm() : startEdit(t))}
                      title="Edit"
                      className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-700 text-slate-400' : 'hover:bg-slate-200 text-slate-500'}`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => deleteMutation.mutate(t.id)}
                      disabled={transports.length <= 1 || deleteMutation.isPending}
                      title={transports.length <= 1 ? "Can't delete the last transport" : 'Delete'}
                      className={`p-1.5 rounded-lg transition disabled:opacity-30 disabled:cursor-not-allowed ${
                        isDark ? 'hover:bg-red-500/10 text-slate-400 hover:text-red-400' : 'hover:bg-red-50 text-slate-500 hover:text-red-600'
                      }`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {isEditingThis && (
                  <TransportForm
                    form={form}
                    setForm={setForm}
                    isDark={isDark}
                    inputClass={inputClass}
                    labelClass={labelClass}
                    availableKinds={availableKinds}
                    kindLocked
                    onTest={canTest ? handleTest : undefined}
                    testStatus={testStatus}
                    testMessage={testMessage}
                    error={formError}
                    onCancel={cancelForm}
                    onSubmit={submitForm}
                    canSubmit={canSubmit}
                    submitting={updateMutation.isPending}
                    submitLabel="Save"
                  />
                )}
              </div>
            );
          })}
        </div>

        {adding ? (
          <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
            <TransportForm
              form={form}
              setForm={setForm}
              isDark={isDark}
              inputClass={inputClass}
              labelClass={labelClass}
              availableKinds={availableKinds}
              kindLocked={false}
              onTest={canTest ? handleTest : undefined}
              testStatus={testStatus}
              testMessage={testMessage}
              error={formError}
              onCancel={cancelForm}
              onSubmit={submitForm}
              canSubmit={canSubmit}
              submitting={addMutation.isPending}
              submitLabel="Add transport"
            />
          </div>
        ) : (
          <button
            onClick={startAdd}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium border border-dashed transition ${
              isDark ? 'border-slate-700 text-slate-400 hover:bg-slate-800/50' : 'border-slate-300 text-slate-500 hover:bg-slate-50'
            }`}
          >
            <Plus className="w-4 h-4" />
            Add transport
          </button>
        )}
      </div>

      <div className={`px-5 py-3 border-t flex justify-end ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        <button
          onClick={onClose}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
            isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'
          }`}
        >
          Done
        </button>
      </div>
    </Modal>
  );
}

function TransportForm({
  form, setForm, isDark, inputClass, labelClass, availableKinds, kindLocked,
  onTest, testStatus, testMessage, error, onCancel, onSubmit, canSubmit, submitting, submitLabel,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  isDark: boolean;
  inputClass: string;
  labelClass: string;
  availableKinds: ConnectionType[];
  kindLocked: boolean;
  onTest?: () => void;
  testStatus: 'idle' | 'testing' | 'success' | 'error';
  testMessage: string;
  error: string;
  onCancel: () => void;
  onSubmit: () => void;
  canSubmit: boolean;
  submitting: boolean;
  submitLabel: string;
}) {
  return (
    <div className={`px-3 py-3 space-y-3 ${isDark ? 'bg-slate-900' : 'bg-white'}`}>
      {!kindLocked && (
        <div>
          <label className={labelClass}>Type</label>
          <select
            value={form.kind}
            onChange={e => setForm({ ...blankForm(e.target.value as ConnectionType) })}
            className={inputClass}
          >
            {availableKinds.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </div>
      )}

      {form.kind === 'local' ? (
        <div>
          <label className={labelClass}>Local path</label>
          <input
            type="text"
            value={form.localPath}
            onChange={e => setForm({ ...form, localPath: e.target.value })}
            placeholder="/Volumes/DWARF3"
            className={`${inputClass} font-mono`}
          />
        </div>
      ) : (
        <>
          <div>
            <label className={labelClass}>Host or IP</label>
            <input
              type="text"
              value={form.hostname}
              onChange={e => setForm({ ...form, hostname: e.target.value })}
              placeholder={form.kind === 'ftp' ? '192.168.88.1' : '192.168.1.50'}
              className={`${inputClass} font-mono`}
            />
          </div>
          {form.kind === 'smb' && (
            <div>
              <label className={labelClass}>Share name</label>
              <input
                type="text"
                value={form.shareName}
                onChange={e => setForm({ ...form, shareName: e.target.value })}
                placeholder="EMMC Images"
                className={inputClass}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass}>Username</label>
              <input
                type="text"
                value={form.username}
                onChange={e => setForm({ ...form, username: e.target.value })}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Password</label>
              <input
                type="password"
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                className={inputClass}
              />
            </div>
          </div>
        </>
      )}

      {onTest && (
        <div className="flex items-center gap-2">
          <button
            onClick={onTest}
            disabled={testStatus === 'testing'}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {testStatus === 'testing' ? <RotateCw className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            Test connection
          </button>
          {testMessage && (
            <span className={`text-xs ${testStatus === 'success' ? (isDark ? 'text-emerald-400' : 'text-emerald-600') : 'text-red-500'}`}>
              {testMessage}
            </span>
          )}
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
          }`}
        >
          Cancel
        </button>
        <button
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
