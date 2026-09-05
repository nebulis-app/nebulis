import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, X, Eye, EyeOff, Loader2, ShieldCheck, KeyRound } from 'lucide-react';
import { updateUserProfile, updateUserRole, resetUserPassword, toUserRole, type UserRole } from '../../lib/api/auth';
import { getInputClass, getLabelClass, getHelperClass } from './SettingsUI';
import { Modal } from '../ui/Modal';
import { ConfirmModal } from '../ConfirmModal';

interface EditableUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role: UserRole;
}

/**
 * Single modal for everything an admin can change about a user: display
 * name, email, role, and an optional password reset, all saved together with
 * one button. Replaces the old inline pencil-to-expand-a-panel and separate
 * "Reset password" row, which made editing a user a two-place operation.
 */
export function EditUserModal({
  isDark,
  user,
  adminCount,
  onClose,
}: {
  isDark: boolean;
  user: EditableUser;
  /** Total admins in the system, so the last one can't demote themselves. */
  adminCount: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const inputClass = getInputClass(isDark);
  const labelClass = getLabelClass(isDark);
  const helperClass = getHelperClass(isDark);

  const [displayName, setDisplayName] = useState(user.displayName || '');
  const [email, setEmail] = useState(user.email || '');
  const [role, setRole] = useState<UserRole>(user.role);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [confirmingPasswordReset, setConfirmingPasswordReset] = useState(false);

  const isLastAdmin = user.role === 'admin' && adminCount <= 1;
  const passwordTooShort = password.length > 0 && password.length < 6;
  const canSave = displayName.trim().length > 0 && !passwordTooShort;

  const mutation = useMutation({
    mutationFn: async () => {
      const profileChanged = displayName !== (user.displayName || '') || email !== (user.email || '');
      if (profileChanged) {
        await updateUserProfile(user.id, { displayName, email });
      }
      if (role !== user.role) {
        await updateUserRole(user.id, role);
      }
      if (password.length > 0) {
        await resetUserPassword(user.id, password);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });

  return (
    <Modal
      isOpen
      onClose={() => { if (!mutation.isPending) onClose(); }}
      title="Edit User"
      className={`w-full max-w-md rounded-2xl border shadow-2xl ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}
    >
      <div className={`flex items-center justify-between p-5 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDark ? 'bg-accent-500/10' : 'bg-accent-50'}`}>
            <Pencil className="w-4 h-4 text-accent-500" />
          </div>
          <div>
            <h3 className={`font-display font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
              Edit User
            </h3>
            <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{user.username}</p>
          </div>
        </div>
        <button
          onClick={() => onClose()}
          disabled={mutation.isPending}
          className={`p-2 rounded-lg transition disabled:opacity-50 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Display Name</label>
            <input
              type="text"
              placeholder="Jane Doe"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className={inputClass}
              autoFocus
            />
          </div>
          <div>
            <label className={labelClass}>Email</label>
            <input
              type="email"
              placeholder="jane@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label className={labelClass}>Role</label>
          <select
            value={role}
            onChange={e => setRole(toUserRole(e.target.value))}
            disabled={isLastAdmin}
            title={isLastAdmin ? 'Cannot remove admin role from the last admin' : undefined}
            className={`${inputClass} cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <option value="admin">Admin: full access</option>
            <option value="viewer">Viewer: read-only access</option>
          </select>
          {isLastAdmin && (
            <p className={helperClass}>
              <ShieldCheck className="w-3 h-3 inline mr-1" />
              This is the last admin, so the role can't be changed.
            </p>
          )}
        </div>

        <div className={`pt-3 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          {showPasswordReset ? (
            <>
              <label className={labelClass}>New Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="New password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={`${inputClass} pr-10`}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className={`absolute right-3 top-1/2 -translate-y-1/2 transition-colors ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <p className={helperClass}>{passwordTooShort ? 'Min 6 characters.' : 'Saved when you save this form.'}</p>
                <button
                  type="button"
                  onClick={() => { setShowPasswordReset(false); setPassword(''); setShowPassword(false); }}
                  className={`text-xs font-medium shrink-0 ml-3 ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowPasswordReset(true)}
              className={`inline-flex items-center gap-2 text-sm font-medium transition ${
                isDark ? 'text-slate-300 hover:text-white' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <KeyRound className="w-4 h-4" />
              Reset password
            </button>
          )}
        </div>

        {mutation.error && (
          <p className="text-sm text-danger-500">
            {mutation.error instanceof Error ? mutation.error.message : 'Failed to save changes.'}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 px-5 pb-5">
        <button
          type="button"
          onClick={() => onClose()}
          disabled={mutation.isPending}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition disabled:opacity-50 ${isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'}`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            if (password.length > 0) {
              setConfirmingPasswordReset(true);
            } else {
              mutation.mutate();
            }
          }}
          disabled={!canSave || mutation.isPending}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
        >
          {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Save changes
        </button>
      </div>

      {confirmingPasswordReset && (
        <ConfirmModal
          title="Reset password?"
          message={`${user.displayName || user.username}'s connected devices, including any paired Apple TV or phone, will be signed out and need to be paired again.`}
          confirmLabel="Reset password"
          onConfirm={() => { setConfirmingPasswordReset(false); mutation.mutate(); }}
          onCancel={() => setConfirmingPasswordReset(false)}
        />
      )}
    </Modal>
  );
}
