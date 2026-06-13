/**
 * Help — drop-in replacement for the previous HelpPage.
 *
 * Hub-and-spoke architecture:
 *   • view = 'hub'      → HelpHub (search + start-here + topic grid + AI + FAQ)
 *   • view = 'topic'    → HelpTopicPage (article list for one topic)
 *   • view = 'article'  → HelpReader (article body + sibling sidebar + pager)
 *
 * Routing is hash-based and self-contained:
 *   #/                 → hub
 *   #/topic/<id>       → topic page
 *   #/article/<id>     → article reader
 *
 * The hash is read on mount and on hashchange so deep links and
 * browser back/forward "just work" without a router dependency.
 */

import { useEffect, useState, useCallback } from 'react';
import { useTheme } from '../hooks/useTheme';
import { HelpHub } from '../components/help/HelpHub';
import { HelpReader, HelpTopicPage } from '../components/help/HelpReader';

type View =
  | { kind: 'hub' }
  | { kind: 'topic'; id: string }
  | { kind: 'article'; id: string };

function parseHash(): View {
  if (typeof window === 'undefined') return { kind: 'hub' };
  const h = window.location.hash || '';
  const m = h.match(/^#\/(article|topic)\/(.+)$/);
  if (!m) return { kind: 'hub' };
  return { kind: m[1] as 'article' | 'topic', id: decodeURIComponent(m[2]) };
}

function pushHash(v: View) {
  if (typeof window === 'undefined') return;
  const h =
    v.kind === 'hub'      ? '#/'
    : v.kind === 'topic'  ? `#/topic/${encodeURIComponent(v.id)}`
                          : `#/article/${encodeURIComponent(v.id)}`;
  if (window.location.hash !== h) {
    window.history.pushState(null, '', h);
  }
}

export function HelpPage() {
  const { isDark, isNight, isSpace } = useTheme();
  const [view, setView] = useState<View>(parseHash);

  // Sync view ↔ URL hash, both directions
  useEffect(() => { pushHash(view); }, [view]);
  useEffect(() => {
    const onHash = () => setView(parseHash());
    window.addEventListener('popstate', onHash);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('popstate', onHash);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  const goHome    = useCallback(() => setView({ kind: 'hub' }), []);
  const goTopic   = useCallback((id: string) => setView({ kind: 'topic', id }), []);
  const goArticle = useCallback((id: string) => setView({ kind: 'article', id }), []);

  // Background — picks up theme tones so the help feels native to the app
  const bg =
    isNight ? 'bg-[#050000]' :
    isSpace ? 'bg-[#060412]' :
    isDark  ? 'bg-slate-950' :
              'bg-slate-50';

  return (
    <div
      className={`-mt-8 -mb-8 -mx-4 sm:-mx-6 lg:-mx-8 min-h-[calc(100vh-4rem)] ${bg}`}
      data-screen-label="Help"
    >
      {view.kind === 'hub' && (
        <HelpHub onOpenArticle={goArticle} onOpenTopic={goTopic} />
      )}
      {view.kind === 'topic' && (
        <HelpTopicPage topicId={view.id} onOpenArticle={goArticle} onHome={goHome} />
      )}
      {view.kind === 'article' && (
        <HelpReader
          articleId={view.id}
          onOpenArticle={goArticle}
          onOpenTopic={goTopic}
          onHome={goHome}
        />
      )}
    </div>
  );
}
