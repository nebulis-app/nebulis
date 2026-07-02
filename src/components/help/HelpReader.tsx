/**
 * Article reader.
 *
 * Three-column layout: topic sidebar (article list within current topic),
 * article body (rendered from HelpArticles.tsx), on-this-page anchor list.
 *
 * The header carries breadcrumbs (Help → Topic → Article), the article
 * title with a reading-time chip, and a feedback bar at the bottom with a
 * prev/next pager so the user can read a topic end-to-end.
 */

import { useEffect, useRef } from 'react';
import {
  ChevronLeft, ChevronRight, ArrowLeft, Clock, ThumbsUp, ThumbsDown,
  Hash,
} from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { getArticle, getTopic, type TopicMeta, type ArticleMeta } from './helpData';
import { renderArticleBody } from './HelpArticles';
import { toneClasses } from './HelpPrimitives';

type HelpReaderProps = {
  articleId: string;
  onOpenArticle: (id: string) => void;
  onOpenTopic: (id: string) => void;
  onHome: () => void;
};

export function HelpReader({ articleId, onOpenArticle, onOpenTopic, onHome }: HelpReaderProps) {
  const { isDark } = useTheme();
  const lookup = getArticle(articleId);
  const bodyRef = useRef<HTMLElement>(null);

  // Scroll to top whenever the article id changes
  useEffect(() => {
    bodyRef.current?.scrollTo?.({ top: 0, behavior: 'instant' });
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'instant' });
  }, [articleId]);

  // Theme tokens
  const heading = isDark ? 'text-slate-100' : 'text-slate-900';
  const body    = isDark ? 'text-slate-300' : 'text-slate-600';
  const muted   = isDark ? 'text-slate-500' : 'text-slate-500';
  const divider = isDark ? 'border-slate-800' : 'border-slate-200';

  if (!lookup) {
    return (
      <div className="max-w-[720px] mx-auto px-6 py-16 text-center">
        <p className={`text-sm ${muted} mb-4`}>Article not found</p>
        <button onClick={onHome} className="text-sm font-semibold text-accent-500 hover:text-accent-600">
          ← Back to help center
        </button>
      </div>
    );
  }

  const { topic, article } = lookup;
  const t = toneClasses(topic.tone, isDark);

  // Sibling articles for prev/next + sidebar list
  const idx = topic.articles.findIndex(a => a.id === articleId);
  const prev = idx > 0 ? topic.articles[idx - 1] : null;
  const next = idx < topic.articles.length - 1 ? topic.articles[idx + 1] : null;

  return (
    <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Breadcrumb */}
      <nav className={`flex items-center gap-1.5 text-xs mb-6 ${muted}`}>
        <button onClick={onHome} className="hover:text-accent-500 transition-colors">Help</button>
        <ChevronRight className="w-3 h-3 opacity-50" />
        <button onClick={() => onOpenTopic(topic.id)} className="hover:text-accent-500 transition-colors">
          {topic.label}
        </button>
        <ChevronRight className="w-3 h-3 opacity-50" />
        <span className={`truncate ${heading}`}>{article.title}</span>
      </nav>

      <div className="grid lg:grid-cols-[220px_minmax(0,1fr)_200px] gap-8">

        {/* ── LEFT: topic articles ─────────────────────────────────── */}
        <aside className="hidden lg:block">
          <div className="sticky top-6">
            <div className="flex items-center gap-2 mb-4">
              <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg ${t.chipBg} ${t.chipText}`}>
                <topic.icon className="w-3.5 h-3.5" />
              </span>
              <p className={`text-xs font-bold uppercase tracking-wider ${muted}`}>{topic.label}</p>
            </div>
            <ul className={`flex flex-col gap-px border-l ${divider} pl-3`}>
              {topic.articles.map(a => {
                const isActive = a.id === articleId;
                return (
                  <li key={a.id}>
                    <button
                      onClick={() => onOpenArticle(a.id)}
                      className={`w-full text-left text-xs leading-snug py-1.5 px-2 -ml-px rounded transition-colors ${
                        isActive
                          ? `font-semibold ${t.chipText} ${isDark ? 'bg-slate-800/60' : 'bg-slate-100'}`
                          : `${muted} hover:${heading.replace('text-', 'text-')} ${isDark ? 'hover:bg-slate-800/40' : 'hover:bg-slate-100'}`
                      }`}
                    >
                      {a.title}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>

        {/* ── CENTER: article body ─────────────────────────────────── */}
        <article ref={bodyRef} className="min-w-0">
          <header className={`pb-6 mb-6 border-b ${divider}`}>
            <button
              onClick={() => onOpenTopic(topic.id)}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold ${t.chipText} mb-3 hover:opacity-80`}
            >
              <ArrowLeft className="w-3 h-3" />
              All {topic.label.toLowerCase()} articles
            </button>
            <h1 className={`font-display text-3xl sm:text-4xl font-bold tracking-tight mb-3 ${heading}`} style={{ textWrap: 'balance' as const }}>
              {article.title}
            </h1>
            <p className={`text-base leading-relaxed ${body}`} style={{ textWrap: 'pretty' as const }}>
              {article.summary}
            </p>
            <div className="flex items-center gap-3 mt-4">
              <span className={`inline-flex items-center gap-1.5 text-xs ${muted}`}>
                <Clock className="w-3.5 h-3.5" />
                {article.readingMinutes} min read
              </span>
              {article.updated && (
                <span className={`text-xs ${muted}`}>· Updated {article.updated}</span>
              )}
            </div>
          </header>

          {/* Body */}
          <div className="help-article">
            {renderArticleBody(article.id) ?? (
              <p className={`text-sm ${muted} italic`}>
                Article body coming soon. Browse the topic for related content.
              </p>
            )}
          </div>

          {/* Feedback */}
          <div className={`mt-12 pt-6 border-t ${divider} flex items-center justify-between flex-wrap gap-4`}>
            <p className={`text-sm font-medium ${heading}`}>Was this helpful?</p>
            <div className="flex items-center gap-2">
              <button className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                isDark
                  ? 'border-slate-700 text-slate-300 hover:bg-emerald-500/10 hover:border-emerald-500/40 hover:text-emerald-300'
                  : 'border-slate-300 text-slate-700 hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-700'
              }`}>
                <ThumbsUp className="w-3.5 h-3.5" /> Yes
              </button>
              <button className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                isDark
                  ? 'border-slate-700 text-slate-300 hover:bg-rose-500/10 hover:border-rose-500/40 hover:text-rose-300'
                  : 'border-slate-300 text-slate-700 hover:bg-rose-50 hover:border-rose-300 hover:text-rose-700'
              }`}>
                <ThumbsDown className="w-3.5 h-3.5" /> No
              </button>
            </div>
          </div>

          {/* Pager */}
          <div className={`mt-6 grid sm:grid-cols-2 gap-3`}>
            <Pager dir="prev" article={prev} topic={topic} onOpen={onOpenArticle} />
            <Pager dir="next" article={next} topic={topic} onOpen={onOpenArticle} />
          </div>
        </article>

        {/* ── RIGHT: on this page (placeholder, derived from H3s) ─── */}
        <aside className="hidden xl:block">
          <div className="sticky top-6">
            <p className={`text-[10px] font-bold uppercase tracking-widest mb-3 ${muted}`}>On this page</p>
            <ul className="flex flex-col gap-1.5">
              {derivedAnchors(article).map(a => (
                <li key={a}>
                  <span className={`text-xs flex items-center gap-1.5 ${muted}`}>
                    <Hash className="w-3 h-3 opacity-60" />
                    {a}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */

function Pager({
  dir, article, topic, onOpen,
}: {
  dir: 'prev' | 'next';
  article: ArticleMeta | null;
  topic: TopicMeta;
  onOpen: (id: string) => void;
}) {
  const { isDark } = useTheme();
  const heading = isDark ? 'text-slate-100' : 'text-slate-900';
  const muted   = isDark ? 'text-slate-500' : 'text-slate-500';
  const card    = isDark ? 'bg-slate-900 border-slate-800 hover:border-accent-500/40' : 'bg-white border-slate-200 hover:border-accent-400';

  if (!article) {
    return <div /> /* keep grid alignment */;
  }

  return (
    <button
      onClick={() => onOpen(article.id)}
      className={`flex flex-col gap-1 p-4 rounded-xl border text-left transition-colors ${card} ${dir === 'next' ? 'sm:items-end sm:text-right' : ''}`}
    >
      <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider ${muted}`}>
        {dir === 'prev' && <ChevronLeft className="w-3 h-3" />}
        {dir === 'prev' ? 'Previous' : 'Next'} in {topic.label.toLowerCase()}
        {dir === 'next' && <ChevronRight className="w-3 h-3" />}
      </span>
      <span className={`text-sm font-semibold truncate ${heading}`}>{article.title}</span>
    </button>
  );
}

/** Cheap derived anchors so the right rail isn't empty. Real impl would
 *  parse the rendered DOM for h2/h3 headings. */
function derivedAnchors(article: ArticleMeta): string[] {
  // Most articles have an Overview + Steps. Use article-keyword hints if any.
  const base = ['Overview', 'Steps', 'Tips & gotchas'];
  if (article.keywords?.includes('compare')) return ['Overview', 'Comparison', 'Recommendation'];
  if (article.keywords?.includes('install')) return ['Requirements', 'Steps', 'File locations'];
  if (article.keywords?.includes('docker'))  return ['Requirements', 'docker compose', 'Verify'];
  return base;
}

/* ────────────────────────────────────────────────────────────────────── */

/** Resolves a topic-page entry: an article-list-only view per topic. */
export function HelpTopicPage({
  topicId, onOpenArticle, onHome,
}: {
  topicId: string;
  onOpenArticle: (id: string) => void;
  onHome: () => void;
}) {
  const { isDark } = useTheme();
  const topic = getTopic(topicId);

  const heading = isDark ? 'text-slate-100' : 'text-slate-900';
  const body    = isDark ? 'text-slate-300' : 'text-slate-600';
  const muted   = isDark ? 'text-slate-500' : 'text-slate-500';
  const divider = isDark ? 'border-slate-800' : 'border-slate-100';
  const card    = isDark ? 'bg-slate-900 border-slate-800 hover:border-accent-500/40' : 'bg-white border-slate-200 hover:border-accent-400';

  if (!topic) {
    return (
      <div className="max-w-[720px] mx-auto px-6 py-16 text-center">
        <p className={`text-sm ${muted}`}>Topic not found</p>
      </div>
    );
  }

  const t = toneClasses(topic.tone, isDark);

  return (
    <div className="max-w-[860px] mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <nav className={`flex items-center gap-1.5 text-xs mb-6 ${muted}`}>
        <button onClick={onHome} className="hover:text-accent-500 transition-colors">Help</button>
        <ChevronRight className="w-3 h-3 opacity-50" />
        <span className={heading}>{topic.label}</span>
      </nav>

      <header className={`pb-8 mb-8 border-b ${divider} flex items-start gap-5`}>
        <span className={`inline-flex items-center justify-center w-14 h-14 rounded-2xl ${t.chipBg} ${t.chipText} shrink-0`}>
          <topic.icon className="w-7 h-7" />
        </span>
        <div className="min-w-0">
          <h1 className={`font-display text-3xl sm:text-4xl font-bold tracking-tight mb-2 ${heading}`}>
            {topic.label}
          </h1>
          <p className={`text-base leading-relaxed max-w-xl ${body}`} style={{ textWrap: 'pretty' as const }}>
            {topic.tagline}
          </p>
          <p className={`text-xs mt-3 ${muted}`}>{topic.articles.length} articles</p>
        </div>
      </header>

      <ul className="flex flex-col gap-3">
        {topic.articles.map(a => (
          <li key={a.id}>
            <button
              onClick={() => onOpenArticle(a.id)}
              className={`w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-colors ${card}`}
            >
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold mb-1 ${heading}`}>{a.title}</p>
                <p className={`text-xs leading-relaxed ${body}`} style={{ textWrap: 'pretty' as const }}>{a.summary}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`inline-flex items-center gap-1 text-[11px] ${muted}`}>
                  <Clock className="w-3 h-3" />
                  {a.readingMinutes} min
                </span>
                <ChevronRight className={`w-4 h-4 ${muted}`} />
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
