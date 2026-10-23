import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { X, RotateCw, AlertCircle, CheckCircle2, FolderSearch, Link2, EyeOff, ArrowLeft, ArrowRight } from 'lucide-react';
import {
  scanLinkFolder,
  linkFolder,
  type LinkOverride,
  type LinkScanObject,
  type LinkScanUnresolved,
} from '../../lib/api/librarySources';
import { useTheme } from '../../hooks/useTheme';
import { formatBytes } from '../../lib/utils';
import { DEFAULT_REFRESH_MINUTES } from '../../lib/linkRefresh';
import { Modal } from '../ui/Modal';
import { SkippedNotice } from '../SkippedNotice';
import { ImportStepIndicator } from '../ImportStepIndicator';
import { CatalogPicker, ObjectReviewCard, type ObjectEdit } from './ObjectReviewCard';
import { LinkRefreshChoice } from '../ui/LinkRefreshChoice';

type Phase = 'scanning' | 'review' | 'schedule' | 'linking' | 'done';

/** What the user decided for one folder the scan could not attribute. */
type Decision = { action: 'assign'; objectId: string; name: string | null } | { action: 'ignore' };

/** A scanned object as the shared review card wants it. Nothing here is editable except whether the object is
 *  included and which object it is filed under: a link never renames or moves a file. */
function toEdit(o: LinkScanObject): ObjectEdit {
  return {
    folderName: o.sourceName,
    fileCount: o.fileCount,
    bytes: o.bytes,
    skip: false,
    targetObjectId: o.objectId,
    targetFolderName: o.sourceName,
    catalogName: o.catalogMatch?.name ?? null,
    aliases: [...o.aliases, ...o.nicknames],
    sessions: o.sessions.map(s => ({
      derivedDate: s.date, finalDate: s.date, drop: false, fileCount: s.fileCount, confidence: s.confidence, source: s.source,
    })),
    unsortedCount: o.unsortedCount,
    unsortedAssign: '',
  };
}

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/**
 * "Link a folder": index a folder in place instead of copying it. Same scan →
 * review → commit shape as the copy wizard, but nothing is written to the
 * library folder and the files stay where they are. Folders the scan cannot
 * attribute to an object are listed for the user to assign or ignore.
 */
export function LinkFolderWizard({
  rootPath,
  includeSubframes = false,
  includeFits = true,
  onClose,
  onDone,
  onBack,
}: {
  rootPath: string;
  includeSubframes?: boolean;
  includeFits?: boolean;
  onClose: () => void;
  onDone: () => void;
  /** Step back to the options this review followed. Without it the footer offers Cancel instead. */
  onBack?: () => void;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('library');
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('scanning');
  const [label, setLabel] = useState(() => baseName(rootPath));
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [picking, setPicking] = useState<string | null>(null);
  /** One review card per scanned object, in scan order. A card that is left out, or filed under a different
   *  object, becomes one override per directory the object lives in when linking. */
  const [edits, setEdits] = useState<ObjectEdit[]>([]);
  const [linked, setLinked] = useState<{ objects: number; files: number } | null>(null);
  /** The last screen before linking: index once, or keep the folder up to date on a schedule. */
  const [ongoing, setOngoing] = useState(false);
  const [refreshMinutes, setRefreshMinutes] = useState<number>(DEFAULT_REFRESH_MINUTES);

  const card = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';
  const mutedText = isDark ? 'text-slate-500' : 'text-slate-400';
  const border = isDark ? 'border-slate-800' : 'border-slate-200';
  const strong = isDark ? 'text-slate-200' : 'text-slate-800';
  const inputCls = `px-2.5 py-1.5 rounded-lg border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
    isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-300 text-slate-800'
  }`;

  const scan = useMutation({
    mutationFn: () => scanLinkFolder(rootPath, { importSubFrames: includeSubframes, importFits: includeFits }),
    onSuccess: res => { setEdits(res.objects.map(toEdit)); setPhase('review'); },
  });
  const { mutate: startScan } = scan;
  useEffect(() => { startScan(); }, [startScan]);

  const commit = useMutation({
    mutationFn: () => {
      const overrides: LinkOverride[] = Object.entries(decisions).map(([dirPath, d]) =>
        d.action === 'ignore'
          ? { dirPath, action: 'ignore' }
          : { dirPath, action: 'assign', objectId: d.objectId });
      // Leaving an object out, or filing it under another, is one override per directory it lives in, so every
      // folder of it (a _sub companion, a second session) goes to the same place. An object that shares a
      // folder with another is locked in the card, so it never gets here changed.
      (scan.data?.objects ?? []).forEach((o, i) => {
        const edit = edits[i];
        if (!edit || !o.reassignable) return;
        if (edit.skip) {
          for (const dirPath of o.dirPaths) overrides.push({ dirPath, action: 'ignore' });
        } else if (edit.targetObjectId !== o.objectId) {
          for (const dirPath of o.dirPaths) overrides.push({ dirPath, action: 'assign', objectId: edit.targetObjectId });
        }
      });
      return linkFolder(rootPath, label.trim() || baseName(rootPath), overrides, {
        importSubFrames: includeSubframes,
        importFits: includeFits,
        refreshIntervalMin: ongoing ? refreshMinutes : null,
      });
    },
    onMutate: () => setPhase('linking'),
    onSuccess: res => {
      setLinked({ objects: res.objectsLinked, files: res.filesLinked });
      setPhase('done');
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      queryClient.invalidateQueries({ queryKey: ['linked-sources'] });
      onDone();
    },
    onError: () => setPhase('schedule'),
  });

  const result = scan.data;
  const assignedCount = useMemo(() => Object.values(decisions).filter(d => d.action === 'assign').length, [decisions]);
  const decide = (dirPath: string, d: Decision | null) =>
    setDecisions(prev => {
      const next = { ...prev };
      if (d) next[dirPath] = d; else delete next[dirPath];
      return next;
    });

  const selected = useMemo(() => edits.filter(e => !e.skip), [edits]);
  const totals = useMemo(() => ({
    objects: selected.length,
    files: selected.reduce((n, e) => n + e.fileCount, 0),
    sessions: selected.reduce((n, e) => n + e.sessions.length, 0),
  }), [selected]);
  const canLink = !!result && selected.length + assignedCount > 0 && label.trim().length > 0 && !commit.isPending;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('linkFolderWizard.modalTitle')}
      className={`relative w-full max-w-3xl max-h-[88vh] flex flex-col rounded-2xl border shadow-2xl ${card}`}
    >
      <div className={`flex items-center justify-between px-6 py-4 border-b ${border}`}>
        <div className="min-w-0">
          <h2 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {t('linkFolderWizard.heading')}
          </h2>
          <p className={`text-xs mt-0.5 font-mono truncate ${mutedText}`}>{rootPath}</p>
        </div>
        <button
          onClick={onClose}
          aria-label={t('linkFolderWizard.close')}
          className={`p-1.5 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {(phase === 'scanning' || phase === 'review' || phase === 'schedule') && (
          <div className="mb-5">
            <ImportStepIndicator step={3} linking isDark={isDark} />
          </div>
        )}
        {phase === 'scanning' && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            {scan.isError ? (
              <>
                <AlertCircle className="w-8 h-8 text-red-500" />
                <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  {scan.error instanceof Error ? scan.error.message : t('linkFolderWizard.scanFailed')}
                </p>
                <div className="flex gap-2 mt-1">
                  <button onClick={() => scan.mutate()} className={`px-3 py-1.5 rounded-lg text-sm border ${border} ${subText}`}>
                    {t('linkFolderWizard.tryAgain')}
                  </button>
                  <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm bg-accent-500 text-white">
                    {t('linkFolderWizard.close')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <FolderSearch className={`w-8 h-8 ${isDark ? 'text-accent-400' : 'text-accent-500'} animate-pulse`} />
                <p className={`text-sm ${subText}`}>{t('linkFolderWizard.scanning')}</p>
              </>
            )}
          </div>
        )}

        {phase === 'review' && result && (
          <div className="space-y-4">
            <div className={`flex items-start gap-2 p-3 rounded-xl text-sm ${isDark ? 'bg-sky-500/10 text-sky-300' : 'bg-sky-50 text-sky-700'}`}>
              <Link2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{t('linkFolderWizard.inPlaceNote')}</span>
            </div>

            {result.truncated && (
              <div className={`flex items-start gap-2 p-3 rounded-xl text-sm ${isDark ? 'bg-amber-500/10 text-amber-300' : 'bg-amber-50 text-amber-700'}`}>
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                {t('linkFolderWizard.truncatedWarning')}
              </div>
            )}

            {result.depthLimited && (
              <div className={`flex items-start gap-2 p-3 rounded-xl text-sm ${isDark ? 'bg-amber-500/10 text-amber-300' : 'bg-amber-50 text-amber-700'}`}>
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                {t('linkFolderWizard.depthWarning')}
              </div>
            )}

            <label className="block">
              <span className={`text-xs font-medium ${subText}`}>{t('linkFolderWizard.nameLabel')}</span>
              <input
                value={label}
                maxLength={120}
                onChange={e => setLabel(e.target.value)}
                className={`${inputCls} w-full mt-1`}
              />
              <span className={`block text-xs mt-1 ${mutedText}`}>{t('linkFolderWizard.nameHint')}</span>
            </label>

            {result.objects.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <FolderSearch className={`w-8 h-8 ${mutedText}`} />
                <p className={`text-sm ${subText}`}>{t('linkFolderWizard.noObjects')}</p>
                <SkippedNotice skipped={result.skipped} isDark={isDark} excludedFolders={result.excludedFolders} archiveHint={false} heading={n => t('linkFolderWizard.skippedLead', { count: n })} />
              </div>
            ) : (
              <>
                <div className={`flex items-center gap-2 text-sm ${subText}`}>
                  <span>{t('folderImportWizard.objectsFound', { count: result.objects.length })}</span>
                  <span className={mutedText}>{t('linkFolderWizard.confirmHint')}</span>
                </div>
                <SkippedNotice skipped={result.skipped} isDark={isDark} excludedFolders={result.excludedFolders} archiveHint={false} heading={n => t('linkFolderWizard.skippedLead', { count: n })} />
                <div className="space-y-3">
                  {result.objects.map((o, i) => edits[i] && (
                    <ObjectReviewCard
                      key={o.objectId}
                      mode="link"
                      edit={edits[i]}
                      onChange={next => setEdits(prev => prev.map((e, idx) => (idx === i ? next : e)))}
                      lockedReason={o.reassignable ? undefined : t('linkFolderWizard.changeObjectUnavailable')}
                      resetTo={{ targetObjectId: o.objectId, catalogName: o.catalogMatch?.name ?? null, aliases: [...o.aliases, ...o.nicknames] }}
                    />
                  ))}
                </div>
              </>
            )}

            {result.disagreements.length > 0 && (
              <p className={`text-xs ${mutedText}`}>
                {t('linkFolderWizard.disagreements', { count: result.disagreements.length })}
              </p>
            )}

            {result.unresolved.length > 0 && (
              <section className={`rounded-xl border ${border}`}>
                <div className={`px-4 py-3 border-b ${border}`}>
                  <h3 className={`text-sm font-medium ${strong}`}>{t('linkFolderWizard.unresolvedTitle', { count: result.unresolved.length })}</h3>
                  <p className={`text-xs mt-0.5 ${mutedText}`}>{t('linkFolderWizard.unresolvedHint')}</p>
                </div>
                <ul className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-slate-100'}`}>
                  {result.unresolved.map(u => (
                    <UnresolvedRow
                      key={u.dirPath}
                      item={u}
                      rootName={baseName(rootPath)}
                      decision={decisions[u.dirPath] ?? null}
                      picking={picking === u.dirPath}
                      inputCls={inputCls}
                      isDark={isDark}
                      onTogglePick={() => setPicking(p => (p === u.dirPath ? null : u.dirPath))}
                      onDecide={d => { decide(u.dirPath, d); setPicking(null); }}
                    />
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {phase === 'schedule' && (
          <div className="space-y-4">
            <div>
              <h3 className={`text-sm font-medium ${strong}`}>{t('linkFolderWizard.scheduleTitle')}</h3>
              <p className={`text-xs mt-0.5 ${mutedText}`}>{t('linkFolderWizard.scheduleIntro')}</p>
            </div>
            <LinkRefreshChoice
              ongoing={ongoing}
              minutes={refreshMinutes}
              onOngoingChange={setOngoing}
              onMinutesChange={setRefreshMinutes}
              isDark={isDark}
              inputCls={inputCls}
            />

            <p className={`text-xs ${mutedText}`}>{t('linkFolderWizard.refreshChangeLater')}</p>
          </div>
        )}

        {phase === 'linking' && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <RotateCw className={`w-8 h-8 animate-spin ${isDark ? 'text-accent-400' : 'text-accent-500'}`} />
            <p className={`text-sm ${subText}`}>{t('linkFolderWizard.linking')}</p>
          </div>
        )}

        {phase === 'done' && linked && (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <p className={`font-medium ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{t('linkFolderWizard.linkedTitle')}</p>
            <p className={`text-sm max-w-md ${subText}`}>
              {t('linkFolderWizard.linkedBody', {
                objects: t('linkFolderWizard.objectsCount', { count: linked.objects }),
                files: t('linkFolderWizard.filesCount', { count: linked.files }),
              })}
            </p>
          </div>
        )}
      </div>

      {phase === 'review' && result && (
        <div className={`flex items-center justify-between gap-3 px-6 py-4 border-t ${border}`}>
          <div className="min-w-0">
            {result.objects.length > 0 && (
              <>
                <p className={`text-sm ${subText}`}>
                  <Trans
                    i18nKey="linkFolderWizard.linkSummary"
                    ns="library"
                    values={{
                      files: t('linkFolderWizard.filesCount', { count: totals.files }),
                      sessions: t('linkFolderWizard.sessionsCount', { count: totals.sessions }),
                      objects: t('linkFolderWizard.objectsCount', { count: totals.objects }),
                    }}
                    components={{ 1: <span className={strong} />, 3: <span className={strong} /> }}
                  />
                </p>
                <p className={`text-xs mt-0.5 ${mutedText}`}>{t('linkFolderWizard.linkNotice')}</p>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onBack ? (
              <button
                onClick={onBack}
                disabled={commit.isPending}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border transition disabled:opacity-50 ${border} ${subText} ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-50'}`}
              >
                <ArrowLeft className="w-4 h-4" />
                {t('importModal.back')}
              </button>
            ) : (
              <button onClick={onClose} className={`px-4 py-2 rounded-xl text-sm font-medium border transition ${border} ${subText} ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-50'}`}>
                {t('linkFolderWizard.cancel')}
              </button>
            )}
            <button
              onClick={() => setPhase('schedule')}
              disabled={!canLink}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
            >
              {t('linkFolderWizard.continue')} <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {phase === 'schedule' && (
        <div className={`flex items-center justify-between gap-3 px-6 py-4 border-t ${border}`}>
          <div className="min-w-0">
            <p className={`text-xs ${mutedText}`}>{t('linkFolderWizard.linkNotice')}</p>
            {commit.isError && (
              <p className="text-xs text-red-500 mt-0.5">
                {commit.error instanceof Error ? commit.error.message : t('linkFolderWizard.linkFailed')}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setPhase('review')}
              disabled={commit.isPending}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border transition disabled:opacity-50 ${border} ${subText} ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-50'}`}
            >
              <ArrowLeft className="w-4 h-4" />
              {t('importModal.back')}
            </button>
            <button
              onClick={() => commit.mutate()}
              disabled={!canLink}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
            >
              <Link2 className="w-4 h-4" /> {t('linkFolderWizard.link')}
            </button>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className={`flex items-center justify-end px-6 py-4 border-t ${border}`}>
          <button onClick={onClose} className="px-5 py-2 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition">
            {t('linkFolderWizard.done')}
          </button>
        </div>
      )}
    </Modal>
  );
}

function UnresolvedRow({
  item, rootName, decision, picking, inputCls, isDark, onTogglePick, onDecide,
}: {
  item: LinkScanUnresolved;
  rootName: string;
  decision: Decision | null;
  picking: boolean;
  inputCls: string;
  isDark: boolean;
  onTogglePick: () => void;
  onDecide: (d: Decision | null) => void;
}) {
  const { t } = useTranslation('library');
  const mutedText = isDark ? 'text-slate-500' : 'text-slate-400';
  const btn = `px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
    isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
  }`;
  const name = baseName(item.dirPath) === '' || item.dirPath === '' ? rootName : baseName(item.dirPath);
  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-mono truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`} title={item.dirPath || '/'}>
            {item.dirPath || '/'}
          </p>
          <p className={`text-xs ${mutedText}`}>
            {t('linkFolderWizard.filesCount', { count: item.fileCount })} · {formatBytes(item.bytes)}
            {decision?.action === 'assign' && <span className="ml-2 text-emerald-500">{t('linkFolderWizard.assignedTo', { id: decision.objectId })}</span>}
            {decision?.action === 'ignore' && <span className="ml-2">{t('linkFolderWizard.ignored')}</span>}
          </p>
        </div>
        {decision ? (
          <button onClick={() => onDecide(null)} className={btn}>{t('linkFolderWizard.undo')}</button>
        ) : (
          <>
            <button onClick={onTogglePick} className={btn}>{t('linkFolderWizard.assign')}</button>
            <button onClick={() => onDecide({ action: 'ignore' })} className={`${btn} inline-flex items-center gap-1`}>
              <EyeOff className="w-3 h-3" /> {t('linkFolderWizard.ignore')}
            </button>
          </>
        )}
      </div>
      {picking && (
        <CatalogPicker
          folderName={name}
          inputCls={inputCls}
          onPick={(objectId, objectName) => onDecide({ action: 'assign', objectId, name: objectName })}
          onUseAsIs={() => onDecide({ action: 'assign', objectId: name, name: null })}
        />
      )}
    </li>
  );
}
