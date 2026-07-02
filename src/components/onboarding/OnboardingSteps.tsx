import { OnboardingStep1 } from './OnboardingStep1';
import { OnboardingStep2, type TestStatus } from './OnboardingStep2';
import { OnboardingStep3 } from './OnboardingStep3';
import { OnboardingStep4 } from './OnboardingStep4';
import type { TelescopeKind } from '../../lib/telescopePresets';
import type { StepNumber } from './stepReducer';

interface OnboardingStepsProps {
  step: StepNumber;
  isDark: boolean;
  inputClass: string;
  labelClass: string;
  helperClass: string;
  subText: string;

  // Step 1
  username: string;
  password: string;
  confirmPassword: string;
  userError: string;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onSubmitStep1: () => void;

  // Step 2
  kind: TelescopeKind | '';
  isLocalKind: boolean;
  transportMode?: 'smb' | 'local';
  telescopeName: string;
  hostname: string;
  localPath: string;
  smbShareName: string;
  smbUsername: string;
  smbPassword: string;
  testStatus: TestStatus;
  testMessage: string;
  onKindChange: (kind: TelescopeKind | '') => void;
  onTransportModeChange?: (mode: 'smb' | 'local') => void;
  onTelescopeNameChange: (value: string) => void;
  onHostnameChange: (value: string) => void;
  onLocalPathChange: (value: string) => void;
  onSmbShareNameChange: (value: string) => void;
  onSmbUsernameChange: (value: string) => void;
  onSmbPasswordChange: (value: string) => void;
  onTestConnection: () => void;

  // Step 3
  autoImportInterval: number;
  importJpg: boolean;
  importFits: boolean;
  importSubFrames: boolean;
  prefetchCatalogAssets: boolean;
  onAutoImportIntervalChange: (value: number) => void;
  onImportJpgChange: (value: boolean) => void;
  onImportFitsChange: (value: boolean) => void;
  onImportSubFramesChange: (value: boolean) => void;
  onPrefetchCatalogAssetsChange: (value: boolean) => void;

  // Step 4
  finishError: Error | null;
}

export function OnboardingSteps(p: OnboardingStepsProps) {
  switch (p.step) {
    case 1:
      return (
        <OnboardingStep1
          username={p.username}
          password={p.password}
          confirmPassword={p.confirmPassword}
          userError={p.userError}
          isDark={p.isDark}
          inputClass={p.inputClass}
          labelClass={p.labelClass}
          subText={p.subText}
          onUsernameChange={p.onUsernameChange}
          onPasswordChange={p.onPasswordChange}
          onConfirmPasswordChange={p.onConfirmPasswordChange}
          onSubmit={p.onSubmitStep1}
        />
      );
    case 2:
      return (
        <OnboardingStep2
          kind={p.kind}
          isLocalKind={p.isLocalKind}
          transportMode={p.transportMode}
          onTransportModeChange={p.onTransportModeChange}
          telescopeName={p.telescopeName}
          hostname={p.hostname}
          localPath={p.localPath}
          smbShareName={p.smbShareName}
          smbUsername={p.smbUsername}
          smbPassword={p.smbPassword}
          testStatus={p.testStatus}
          testMessage={p.testMessage}
          isDark={p.isDark}
          inputClass={p.inputClass}
          labelClass={p.labelClass}
          helperClass={p.helperClass}
          subText={p.subText}
          onKindChange={p.onKindChange}
          onTelescopeNameChange={p.onTelescopeNameChange}
          onHostnameChange={p.onHostnameChange}
          onLocalPathChange={p.onLocalPathChange}
          onSmbShareNameChange={p.onSmbShareNameChange}
          onSmbUsernameChange={p.onSmbUsernameChange}
          onSmbPasswordChange={p.onSmbPasswordChange}
          onTestConnection={p.onTestConnection}
        />
      );
    case 3:
      return (
        <OnboardingStep3
          autoImportInterval={p.autoImportInterval}
          importJpg={p.importJpg}
          importFits={p.importFits}
          importSubFrames={p.importSubFrames}
          prefetchCatalogAssets={p.prefetchCatalogAssets}
          isDark={p.isDark}
          inputClass={p.inputClass}
          labelClass={p.labelClass}
          helperClass={p.helperClass}
          subText={p.subText}
          onAutoImportIntervalChange={p.onAutoImportIntervalChange}
          onImportJpgChange={p.onImportJpgChange}
          onImportFitsChange={p.onImportFitsChange}
          onImportSubFramesChange={p.onImportSubFramesChange}
          onPrefetchCatalogAssetsChange={p.onPrefetchCatalogAssetsChange}
        />
      );
    case 4:
      return (
        <OnboardingStep4
          username={p.username}
          kind={p.kind}
          isLocalKind={p.isLocalKind}
          telescopeName={p.telescopeName}
          hostname={p.hostname}
          localPath={p.localPath}
          autoImportInterval={p.autoImportInterval}
          importJpg={p.importJpg}
          importFits={p.importFits}
          importSubFrames={p.importSubFrames}
          testStatus={p.testStatus}
          finishError={p.finishError}
          isDark={p.isDark}
          subText={p.subText}
        />
      );
  }
}
