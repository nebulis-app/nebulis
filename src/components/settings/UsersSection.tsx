import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Eye, EyeOff, Pencil } from 'lucide-react';
import { getUsers, createUser, deleteAppUser, toUserRole, type UserRole } from '../../lib/api/auth';
import { getInputClass, getLabelClass, Sec } from './SettingsUI';
import { ConfirmModal } from '../ConfirmModal';
import { EditUserModal } from './EditUserModal';

interface NewUserDraft {
  username: string;
  email: string;
  password: string;
  displayName: string;
  role: UserRole;
}

const EMPTY_NEW_USER: NewUserDraft = { username: '', email: '', password: '', displayName: '', role: 'viewer' };

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
  const [newUser, setNewUser] = useState<NewUserDraft>(EMPTY_NEW_USER);
  const [showNewUserPassword, setShowNewUserPassword] = useState(false);
  const [userError, setUserError] = useState('');
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState<{ id: string; label: string } | null>(null);

  const createUserMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setShowCreateUser(false);
      setNewUser(EMPTY_NEW_USER);
      setShowNewUserPassword(false);
      setUserError('');
    },
    onError: (err) => {
      setUserError(err instanceof Error ? err.message : 'Could not create that user. Check the username is not already taken, then try again.');
    },
  });

  const [deleteUserError, setDeleteUserError] = useState('');
  const deleteUserMutation = useMutation({
    mutationFn: deleteAppUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setDeletingUser(null);
    },
    onError: (err) => {
      // Without this a failed delete (e.g. a duplicate request 404) was
      // swallowed entirely and the modal just sat there.
      setDeleteUserError(err instanceof Error ? err.message : 'Could not delete that user. Try again.');
    },
  });

  const selectClass = `${inputClass} cursor-pointer`;

  return (
    <>
    <Sec
      title="Users"
      description="Same credentials work for the web app and iOS app."
      isDark={isDark}
      actions={
        <button
          onClick={() => {
            setShowCreateUser(true);
            setUserError('');
            setShowNewUserPassword(false);
            setNewUser(EMPTY_NEW_USER);
          }}
          className={`inline-flex items-center gap-1.5 text-[13px] font-medium px-3.5 py-2 rounded-lg transition-all duration-150 border ${
            isDark
              ? 'bg-slate-800 text-slate-300 hover:text-white hover:bg-slate-700 border-slate-700'
              : 'bg-white text-slate-600 hover:text-slate-800 hover:bg-slate-50 border-slate-200 shadow-sm'
          }`}
        >
          <Plus className="w-3.5 h-3.5" />
          Add user
        </button>
      }
    >
      <div className="p-4 space-y-4">
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
                <p className={`text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>Minimum 6 characters.</p>
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
                {createUserMutation.isPending ? 'Creating…' : 'Create user'}
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

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setEditingUserId(user.id)}
                      className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all duration-150 ${
                        isDark ? 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100'
                      }`}
                      title="Edit name, email, role, or password"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      Edit
                    </button>
                    <button
                      onClick={() => setDeletingUser({ id: user.id, label: user.displayName || user.username })}
                      disabled={deleteUserMutation.isPending || (user.role === 'admin' && adminCount <= 1)}
                      title={user.role === 'admin' && adminCount <= 1 ? 'Cannot delete the last admin' : undefined}
                      className="text-xs px-3 py-1.5 rounded-lg text-danger-500 hover:bg-danger-500/10 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Sec>
    {editingUserId && (() => {
      const editingUser = users.find(u => u.id === editingUserId);
      return editingUser ? (
        <EditUserModal
          isDark={isDark}
          user={editingUser}
          adminCount={adminCount}
          onClose={() => setEditingUserId(null)}
        />
      ) : null;
    })()}
    {deletingUser && (
      <ConfirmModal
        title="Delete user"
        message={deleteUserError
          ? `Delete user "${deletingUser.label}"?\n\n${deleteUserError}`
          : `Delete user "${deletingUser.label}"?`}
        confirmLabel="Delete"
        pending={deleteUserMutation.isPending}
        onConfirm={() => { setDeleteUserError(''); deleteUserMutation.mutate(deletingUser.id); }}
        onCancel={() => { setDeleteUserError(''); setDeletingUser(null); }}
      />
    )}
    </>
  );
}
