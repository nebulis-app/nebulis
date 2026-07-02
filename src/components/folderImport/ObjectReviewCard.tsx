import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Search, Trash2, RotateCcw, Telescope, CircleHelp } from 'lucide-react';
import { searchDsoCatalog } from '../../lib/api/planner';
import { useTheme } from '../../hooks/useTheme';

/** One session's review state. `derivedDate` is the scan's grouping key (kept
 *  stable for the commit sessionMap); `finalDate` is what the user wants. */
interface SessionEdit {
  derivedDate: string;
  finalDate: string;
  drop: boolean;
  fileCount: number;
  confidence: 'high' | 'medium' | 'low' | 'none';
  source: 'fits' | 'filename' | 'folder' | 'mtime' | 'none';
}

export interface ObjectEdit {
  folderName: string;
  fileCount: number;
  bytes: number;
  skip: boolean;
  targetObjectId: string;
  targetFolderName: string;
  /** Display label for the current mapping (catalog name, or null = as-is). */
  catalogName: string | null;
  sessions: SessionEdit[];
  unsortedCount: number;
  /** YYYY-MM-DD to assign unsorted files to, or '' to skip them. */
  unsortedAssign: string;
}

const SOURCE_LABEL: Record<SessionEdit['source'], string> = {
  fits: 'from FITS header',
  filename: 'from filename',
  folder: 'from folder name',
  mtime: 'from file date',
  none: 'no date',
};

export function ObjectReviewCard({
  edit,
  onChange,
}: {
  edit: ObjectEdit;
  onChange: (next: ObjectEdit) => void;
}) {
  const { isDark } = useTheme();
  const [picking, setPicking] = useState(false);

  const card = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';
  const mutedText = isDark ? 'text-slate-500' : 'text-slate-400';
  const inputCls = `px-2.5 py-1.5 rounded-lg border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
    isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-300 text-slate-800'
  }`;

  const update = (patch: Partial<ObjectEdit>) => onChange({ ...edit, ...patch });
  const updateSession = (i: number, patch: Partial<SessionEdit>) =>
    update({ sessions: edit.sessions.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) });

  // Merge preview: which final dates collect more than one source session.
  const finalCounts = new Map<string, number>();
  for (const s of edit.sessions) {
    if (s.drop) continue;
    finalCounts.set(s.finalDate, (finalCounts.get(s.finalDate) ?? 0) + 1);
  }

  const keptFiles =
    edit.sessions.reduce((sum, s) => (s.drop ? sum : sum + s.fileCount), 0) +
    (edit.unsortedAssign ? edit.unsortedCount : 0);

  return (
    <div className={`rounded-xl border ${card} ${edit.skip ? 'opacity-55' : ''}`}>
      {/* Header: folder → object mapping */}
      <div className={`flex items-center gap-3 px-4 py-3 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <input
          type="checkbox"
          checked={!edit.skip}
          onChange={e => update({ skip: !e.target.checked })}
          className="w-4 h-4 accent-accent-500 shrink-0"
          aria-label={`Import ${edit.folderName}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-medium truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
              {edit.folderName}
            </span>
            <ArrowRight className={`w-3.5 h-3.5 shrink-0 ${mutedText}`} />
            <button
              onClick={() => setPicking(v => !v)}
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-sm font-medium transition ${
                edit.catalogName
                  ? isDark ? 'bg-accent-500/15 text-accent-300 hover:bg-accent-500/25' : 'bg-accent-50 text-accent-700 hover:bg-accent-100'
                  : isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              <Telescope className="w-3.5 h-3.5" />
              {edit.catalogName ? `${edit.targetObjectId} · ${edit.catalogName}` : edit.targetObjectId}
            </button>
            {!edit.catalogName && (
              <span className={`inline-flex items-center gap-1 text-xs ${mutedText}`}>
                <CircleHelp className="w-3 h-3" /> no catalog match
              </span>
            )}
          </div>
          <p className={`text-xs mt-0.5 ${mutedText}`}>
            {edit.fileCount} file{edit.fileCount !== 1 ? 's' : ''} · {formatBytes(edit.bytes)} · {edit.sessions.length} session{edit.sessions.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {/* Catalog picker (collapsible) */}
      {picking && (
        <CatalogPicker
          folderName={edit.folderName}
          inputCls={inputCls}
          onPick={(objectId, name) => { update({ targetObjectId: objectId, catalogName: name }); setPicking(false); }}
          onUseAsIs={() => { update({ targetObjectId: edit.folderName, catalogName: null }); setPicking(false); }}
        />
      )}

      {/* Sessions */}
      {!edit.skip && (
        <div className="px-4 py-3 space-y-1.5">
          {edit.sessions.map((s, i) => (
            <div key={s.derivedDate} className={`flex items-center gap-3 ${s.drop ? 'opacity-50' : ''}`}>
              <ConfidenceDot confidence={s.confidence} />
              <input
                type="date"
                value={s.finalDate}
                disabled={s.drop}
                onChange={e => updateSession(i, { finalDate: e.target.value })}
                className={`${inputCls} w-[9.5rem]`}
              />
              <span className={`text-sm ${subText} flex-1`}>
                {s.fileCount} file{s.fileCount !== 1 ? 's' : ''}
                <span className={`ml-2 text-xs ${mutedText}`}>{SOURCE_LABEL[s.source]}</span>
                {!s.drop && (finalCounts.get(s.finalDate) ?? 0) > 1 && (
                  <span className={`ml-2 text-xs ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>merges</span>
                )}
              </span>
              <button
                onClick={() => updateSession(i, { drop: !s.drop })}
                title={s.drop ? 'Keep this session' : 'Skip this session'}
                className={`p-1.5 rounded-lg transition ${
                  s.drop
                    ? isDark ? 'text-slate-500 hover:bg-slate-800' : 'text-slate-400 hover:bg-slate-100'
                    : 'text-red-500 hover:bg-red-500/10'
                }`}
              >
                {s.drop ? <RotateCcw className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
              </button>
            </div>
          ))}

          {/* Unsorted bucket */}
          {edit.unsortedCount > 0 && (
            <div className={`flex items-center gap-3 pt-2 mt-1 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
              <ConfidenceDot confidence="none" />
              <input
                type="date"
                value={edit.unsortedAssign}
                onChange={e => update({ unsortedAssign: e.target.value })}
                className={`${inputCls} w-[9.5rem]`}
                placeholder="skip"
              />
              <span className={`text-sm ${subText} flex-1`}>
                {edit.unsortedCount} file{edit.unsortedCount !== 1 ? 's' : ''} with no detectable date
                <span className={`ml-2 text-xs ${mutedText}`}>
                  {edit.unsortedAssign ? 'assigned' : 'leave blank to skip'}
                </span>
              </span>
            </div>
          )}

          <p className={`text-xs pt-1 ${mutedText}`}>
            {keptFiles} file{keptFiles !== 1 ? 's' : ''} will import.
          </p>
        </div>
      )}
    </div>
  );
}

function ConfidenceDot({ confidence }: { confidence: SessionEdit['confidence'] }) {
  const color =
    confidence === 'high' ? 'bg-emerald-500'
      : confidence === 'medium' ? 'bg-amber-500'
        : confidence === 'low' ? 'bg-orange-500'
          : 'bg-red-500';
  const label =
    confidence === 'high' ? 'High confidence date'
      : confidence === 'medium' ? 'Medium confidence date'
        : confidence === 'low' ? 'Low confidence date'
          : 'No date';
  return <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} title={label} aria-label={label} />;
}

function CatalogPicker({
  folderName,
  inputCls,
  onPick,
  onUseAsIs,
}: {
  folderName: string;
  inputCls: string;
  onPick: (objectId: string, name: string) => void;
  onUseAsIs: () => void;
}) {
  const { isDark } = useTheme();
  const [query, setQuery] = useState(folderName);
  const [debounced, setDebounced] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onType = (q: string) => {
    setQuery(q);
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) { setDebounced(''); return; }
    timer.current = setTimeout(() => setDebounced(q.trim()), 250);
  };

  const { data, isFetching } = useQuery({
    queryKey: ['dso-search', debounced],
    queryFn: () => searchDsoCatalog(debounced, 8),
    enabled: debounced.length > 0,
    staleTime: 30_000,
  });
  const results = data?.results ?? [];
  const mutedText = isDark ? 'text-slate-500' : 'text-slate-400';

  return (
    <div className={`px-4 py-3 border-b ${isDark ? 'border-slate-800 bg-slate-800/40' : 'border-slate-200 bg-slate-50'}`}>
      <div className="relative">
        <Search className={`absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 ${mutedText}`} />
        <input
          autoFocus
          value={query}
          onChange={e => onType(e.target.value)}
          placeholder="Search catalog (M31, NGC 7000, Andromeda...)"
          className={`${inputCls} w-full pl-8`}
        />
      </div>
      <div className="mt-2 max-h-48 overflow-y-auto space-y-0.5">
        {isFetching && <p className={`text-xs px-1 ${mutedText}`}>Searching...</p>}
        {!isFetching && debounced && results.length === 0 && (
          <p className={`text-xs px-1 ${mutedText}`}>No matches.</p>
        )}
        {results.map(r => (
          <button
            key={r.id}
            onClick={() => onPick(r.id, r.name)}
            className={`w-full text-left px-2.5 py-1.5 rounded-lg text-sm transition ${
              isDark ? 'hover:bg-slate-700 text-slate-200' : 'hover:bg-slate-200 text-slate-800'
            }`}
          >
            <span className="font-medium">{r.id}</span>
            <span className={`ml-2 ${mutedText}`}>{r.name}</span>
            <span className={`ml-2 text-xs ${mutedText}`}>{r.type}{r.constellation ? ` · ${r.constellation}` : ''}</span>
          </button>
        ))}
      </div>
      <button
        onClick={onUseAsIs}
        className={`mt-2 text-xs ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
      >
        Use folder name "{folderName}" as-is
      </button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
