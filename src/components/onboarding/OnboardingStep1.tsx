import { User, AlertCircle } from 'lucide-react';

interface OnboardingStep1Props {
  username: string;
  password: string;
  confirmPassword: string;
  userError: string;
  isDark: boolean;
  inputClass: string;
  labelClass: string;
  subText: string;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onSubmit: () => void;
}

export function OnboardingStep1({
  username,
  password,
  confirmPassword,
  userError,
  isDark,
  inputClass,
  labelClass,
  subText,
  onUsernameChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
}: OnboardingStep1Props) {
  return (
    <>
      <div className="flex items-center gap-3 mb-1">
        <div className={`p-2 rounded-xl ${isDark ? 'bg-emerald-500/10' : 'bg-emerald-50'}`}>
          <User className="w-5 h-5 text-emerald-500" />
        </div>
        <div>
          <h3 className={`font-display font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            Create Admin Account
          </h3>
          <p className={`text-xs ${subText}`}>Set up your login credentials</p>
        </div>
      </div>

      <div>
        <label className={labelClass}>Username</label>
        <input
          type="text"
          placeholder="admin"
          value={username}
          onChange={e => onUsernameChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSubmit()}
          className={inputClass}
          autoFocus
        />
      </div>

      <div>
        <label className={labelClass}>Password</label>
        <input
          type="password"
          placeholder="Enter a password"
          value={password}
          onChange={e => onPasswordChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSubmit()}
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Confirm Password</label>
        <input
          type="password"
          placeholder="Confirm your password"
          value={confirmPassword}
          onChange={e => onConfirmPasswordChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSubmit()}
          className={`${inputClass} ${
            confirmPassword && password !== confirmPassword
              ? 'border-danger-500 focus:ring-danger-500/40'
              : ''
          }`}
        />
        {confirmPassword && password !== confirmPassword && (
          <p className="text-xs mt-1.5 text-danger-500 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            Passwords do not match
          </p>
        )}
      </div>

      {userError && (
        <div className="flex items-center gap-2 text-sm text-danger-500">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {userError}
        </div>
      )}
    </>
  );
}
