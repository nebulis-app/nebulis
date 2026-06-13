import { useEffect, useReducer, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { registerUser } from '../lib/api/auth';
import { setAuthToken } from '../lib/api/client';
import { createTelescope, testTelescopeConnection } from '../lib/api/telescopes';
import { updateSettings } from '../lib/api/settings';
import {
  TELESCOPE_PRESETS,
  DEFAULT_COLOR_BY_KIND,
  type TelescopeKind,
} from '../lib/telescopePresets';
import { useTheme } from '../hooks/useTheme';
import { stepReducer, initialStepState } from './onboarding/stepReducer';
import { OnboardingChrome } from './onboarding/OnboardingChrome';
import { OnboardingSteps } from './onboarding/OnboardingSteps';
import type { TestStatus } from './onboarding/OnboardingStep2';

const TRANSITION_MS = 150;

export function OnboardingModal({ onComplete }: { onComplete: () => void }) {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();

  const [stepState, stepDispatch] = useReducer(stepReducer, initialStepState);
  const { step, transitioning } = stepState;

  // Step 1, user
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [userError, setUserError] = useState('');

  // Step 2, connection
  const [kind, setKind] = useState<TelescopeKind | ''>('');
  const isDwarfKind = kind === 'dwarf-2' || kind === 'dwarf-3' || kind === 'dwarf-mini';
  const isSeestarKind = kind === 'seestar-s50' || kind === 'seestar-s30';
  // Transport mode lets Seestar pick between Wi-Fi (SMB) and USB. Dwarf is
  // local-only; SMB is the default for everything else.
  const [transportMode, setTransportMode] = useState<'smb' | 'local'>('smb');
  const isLocalKind = isDwarfKind || (isSeestarKind && transportMode === 'local');
  const [telescopeName, setTelescopeName] = useState('');
  const [hostname, setHostname] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [smbShareName, setSmbShareName] = useState('');
  const [smbUsername, setSmbUsername] = useState('');
  const [smbPassword, setSmbPassword] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');

  const preset = kind ? TELESCOPE_PRESETS[kind] : null;

  // Step 3, import
  const [autoImportInterval, setAutoImportInterval] = useState(0);
  const [importJpg, setImportJpg] = useState(true);
  const [importFits, setImportFits] = useState(true);
  const [importSubFrames, setImportSubFrames] = useState(false);
  const [prefetchCatalogAssets, setPrefetchCatalogAssets] = useState(true);

  const inputClass = `w-full px-4 py-3 rounded-xl border text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
    isDark
      ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder-slate-600 focus:border-accent-500/50'
      : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400 focus:border-accent-400'
  }`;
  const labelClass = `block text-sm font-medium mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`;
  const helperClass = `text-xs mt-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`;
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';

  const createUserMutation = useMutation({
    mutationFn: () => registerUser({ username, password, displayName: username, email: '' }),
    onSuccess: data => {
      if (data?.token) setAuthToken(data.token);
      setUserError('');
      stepDispatch({ type: 'BEGIN_FORWARD' });
    },
    onError: err => setUserError(err instanceof Error ? err.message : 'Failed to create user'),
  });

  const finishMutation = useMutation({
    mutationFn: async () => {
      const autoImportOn = autoImportInterval > 0;
      const hasConnection = isLocalKind ? localPath.trim().length > 0 : hostname.trim().length > 0;
      if (hasConnection && preset && kind) {
        await createTelescope({
          name: telescopeName.trim() || preset.label,
          model: preset.model,
          hostname: isLocalKind ? '' : hostname.trim(),
          shareName: isLocalKind ? '' : smbShareName.trim(),
          username: isLocalKind ? '' : smbUsername.trim(),
          password: isLocalKind ? '' : smbPassword,
          kind,
          color: DEFAULT_COLOR_BY_KIND[kind],
          autoImportEnabled: autoImportOn,
          autoImportInterval: autoImportOn ? autoImportInterval : 60,
          connectionType: isLocalKind ? 'local' : 'smb',
          localPath: isLocalKind ? localPath.trim() : '',
        });
      }
      return updateSettings({
        autoImportInterval: autoImportOn ? autoImportInterval : 60,
        importJpg,
        importFits,
        importSubFrames,
        prefetchCatalogAssets,
        onboardingCompleted: true,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['auth-status'] });
      queryClient.invalidateQueries({ queryKey: ['telescopes'] });
      onComplete();
    },
  });

  // After the fade-out window elapses, commit the new step and fade back in.
  useEffect(() => {
    if (!transitioning) return;
    const id = setTimeout(() => stepDispatch({ type: 'COMMIT' }), TRANSITION_MS);
    return () => clearTimeout(id);
  }, [transitioning]);

  function handleStep1Next() {
    setUserError('');
    if (!username.trim()) return setUserError('Username is required');
    if (username.trim().length < 3) return setUserError('Username must be at least 3 characters');
    if (!password) return setUserError('Password is required');
    if (password.length < 4) return setUserError('Password must be at least 4 characters');
    if (password !== confirmPassword) return setUserError('Passwords do not match');
    createUserMutation.mutate();
  }

  async function handleTestConnection() {
    if (!kind) return;
    setTestStatus('testing');
    try {
      const result = await testTelescopeConnection({
        kind,
        hostname: hostname.trim(),
        shareName: smbShareName.trim(),
        username: smbUsername.trim(),
        password: smbPassword,
      });
      if (result.connected) {
        setTestStatus('success');
        setTestMessage(`Connected! Found ${result.objectCount || 0} observation${(result.objectCount || 0) !== 1 ? 's' : ''} on the device.`);
      } else {
        setTestStatus('error');
        setTestMessage(result.error || 'Connection failed');
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  }

  function handleSkip() {
    updateSettings({ onboardingCompleted: true }).then(() => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      onComplete();
    });
  }

  function handleKindChange(newKind: TelescopeKind | '') {
    setKind(newKind);
    if (newKind) {
      setSmbShareName(TELESCOPE_PRESETS[newKind].shareName);
      setSmbUsername(TELESCOPE_PRESETS[newKind].username);
      // Default Dwarf to local (USB-only) and Seestar to SMB.
      if (newKind === 'dwarf-2' || newKind === 'dwarf-3' || newKind === 'dwarf-mini') setTransportMode('local');
      else if (newKind === 'seestar-s50' || newKind === 'seestar-s30') setTransportMode('smb');
    } else {
      setSmbShareName('');
      setSmbUsername('');
    }
    setTestStatus('idle');
  }

  const finishError = finishMutation.isError
    ? (finishMutation.error instanceof Error ? finishMutation.error : new Error('Failed to save settings'))
    : null;

  return (
    <OnboardingChrome
      step={step}
      transitioning={transitioning}
      isDark={isDark}
      subText={subText}
      step2Disabled={!kind || (isLocalKind ? !localPath.trim() : !hostname.trim())}
      isCreatingUser={createUserMutation.isPending}
      isFinishing={finishMutation.isPending}
      onSkip={handleSkip}
      onBack={() => stepDispatch({ type: 'BEGIN_BACK' })}
      onContinue={() => stepDispatch({ type: 'BEGIN_FORWARD' })}
      onFinish={() => finishMutation.mutate()}
      onSubmitStep1={handleStep1Next}
    >
      <OnboardingSteps
        step={step}
        isDark={isDark}
        inputClass={inputClass}
        labelClass={labelClass}
        helperClass={helperClass}
        subText={subText}
        username={username}
        password={password}
        confirmPassword={confirmPassword}
        userError={userError}
        onUsernameChange={v => { setUsername(v); setUserError(''); }}
        onPasswordChange={v => { setPassword(v); setUserError(''); }}
        onConfirmPasswordChange={v => { setConfirmPassword(v); setUserError(''); }}
        onSubmitStep1={handleStep1Next}
        kind={kind}
        isLocalKind={isLocalKind}
        transportMode={transportMode}
        onTransportModeChange={mode => { setTransportMode(mode); setTestStatus('idle'); }}
        telescopeName={telescopeName}
        hostname={hostname}
        localPath={localPath}
        smbShareName={smbShareName}
        smbUsername={smbUsername}
        smbPassword={smbPassword}
        testStatus={testStatus}
        testMessage={testMessage}
        onKindChange={handleKindChange}
        onTelescopeNameChange={setTelescopeName}
        onHostnameChange={v => { setHostname(v); setTestStatus('idle'); }}
        onLocalPathChange={setLocalPath}
        onSmbShareNameChange={v => { setSmbShareName(v); setTestStatus('idle'); }}
        onSmbUsernameChange={v => { setSmbUsername(v); setTestStatus('idle'); }}
        onSmbPasswordChange={v => { setSmbPassword(v); setTestStatus('idle'); }}
        onTestConnection={handleTestConnection}
        autoImportInterval={autoImportInterval}
        importJpg={importJpg}
        importFits={importFits}
        importSubFrames={importSubFrames}
        prefetchCatalogAssets={prefetchCatalogAssets}
        onAutoImportIntervalChange={setAutoImportInterval}
        onImportJpgChange={setImportJpg}
        onImportFitsChange={setImportFits}
        onImportSubFramesChange={setImportSubFrames}
        onPrefetchCatalogAssetsChange={setPrefetchCatalogAssets}
        finishError={finishError}
      />
    </OnboardingChrome>
  );
}
