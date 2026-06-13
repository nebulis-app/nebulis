/**
 * Hub landing — the help center home.
 *
 * Five regions, top to bottom:
 *   1. Hero with prominent search, quick actions, ⌘K hint
 *   2. "Start here" numbered lane (4 short steps)
 *   3. Topic grid (8 coloured cards, 4×2 on desktop)
 *   4. Most read this week
 *   5. Hub FAQ + footer status strip
 *
 * Stateless aside from "go to article" callbacks the parent owns.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Search, ArrowRight, X, ChevronRight,
} from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import {
  TOPICS, QUICK_ACTIONS, START_HERE, HUB_FAQ,
  searchArticles, allArticles, getArticle, type TopicMeta,
} from './helpData';
import { Faq, toneClasses } from './HelpPrimitives';

export type HelpHubProps = {
  onOpenArticle: (id: string) => void;
  onOpenTopic: (id: string) => void;
};

export function HelpHub({ onOpenArticle, onOpenTopic }: HelpHubProps) {
  const { isDark } = useTheme();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘K → focus search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = query.trim() ? searchArticles(query) : [];

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && results[active]) { onOpenArticle(results[active].article.id); }
    else if (e.key === 'Escape') { setQuery(''); }
  }

  // ── Theme tokens ───────────────────────────────────────────────────
  const heading = isDark ? 'text-slate-100' : 'text-slate-900';
  const body    = isDark ? 'text-slate-300' : 'text-slate-600';
  const muted   = isDark ? 'text-slate-500' : 'text-slate-500';
  const card    = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const cardAlt = isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-50 border-slate-200';
  const inputCls= isDark
    ? 'bg-slate-900 border-slate-700 text-slate-100 placeholder-slate-500 focus:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-500/40'
    : 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 focus:border-accent-400 focus-visible:ring-2 focus-visible:ring-accent-500/40';

  return (
    <div className="max-w-[1080px] mx-auto px-4 sm:px-6 lg:px-8 py-10">

      {/* ───── 1. Hero ────────────────────────────────────────────── */}
      <section className="mb-14">
        <p className={`text-xs font-bold uppercase tracking-widest mb-3 ${muted}`}>Help center</p>
        <h1 className={`font-display text-4xl sm:text-5xl font-bold tracking-tight mb-4 ${heading}`}>
          How can we help?
        </h1>
        <p className={`text-base max-w-xl mb-8 ${body}`} style={{ textWrap: 'pretty' as const }}>
          Search the docs, browse by topic, or ask Nebulis anything in plain English.
        </p>

        {/* Search */}
        <div className="relative max-w-2xl">
          <Search className={`absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 ${muted}`} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onSearchKey}
            placeholder="Search help: try 'pair seestar' or 'planner empty'"
            className={`w-full pl-12 pr-24 py-4 text-base rounded-2xl border outline-none transition-colors shadow-sm ${inputCls}`}
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
            {query && (
              <button onClick={() => setQuery('')} className={`p-1 rounded-md ${muted} hover:text-slate-300`}>
                <X className="w-4 h-4" />
              </button>
            )}
            <kbd className={`hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-medium ${
              isDark ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-slate-100 border-slate-200 text-slate-500'
            }`}>⌘K</kbd>
          </div>

          {/* Search results dropdown */}
          {query && results.length > 0 && (
            <div className={`absolute z-20 left-0 right-0 mt-2 rounded-2xl border shadow-xl overflow-hidden ${card}`}>
              {results.map((r, i) => (
                <button
                  key={r.article.id}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => onOpenArticle(r.article.id)}
                  className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors ${
                    i === active
                      ? (isDark ? 'bg-slate-800' : 'bg-slate-100')
                      : (isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-50')
                  }`}
                >
                  <span className={`mt-0.5 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider shrink-0 ${
                    isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-200 text-slate-600'
                  }`}>
                    {r.topic.label}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm font-semibold truncate ${heading}`}>{r.article.title}</span>
                    <span className={`block text-xs truncate ${muted}`}>{r.article.summary}</span>
                  </span>
                  <ArrowRight className={`w-4 h-4 mt-1 shrink-0 ${muted}`} />
                </button>
              ))}
            </div>
          )}
          {query && results.length === 0 && (
            <div className={`absolute z-20 left-0 right-0 mt-2 px-4 py-3 rounded-2xl border text-sm ${cardAlt} ${muted}`}>
              No matches for <strong>"{query}"</strong>. Try fewer words or browse a topic below.
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div className="flex flex-wrap gap-2 mt-5">
          {QUICK_ACTIONS.map(qa => (
            <button
              key={qa.id}
              onClick={() => onOpenArticle(qa.id)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                isDark
                  ? 'bg-slate-900 border-slate-700 text-slate-300 hover:border-accent-500/50 hover:text-accent-300'
                  : 'bg-white border-slate-300 text-slate-700 hover:border-accent-400 hover:text-accent-700'
              }`}
            >
              {qa.label}
            </button>
          ))}
        </div>
      </section>

      {/* ───── 2. Start here ──────────────────────────────────────── */}
      <section className="mb-14">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className={`text-lg font-bold ${heading}`}>Start here</h2>
          <span className={`text-xs ${muted}`}>4 steps · ~10 minutes</span>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {START_HERE.map((s, i) => (
            <button
              key={s.id}
              onClick={() => onOpenArticle(s.id)}
              className={`group flex flex-col gap-2 p-4 rounded-xl border text-left transition-all ${
                isDark
                  ? 'bg-slate-900 border-slate-800 hover:border-accent-500/40 hover:bg-slate-800/40'
                  : 'bg-white border-slate-200 hover:border-accent-400 hover:shadow-md'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-3xl font-bold ${isDark ? 'text-slate-700' : 'text-slate-200'} group-hover:text-accent-500 transition-colors`}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <ArrowRight className={`w-4 h-4 ${muted} opacity-0 group-hover:opacity-100 transition-opacity`} />
              </div>
              <p className={`text-xs font-bold uppercase tracking-wider ${muted}`}>{s.step}</p>
              <p className={`text-sm font-semibold ${heading}`}>{s.label}</p>
            </button>
          ))}
        </div>
      </section>

      {/* ───── 3. Topic grid ──────────────────────────────────────── */}
      <section className="mb-14">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className={`text-lg font-bold ${heading}`}>Browse by topic</h2>
          <span className={`text-xs ${muted}`}>{allArticles().length} articles · {TOPICS.length} topics</span>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {TOPICS.map(topic => (
            <TopicCard key={topic.id} topic={topic} onOpen={() => onOpenTopic(topic.id)} />
          ))}
        </div>
      </section>

      {/* ───── 4. Popular articles ────────────────────────────────── */}
      <section className="mb-14">
        <div className={`rounded-2xl border p-5 ${card}`}>
          <div className="mb-4">
            <h2 className={`text-sm font-bold ${heading}`}>Popular articles</h2>
          </div>
          <div className="flex flex-col">
            {allArticles().filter(a => a.article.popular).slice(0, 5).map(({ topic, article }, i, arr) => (
              <button
                key={article.id}
                onClick={() => onOpenArticle(article.id)}
                className={`group flex items-center gap-3 py-3 text-left transition-colors ${i < arr.length - 1 ? `border-b ${isDark ? 'border-slate-800' : 'border-slate-100'}` : ''}`}
              >
                <span className={`text-xs font-bold w-5 ${muted}`}>{i + 1}</span>
                <span className="flex-1 min-w-0">
                  <span className={`block text-sm font-semibold truncate ${heading} group-hover:text-accent-500 transition-colors`}>{article.title}</span>
                  <span className={`block text-[11px] uppercase tracking-wider ${muted}`}>{topic.label} · {article.readingMinutes} min</span>
                </span>
                <ChevronRight className={`w-4 h-4 ${muted} opacity-0 group-hover:opacity-100 transition-opacity`} />
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ───── 5. FAQ + footer ────────────────────────────────────── */}
      <section className="mb-12">
        <h2 className={`text-lg font-bold mb-4 ${heading}`}>Frequently asked</h2>
        <div className="flex flex-col gap-2">
          {HUB_FAQ.map((f, i) => (
            <Faq key={i} q={f.q} defaultOpen={i === 0}>{f.a}</Faq>
          ))}
        </div>
      </section>

      <FooterStrip />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */

function TopicCard({ topic, onOpen }: { topic: TopicMeta; onOpen: () => void }) {
  const { isDark } = useTheme();
  const t = toneClasses(topic.tone, isDark);
  const Icon = topic.icon;
  const wrap = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const heading = isDark ? 'text-slate-100' : 'text-slate-900';
  const body = isDark ? 'text-slate-400' : 'text-slate-500';
  const muted = isDark ? 'text-slate-500' : 'text-slate-500';

  return (
    <button
      onClick={onOpen}
      className={`group relative overflow-hidden text-left rounded-2xl border p-5 transition-all ${wrap} ${t.ring} hover:shadow-md`}
    >
      {/* Tinted wash in the top-right corner */}
      <div className={`absolute -top-12 -right-12 w-40 h-40 rounded-full bg-gradient-to-br ${t.wash} to-transparent opacity-70 pointer-events-none`} />
      <div className="relative">
        <div className={`inline-flex items-center justify-center w-10 h-10 rounded-xl mb-4 ${t.chipBg} ${t.chipText}`}>
          <Icon className="w-5 h-5" />
        </div>
        <h3 className={`text-base font-bold mb-1.5 ${heading}`}>{topic.label}</h3>
        <p className={`text-xs leading-relaxed mb-4 ${body}`} style={{ textWrap: 'pretty' as const }}>{topic.tagline}</p>
        <div className="flex items-center justify-between">
          <span className={`text-[11px] font-medium ${muted}`}>{topic.articles.length} article{topic.articles.length === 1 ? '' : 's'}</span>
          <ArrowRight className={`w-4 h-4 ${muted} group-hover:translate-x-0.5 transition-transform`} />
        </div>
      </div>
    </button>
  );
}

/* ────────────────────────────────────────────────────────────────────── */

function FooterStrip() {
  const { isDark } = useTheme();

  const card      = isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-slate-50 border-slate-200';
  const muted     = isDark ? 'text-slate-500' : 'text-slate-400';
  const nameColor = isDark ? 'text-slate-300' : 'text-slate-600';

  return (
    <div className={`rounded-2xl border px-5 py-4 flex items-center gap-4 ${card}`}>
      <div>
        <p className={`text-xs font-medium ${nameColor}`}>Nebulis</p>
        <p className={`text-[11px] ${muted}`}>Created by Brent Catoe</p>
      </div>
    </div>
  );
}

/* Re-export so HelpPage can deep-link without importing from helpData. */
export { getArticle };
