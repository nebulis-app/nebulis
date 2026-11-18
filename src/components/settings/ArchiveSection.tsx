import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import {
  adoptArchiveDestination,
  applyArchiveRetention,
  getArchiveRetentionPlan,
  getArchiveRunStatus,
  getArchiveStatus,
  runArchiveNow,
  cancelArchiveRun,
  type ArchiveRunResult,
  saveArchiveConfig,
  type ArchiveConfig,
  type ArchiveDestinationState,
} from '../../lib/api/storage';
import { formatBytes } from '../../lib/utils';
import { Sec } from './SettingsUI';
import { ArchiveDiskModal } from './ArchiveDiskModal';
import { ArchiveDestinationModal, type DestinationChoice } from './ArchiveDestinationModal';
import { ArchiveOverview } from './ArchiveOverview';
import { ArchiveSetupWizard } from './ArchiveSetupWizard';
import { buildArchiveSummary, EMPTY_FORM, groupPayload, hasDestination, type ArchiveGroup, type WizardStep } from './archiveForm';
import { archiveStyles, isUnusableState } from './archiveStyles';

/** The translation key for what a destination state means. */
function stateKeyOf(state: ArchiveDestinationState | null): string {
  return state ? `archive.state.${state === 'invalid-path' ? 'invalidPath' : state}` : 'archive.state.unconfigured';
}

/**
 * Archiving to an external disk.
 *
 * The screen is one of three things, chosen by the *stored* master switch rather than by
 * anything on screen. That switch is what the server enforces, so "the archive is off"
 * can only be true of the server as well as the screen if the screen reads it from there.
 *
 * - **Off and never set up:** a short introduction and one button.
 * - **Off, or being set up:** `ArchiveSetupWizard`, one decision per step, that gathers
 *   every setting as an edit and sends them together with the switch on the last step.
 *   Nothing is armed half-configured, and nothing is written to a disk before then.
 * - **On:** `ArchiveOverview`, the status of the disk and the last run, and the settings
 *   as one sentence per group, each opened and saved on its own.
 *
 * **The destination is not "location" in the library sense.** Saving a path here writes
 * nothing to the disk; claiming the disk is the separate, explicit adopt action, and the
 * server refuses it while the archive is off. So the wizard records and checks the
 * folder, and claims the disk in the same step that turns the archive on. The UI keeps
 * those apart because the server does, and because a save that silently created an
 * archive on whatever was mounted would be the accident the marker exists to prevent.
 *
 * **The destructive options are presented as destructive.** `removeLocalAfter` deletes
 * subframes from the library, permanently, once their archived copy is verified, and
 * retention deletes from the archive disk. Both are off by default, both sit in their own
 * red box, and turning either on asks for confirmation naming what will be deleted.
 *
 * The form is *derived* from the server's last answer plus whatever the user has edited,
 * rather than copied into state by an effect. That is deliberate: an effect would render
 * twice on every load, and a background refetch would overwrite an edit in progress.
 *
 * Browsing and restoring what is on the disk live in `ArchiveDiskModal`, because they act
 * on the disk rather than on the settings.
 *
 * Scoping the copy to a subset of objects is the one thing still unbuilt: the server
 * stores and honours `scope: 'selected'` with an explicit object list, and nothing here
 * offers a picker for it. This form therefore sends no `scope` at all rather than
 * silently resetting a selection made elsewhere, and the summary says which of the two
 * is stored, including when a stored selection is empty and would copy nothing.
 */
export function ArchiveSection({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  const s = archiveStyles(isDark);

  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<Partial<ArchiveConfig>>({});
  const [browsing, setBrowsing] = useState(false);
  const [choosing, setChoosing] = useState(false);
  /** The wizard step in view, or null when the wizard is not open. */
  const [wizardStep, setWizardStep] = useState<WizardStep | null>(null);
  /** Set by the picker when the folder it returned does not exist yet. Adopting is
   *  the only action allowed to create anything, and only a chosen folder is worth
   *  creating: a typed path that is a typo should fail rather than spring into being. */
  const [createFolder, setCreateFolder] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['archive-status'],
    queryFn: getArchiveStatus,
  });

  const { data: runStatus, refetch: refetchRun } = useQuery({
    queryKey: ['archive-run-status'],
    queryFn: getArchiveRunStatus,
    // Only poll while something is happening; otherwise this is a wasted request
    // every few seconds on a settings page.
    refetchInterval: query => (query.state.data?.running ? 1500 : false),
  });

  const form: ArchiveConfig = { ...EMPTY_FORM, ...data?.config, ...edits };
  const edit = (patch: Partial<ArchiveConfig>) => setEdits(current => ({ ...current, ...patch }));

  const state: ArchiveDestinationState | null = data?.destination.state ?? null;
  const adoptable = state === 'absent' || state === 'foreign';
  const isNetwork = form.locationType === 'network';
  const destinationPath = isNetwork ? data?.destination.path ?? '' : form.path;

  /** The stored switch, which is what the server actually enforces. */
  const on = data?.config.enabled === true;
  /** The stored retention switch, for the same reason: it is what the apply route checks. */
  const storedRetentionEnabled = data?.config.retentionEnabled === true;

  /** Runs an action with the busy flag and the error line handled, and says whether it
   *  finished without throwing. */
  async function guarded(action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      await action();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('archive.actionFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** The archive id a foreign disk must be confirmed against, when it is one. */
  const foreignArchiveId = state === 'foreign' ? data?.destination.foundArchiveId ?? undefined : undefined;

  const saveGroup = (group: ArchiveGroup) =>
    guarded(async () => {
      await saveArchiveConfig(groupPayload(group, form));
      await refetch();
      // The server's answer is now the source of truth, so drop the local edits.
      setEdits({});
      setNotice(t('archive.saved'));
    });

  /** Records the disk chosen in the wizard and reports whether it can be used. Saving
   *  writes nothing to the disk, so it is safe on every Next. */
  const saveDisk = async (): Promise<boolean> => {
    let usable = false;
    await guarded(async () => {
      const status = isNetwork ? data : await saveArchiveConfig(groupPayload('disk', form));
      await refetch();
      const saved = status?.destination.state ?? null;
      if (isUnusableState(saved)) {
        setError(t(stateKeyOf(saved)));
        return;
      }
      usable = true;
    });
    return usable;
  };

  const closeWizard = () => {
    setWizardStep(null);
    setEdits({});
    setCreateFolder(false);
  };

  /**
   * The last step of setup: every setting and the master switch in one save, then the
   * claim on the disk if it needs one.
   *
   * A foreign disk is confirmed *before* anything is saved, against the id the status
   * endpoint reported, so declining leaves the archive off rather than on and unable to
   * run. The claim comes after the switch because the server refuses it while off.
   */
  const finishSetup = () =>
    guarded(async () => {
      if (foreignArchiveId && !window.confirm(t('archive.adoptForeignConfirm', { id: foreignArchiveId }))) return;
      await saveArchiveConfig({
        ...groupPayload('disk', form),
        ...groupPayload('copy', form),
        ...groupPayload('schedule', form),
        ...groupPayload('cleanup', form),
        enabled: true,
      });
      if (adoptable) await adoptArchiveDestination(foreignArchiveId, createFolder);
      await refetch();
      closeWizard();
      setNotice(t('archive.enable.turnedOn'));
    });

  /** No confirmation: turning it off is the safe direction and cannot lose anything. */
  const turnOff = () =>
    guarded(async () => {
      await saveArchiveConfig({ enabled: false });
      await refetch();
      setEdits({});
      setNotice(t('archive.enable.turnedOff'));
    });

  const adopt = () =>
    guarded(async () => {
      // A foreign disk is only taken over when the user confirms against the id the
      // status endpoint reported, so the server can tell intent from an accident.
      if (foreignArchiveId && !window.confirm(t('archive.adoptForeignConfirm', { id: foreignArchiveId }))) return;
      await adoptArchiveDestination(foreignArchiveId, createFolder);
      await refetch();
      setCreateFolder(false);
      setNotice(t('archive.adopted'));
    });

  const chooseDestination = (choice: DestinationChoice) =>
    guarded(async () => {
      if (choice.kind === 'local') {
        await saveArchiveConfig({ locationType: 'local', path: choice.path });
      } else {
        await saveArchiveConfig({ locationType: 'network', network: choice.network });
      }
      setCreateFolder(choice.createFolder);
      setChoosing(false);
      // The server's answer is the source of truth for the disk now, so a half-typed
      // path must not outlive the choice that replaced it. Edits to other settings
      // are kept: the wizard can be on another step's changes when this lands.
      setEdits(current => {
        const rest = { ...current };
        delete rest.path;
        delete rest.locationType;
        delete rest.network;
        return rest;
      });
      await refetch();
      setNotice(t('archive.destinationSaved'));
    });

  /** The sentence a finished run is reported with, or the reason it did not start. */
  const describeRun = (result: ArchiveRunResult): { text: string; isError: boolean } => {
    if (!result.ran) {
      return {
        text: result.reason === 'insufficient-space' ? t('archive.runNoSpace') : t('archive.runNotStarted'),
        isError: true,
      };
    }
    if (result.cancelled) return { text: t('archive.runCancelled', { copied: result.copied }), isError: false };
    const base = result.failures.length > 0
      ? t('archive.runFinishedWithFailures', { copied: result.copied, failed: result.failures.length })
      : t('archive.runFinished', { copied: result.copied, skipped: result.skipped });
    // Appended rather than folded into the sentences above: they apply to both of
    // them equally, and combining them into every failure/success phrasing would
    // multiply the number of translated variants for no benefit.
    const tooYoung = result.tooYoungSkipped > 0
      ? ` ${t('archive.runFinishedTooYoung', { count: result.tooYoungSkipped })}`
      : '';
    const linked = result.linkedSkipped > 0
      ? ` ${t('archive.runFinishedLinked', { count: result.linkedSkipped })}`
      : '';
    return { text: base + tooYoung + linked, isError: false };
  };

  /** Waits for the run this page started and reports how it ended. "Run now" answers
   *  before the run does, so the result has to be fetched. The server clears its last
   *  result when a run starts, so a previous run's outcome is never reported here. */
  const watchRun = async () => {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (!mounted.current) return;
      const { data: status } = await refetchRun();
      if (!status || status.running || !status.lastRun) continue;
      const { text, isError } = describeRun(status.lastRun.result);
      if (isError) setError(text);
      else setNotice(text);
      await refetch();
      return;
    }
  };

  const runNow = () =>
    guarded(async () => {
      await runArchiveNow();
      await refetchRun();
      watchRun().catch(() => undefined);
    });

  const cancelRun = () =>
    guarded(async () => {
      await cancelArchiveRun();
      await refetchRun();
    });

  const prune = () =>
    guarded(async () => {
      // The dry run first, so the confirmation can name a real number rather than
      // asking the user to agree to something unspecified.
      const { plan } = await getArchiveRetentionPlan();
      if (plan.filesTotal === 0) {
        setNotice(t('archive.nothingToPrune'));
        return;
      }
      if (!window.confirm(t('archive.pruneConfirm', { count: plan.filesTotal }))) return;

      const result = await applyArchiveRetention();
      await refetch();
      setNotice(t('archive.pruned', { count: result.removed, size: formatBytes(result.bytesRemoved) }));
    });

  const toggleRemoveLocal = (next: boolean) => {
    if (next && !window.confirm(t('archive.removeLocalConfirm'))) return;
    edit({ removeLocalAfter: next });
  };

  const toggleRetention = (next: boolean) => {
    if (next && !window.confirm(t('archive.retention.enableConfirm'))) return;
    // Arming pruning with no period stored is refused by the server, so a period is
    // offered at the same time. The pair is one save, so it cannot half-apply.
    edit(next && form.retentionDays <= 0 ? { retentionEnabled: true, retentionDays: 30 } : { retentionEnabled: next });
  };

  const summary = buildArchiveSummary(t, form, isNetwork ? data?.destination.path || form.network.host : form.path.trim());

  if (isLoading) {
    return (
      <Sec title={t('archive.title')} description={t('archive.description')} isDark={isDark}>
        <p className={`px-5 py-5 text-[0.8125rem] ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          {t('archive.loading')}
        </p>
      </Sec>
    );
  }

  const shared = {
    isDark,
    form,
    edit,
    busy,
    destinationPath,
    state,
    sameDisk: data?.destination.sameDiskAsLibrary === true,
    isNetwork,
    adoptable,
    onChoose: () => setChoosing(true),
    // A typed path is not a chosen folder, so adopting it will not create anything
    // that is not already there.
    onPathTyped: () => setCreateFolder(false),
    onToggleRetention: toggleRetention,
    onToggleRemoveLocal: toggleRemoveLocal,
    summary,
  };

  // Configured means a disk was chosen before, so an off archive can be reviewed and
  // turned back on rather than set up from nothing.
  const configured = data?.config ? hasDestination(data.config) : false;

  return (
    <Sec title={t('archive.title')} description={t('archive.description')} isDark={isDark}>
      {(notice || error) && (
        <div className="space-y-3 px-5 pt-4">
          {notice && <div className={s.noticeClass}>{notice}</div>}
          {error && <div className={s.errorClass}>{error}</div>}
        </div>
      )}

      {on ? (
        <ArchiveOverview
          {...shared}
          running={runStatus?.running === true}
          progress={runStatus?.running ? { done: runStatus.progress.filesDone, total: runStatus.progress.filesTotal } : null}
          lastResult={data?.config.lastResult ?? ''}
          storedRetentionEnabled={storedRetentionEnabled}
          onAdopt={adopt}
          onRunNow={runNow}
          onCancelRun={cancelRun}
          onBrowse={() => setBrowsing(true)}
          onPrune={prune}
          onTurnOff={turnOff}
          onSaveGroup={saveGroup}
          onDiscard={() => setEdits({})}
        />
      ) : wizardStep ? (
        <ArchiveSetupWizard
          {...shared}
          step={wizardStep}
          onStep={setWizardStep}
          onCancel={closeWizard}
          onSaveDisk={saveDisk}
          onFinish={finishSetup}
        />
      ) : (
        <ArchiveIntro
          isDark={isDark}
          configured={configured}
          busy={busy}
          onStart={() => {
            setEdits({});
            setWizardStep('disk');
          }}
          onReview={() => setWizardStep('review')}
        />
      )}

      {browsing && <ArchiveDiskModal isDark={isDark} onClose={() => setBrowsing(false)} />}

      {choosing && (
        <ArchiveDestinationModal
          isDark={isDark}
          config={form}
          networkSupported={data?.destination.networkSupported !== false}
          onChoose={chooseDestination}
          onClose={() => setChoosing(false)}
        />
      )}
    </Sec>
  );
}

/** Where an archive that is off starts. Never a form: a switch that is off and a page of
 *  inert controls under it is what made this screen hard to read. */
function ArchiveIntro({
  isDark,
  configured,
  busy,
  onStart,
  onReview,
}: {
  isDark: boolean;
  configured: boolean;
  busy: boolean;
  onStart: () => void;
  onReview: () => void;
}) {
  const { t } = useTranslation('settings');
  const s = archiveStyles(isDark);
  return (
    <div className="px-5 py-6">
      <div className={`text-[0.875rem] font-semibold ${s.strongText}`}>
        {configured ? t('archive.intro.offTitle') : t('archive.intro.title')}
      </div>
      <p className={`mt-1.5 max-w-xl text-[0.8125rem] leading-relaxed ${s.subText}`}>
        {configured ? t('archive.intro.offBody') : t('archive.intro.body')}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {configured ? (
          <>
            <button type="button" onClick={onReview} disabled={busy} className={`${s.btnBase} ${s.btnPrimary}`}>
              {t('archive.intro.review')}
            </button>
            <button type="button" onClick={onStart} disabled={busy} className={`${s.btnBase} ${s.btnSubtle}`}>
              {t('archive.intro.change')}
            </button>
          </>
        ) : (
          <button type="button" onClick={onStart} disabled={busy} className={`${s.btnBase} ${s.btnPrimary}`}>
            {t('archive.intro.start')}
          </button>
        )}
      </div>
    </div>
  );
}
