import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Key, Plus, ShieldCheck, Eye, EyeOff, Pencil } from 'lucide-react';
import { getUsers, createUser, deleteAppUser, resetUserPassword, updateUserRole, updateUserProfile, toUserRole, type UserRole } from '../../lib/api/auth';
import { getInputClass, getLabelClass, getCardClass } from './SettingsUI';

export function UsersSection({ isDark }: { isDark: boolean }) {
  const queryClient = useQueryClient();
  const inputClass = getInputClass(isDark);
  const labelClass = getLabelClass(isDark);

  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: getUsers,
  });

  const adminCount = users.filter(u => u.role === 'admin').length;

  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', email: '', password: '', displayName: '', role: 'viewer' as UserRole });
  const [showNewUserPassword, setShowNewUserPassword] = useState(false);
  const [userError, setUserError] = useState('');
  const [resetPwUserId, setResetPwUserId] = useState<string | null>(null);
  const [resetPwValue, setResetPwValue] = useState('');
  const [editProfileUserId, setEditProfileUserId] = useState<string | null>(null);
  const [editProfileValues, setEditProfileValues] = useState({ displayName: '', email: '' });

  const createUserMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setShowCreateUser(false);
      setNewUser({ username: '', email: '', password: '', displayName: '', role: 'viewer' });
      setShowNewUserPassword(false);
      setUserError('');
    },
    onError: (err) => {
      setUserError(err instanceof Error ? err.message : 'Failed to create user');
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: deleteAppUser,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) => resetUserPassword(id, password),
    onSuccess: () => {
      setResetPwUserId(null);
      setResetPwValue('');
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: UserRole }) => updateUserRole(id, role),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const updateProfileMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { displayName: string; email: string } }) => updateUserProfile(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditProfileUserId(null);
    },
  });

  const selectClass = `${inputClass} cursor-pointer`;

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-xl ${isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'}`}>
            <Key className="w-5 h-5 text-emerald-500" />
          </div>
          <div>
            <h2 className={`font-display text-[17px] font-semibold tracking-tight ${isDark ? 'text-white' : 'text-slate-800'}`}>
              Users
            </h2>
            <p className={`text-[13px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Same credentials work for the web app and iOS app
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            setShowCreateUser(true);
            setUserError('');
            setShowNewUserPassword(false);
            setNewUser({ username: '', email: '', password: '', displayName: '', role: 'viewer' });
          }}
          className={`inline-flex items-center gap-1.5 text-[13px] font-medium px-3.5 py-2 rounded-lg transition-all duration-150 ${
            isDark
              ? 'bg-slate-800 text-slate-300 hover:text-white hover:bg-slate-700 border border-slate-700'
              : 'bg-white text-slate-600 hover:text-slate-800 hover:bg-slate-50 border border-slate-200 shadow-sm'
          }`}
        >
          <Plus className="w-3.5 h-3.5" />
          Add User
        </button>
      </div>

      {/* Card */}
      <div className={`${getCardClass(isDark)} space-y-4`}>
        {/* Create user form */}
        {showCreateUser && (
          <div className={`p-5 rounded-xl border space-y-3 ${isDark ? 'bg-slate-800/40 border-slate-700/80' : 'bg-slate-50 border-slate-200'}`}>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Display Name</label>
                <input
                  type="text"
                  placeholder="Jane Doe"
                  value={newUser.displayName}
                  onChange={e => setNewUser(u => ({ ...u, displayName: e.target.value }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Username</label>
                <input
                  type="text"
                  placeholder="jane"
                  value={newUser.username}
                  onChange={e => setNewUser(u => ({ ...u, username: e.target.value }))}
                  className={inputClass}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Email</label>
                <input
                  type="email"
                  placeholder="jane@example.com"
                  value={newUser.email}
                  onChange={e => setNewUser(u => ({ ...u, email: e.target.value }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Password</label>
                <div className="relative">
                  <input
                    type={showNewUserPassword ? 'text' : 'password'}
                    placeholder="Min 6 characters"
                    value={newUser.password}
                    onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))}
                    className={`${inputClass} pr-10`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewUserPassword(v => !v)}
                    className={`absolute right-3 top-1/2 -translate-y-1/2 transition-colors ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}
                    tabIndex={-1}
                  >
                    {showNewUserPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
            <div>
              <label className={labelClass}>Role</label>
              <select
                value={newUser.role}
                onChange={e => setNewUser(u => ({ ...u, role: toUserRole(e.target.value) }))}
                className={selectClass}
              >
                <option value="viewer">Viewer: read-only access</option>
                <option value="admin">Admin: full access</option>
              </select>
            </div>
            {userError && (
              <p className="text-sm text-danger-500">{userError}</p>
            )}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => {
                  setUserError('');
                  createUserMutation.mutate(newUser);
                }}
                disabled={!newUser.username || !newUser.password || createUserMutation.isPending}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition-all duration-150 disabled:opacity-50"
              >
                {createUserMutation.isPending ? 'Creating…' : 'Create User'}
              </button>
              <button
                onClick={() => { setShowCreateUser(false); setShowNewUserPassword(false); }}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800'}`}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* User list */}
        {users.length === 0 ? (
          <p className={`text-sm text-center py-8 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            No users yet. The app is in open access mode.
          </p>
        ) : (
          <div className="space-y-1.5">
            {users.map(user => (
              <div key={user.id} className="rounded-xl overflow-hidden">
                {/* User row */}
                <div
                  className={`flex items-center gap-4 p-3.5 transition-colors duration-150 ${
                    isDark ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
                    isDark ? 'bg-accent-500/10 text-accent-400' : 'bg-accent-50 text-accent-600'
                  }`}>
                    {(user.displayName || user.username).charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium text-sm ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                        {user.displayName || user.username}
                      </span>
                      {user.role === 'admin' ? (
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          isDark ? 'bg-accent-500/15 text-accent-400' : 'bg-accent-50 text-accent-700'
                        }`}>
                          <ShieldCheck className="w-2.5 h-2.5" />
                          Admin
                        </span>
                      ) : (
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'
                        }`}>
                          <Eye className="w-2.5 h-2.5" />
                          Viewer
                        </span>
                      )}
                    </div>
                    <div className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {user.username}
                      {user.email ? ` · ${user.email}` : ''}
                      {' · joined '}
                      {new Date(user.createdAt).toLocaleDateString()}
                    </div>
                  </div>

                  {resetPwUserId === user.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      placeholder="New password"
                      value={resetPwValue}
                      onChange={e => setResetPwValue(e.target.value)}
                      className={`w-36 px-3 py-1.5 rounded-lg border text-xs transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/30 ${
                        isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
                      }`}
                    />
                    <button
                      onClick={() => resetPasswordMutation.mutate({ id: user.id, password: resetPwValue })}
                      disabled={resetPwValue.length < 6 || resetPasswordMutation.isPending}
                      className="text-xs px-3 py-1.5 rounded-lg bg-accent-500 text-white disabled:opacity-50 transition"
                    >
                      {resetPasswordMutation.isPending ? '…' : 'Save'}
                    </button>
                    <button
                      onClick={() => {
                        setResetPwUserId(null);
                        setResetPwValue('');
                      }}
                      className={`text-xs px-2 py-1 ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <select
                      value={user.role}
                      onChange={e => updateRoleMutation.mutate({ id: user.id, role: toUserRole(e.target.value) })}
                      disabled={updateRoleMutation.isPending || (user.role === 'admin' && adminCount <= 1)}
                      title={user.role === 'admin' && adminCount <= 1 ? 'Cannot remove admin role from the last admin' : undefined}
                      className={`text-xs px-2 py-1.5 rounded-lg border appearance-none cursor-pointer transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${
                        isDark
                          ? 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600'
                          : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      <option value="admin">Admin</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button
                      onClick={() => {
                        setEditProfileUserId(user.id);
                        setEditProfileValues({ displayName: user.displayName || '', email: user.email || '' });
                      }}
                      className={`text-xs px-2 py-1.5 rounded-lg transition-all duration-150 ${
                        isDark ? 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100'
                      }`}
                      title="Edit name and email"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        setResetPwUserId(user.id);
                        setResetPwValue('');
                      }}
                      className={`text-xs px-3 py-1.5 rounded-lg transition-all duration-150 ${
                        isDark ? 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100'
                      }`}
                    >
                      Reset Password
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete user "${user.displayName || user.username}"?`)) {
                          deleteUserMutation.mutate(user.id);
                        }
                      }}
                      disabled={deleteUserMutation.isPending || (user.role === 'admin' && adminCount <= 1)}
                      title={user.role === 'admin' && adminCount <= 1 ? 'Cannot delete the last admin' : undefined}
                      className="text-xs px-3 py-1.5 rounded-lg text-danger-500 hover:bg-danger-500/10 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Delete
                    </button>
                  </div>
                )}
                </div>

                {/* Expanded edit profile panel */}
                {editProfileUserId === user.id && (
                  <div className={`mx-3 mb-3 p-4 rounded-xl border space-y-3 ${isDark ? 'bg-slate-800/40 border-slate-700/80' : 'bg-slate-50 border-slate-200'}`}>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelClass}>Display Name</label>
                        <input
                          type="text"
                          placeholder="Jane Doe"
                          value={editProfileValues.displayName}
                          onChange={e => setEditProfileValues(v => ({ ...v, displayName: e.target.value }))}
                          className={inputClass}
                          autoFocus
                        />
                      </div>
                      <div>
                        <label className={labelClass}>Email</label>
                        <input
                          type="email"
                          placeholder="jane@example.com"
                          value={editProfileValues.email}
                          onChange={e => setEditProfileValues(v => ({ ...v, email: e.target.value }))}
                          className={inputClass}
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => updateProfileMutation.mutate({ id: user.id, data: editProfileValues })}
                        disabled={!editProfileValues.displayName || updateProfileMutation.isPending}
                        className="px-4 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition-all duration-150 disabled:opacity-50"
                      >
                        {updateProfileMutation.isPending ? 'Saving…' : 'Save Changes'}
                      </button>
                      <button
                        onClick={() => setEditProfileUserId(null)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800'}`}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
