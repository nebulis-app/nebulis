import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Search, Copy, CheckCircle2, FileCode, RotateCw } from 'lucide-react';
import { getLibraryFitsHeaders } from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';

interface FitsHeaderModalProps {
  filePath: string;
  fileName: string;
  onClose: () => void;
}

const categoryLabels: Record<string, string> = {
  essential: 'File Structure',
  observation: 'Observation',
  coordinates: 'Coordinates',
  sensor: 'Sensor',
  quality: 'Quality Metrics',
  other: 'Other',
  comments: 'Comments',
};

export function FitsHeaderModal({ filePath, fileName, onClose }: FitsHeaderModalProps) {
  const { isDark } = useTheme();
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['fits-header', filePath],
    queryFn: () => getLibraryFitsHeaders(filePath),
  });

  function copyAll() {
    if (!data) return;
    const text = data.cards.map(c => c.raw).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const filteredCategories = data?.categorized
    ? Object.entries(data.categorized).filter(([, cards]) => {
        if (!search) return cards.length > 0;
        return cards.some(c =>
          c.key.toLowerCase().includes(search.toLowerCase()) ||
          String(c.value).toLowerCase().includes(search.toLowerCase())
        );
      })
    : [];

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`FITS Header for ${fileName}`}
      className={`w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl ${
        isDark ? 'bg-slate-900' : 'bg-white'
      }`}
    >
        {/* Header */}
        <div className={`flex items-center justify-between p-4 border-b shrink-0 ${
          isDark ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <div className="flex items-center gap-3">
            <FileCode className="w-5 h-5 text-teal-500" />
            <div>
              <h3 className={`font-display font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                FITS Header
              </h3>
              <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{fileName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={copyAll}
              className={`p-2 rounded-lg text-sm transition ${
                copied ? 'text-emerald-500' : isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'
              }`}
              title="Copy all header cards"
            >
              {copied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
            <button
              onClick={onClose}
              className={`p-2 rounded-lg transition ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className={`px-4 py-3 border-b shrink-0 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className="relative">
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
            <input
              type="text"
              placeholder="Search header keys or values..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className={`w-full pl-9 pr-4 py-2 rounded-lg border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 ${
                isDark ? 'bg-slate-800 border-slate-700 text-slate-200 placeholder-slate-600' : 'bg-slate-50 border-slate-200 placeholder-slate-400'
              }`}
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <RotateCw className="w-6 h-6 animate-spin text-accent-500" />
            </div>
          ) : error ? (
            <div className={`text-center py-12 space-y-1 ${isDark ? 'text-danger-500' : 'text-red-600'}`}>
              <p>Failed to load FITS header.</p>
              <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Close and reopen to try again.</p>
            </div>
          ) : (
            <>
              {/* Categorized headers */}
              {filteredCategories.map(([category, cards]) => {
                const filtered = search
                  ? cards.filter(c =>
                      c.key.toLowerCase().includes(search.toLowerCase()) ||
                      String(c.value).toLowerCase().includes(search.toLowerCase())
                    )
                  : cards;
                if (filtered.length === 0) return null;

                return (
                  <div key={category}>
                    <h4 className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                      isDark ? 'text-slate-500' : 'text-slate-400'
                    }`}>
                      {categoryLabels[category] || category}
                    </h4>
                    <div className={`rounded-xl border overflow-hidden ${
                      isDark ? 'border-slate-800' : 'border-slate-200'
                    }`}>
                      <table className="w-full text-sm">
                        <tbody>
                          {filtered.map((card, i) => (
                            <tr key={i} className={isDark ? 'even:bg-slate-800/50' : 'even:bg-slate-50'}>
                              <td className={`px-3 py-1.5 font-mono text-xs w-28 ${
                                isDark ? 'text-teal-400' : 'text-teal-700'
                              }`}>
                                {card.key}
                              </td>
                              <td className={`px-3 py-1.5 font-mono text-xs ${
                                isDark ? 'text-slate-200' : 'text-slate-700'
                              }`}>
                                {String(card.value)}
                              </td>
                              <td className={`px-3 py-1.5 text-xs ${
                                isDark ? 'text-slate-600' : 'text-slate-400'
                              }`}>
                                {card.comment}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
    </Modal>
  );
}
