import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCw, CheckCircle2 } from 'lucide-react';
import { getSettings, updateSettings } from '../lib/api/settings';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../contexts/AuthContext';
import type { Settings as SettingsType } from '../types';
import { SettingsTabs, SETTINGS_TABS } from '../components/settings/SettingsTabs';
import { GeneralSection } from '../components/settings/GeneralSection';
import { AccountSection } from '../components/settings/AccountSection';
import { HardwareSection } from '../components/settings/HardwareSection';
import { SkySection } from '../components/settings/SkySection';
import { StorageGroupSection } from '../components/settings/StorageGroupSection';
import { DangerSection } from '../components/settings/DangerSection';

export function SettingsPage() {
  const { isDark } = useTheme();
  const { isAdmin, isViewer } = useAuth();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  });

  const [form, setForm] = useState<Partial<SettingsType>>({});
  const [savedForm, setSavedForm] = useState<Partial<SettingsType>>({});
  const [formInitialized, setFormInitialized] = useState(false);
  const [activeTab, setActiveTab] = useState(SETTINGS_TABS[0].id);
  const [justSaved, setJustSaved] = useState(false);

  const visibleTabs = SETTINGS_TABS.filter(t => !t.adminOnly || isAdmin);
  const resolvedActive = visibleTabs.find(t => t.id === activeTab) ? activeTab : (visibleTabs[0]?.id ?? 'general');
  const activeMeta = visibleTabs.find(t => t.id === resolvedActive) ?? visibleTabs[0];

  // First-load form sync
  if (settings && !formInitialized) {
    setFormInitialized(true);
    setForm(settings);
    setSavedForm(settings);
  }

  const isDirty = useMemo(
    () => isAdmin && formInitialized && JSON.stringify(form) !== JSON.stringify(savedForm),
    [isAdmin, formInitialized, form, savedForm],
  );

  const saveMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: (data, variables) => {
      setSavedForm({ ...variables });
      queryClient.setQueryData(['settings'], data);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['objects'] });
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1500);
    },
  });

  function handleSave() {
    if (isViewer) return;
    saveMutation.mutate(form);
  }
  function handleDiscard() {
    setForm({ ...savedForm });
  }
  function navigateTo(id: string) {
    const tab = SETTINGS_TABS.find(t => t.id === id);
    if (tab?.adminOnly && isViewer) return;
    setActiveTab(id);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'instant' });
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <RotateCw className="w-5 h-5 animate-spin text-accent-500" />
      </div>
    );
  }

  const showSaveBar = isDirty || justSaved;

  function renderActive() {
    switch (resolvedActive) {
      case 'general':
        return <GeneralSection isDark={isDark} form={form} setForm={setForm} />;
      case 'account':
        return <AccountSection isDark={isDark} />;
      case 'hardware':
        return <HardwareSection isDark={isDark} />;
      case 'sky':
        return <SkySection isDark={isDark} form={form} setForm={setForm} />;
      case 'storage':
        return (
          <StorageGroupSection
            isDark={isDark}
          />
        );
      case 'danger':
        return <DangerSection isDark={isDark} />;
      default:
        return <GeneralSection isDark={isDark} form={form} setForm={setForm} />;
    }
  }

  return (
    <div className={`-mt-8 ${showSaveBar ? 'pb-24' : ''}`} data-screen-label="Settings">
      {/* Centered horizontal tab nav, sticky under topnav */}
      <SettingsTabs activeId={resolvedActive} onNavigate={navigateTo} isDark={isDark} isAdmin={isAdmin} />

      {/* Hero — Library cadence: title + one-line subtitle, left-aligned */}
      <header className="max-w-[960px] mx-auto px-1 pt-10 pb-6">
        <h1 className={`font-display text-[32px] font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
          {activeMeta.label === 'General' ? 'Settings' : activeMeta.label}
        </h1>
        <p className={`mt-1.5 text-sm ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
          {subtitleFor(resolvedActive)}
        </p>
        {isViewer && (
          <div className={`mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium ${
            isDark ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-amber-50 text-amber-700 border border-amber-200'
          }`}>
            View-only mode. Contact an admin to make changes.
          </div>
        )}
      </header>

      {/* Section content. Capped at 960px so rows breathe and align with hero. */}
      <div className="max-w-[960px] mx-auto px-1 pb-16">
        {renderActive()}
      </div>

      {/* Save bar (kept identical in behaviour) */}
      <div
        className={`fixed bottom-0 inset-x-0 z-40 border-t backdrop-blur-xl transition-all duration-300 ease-out ${
          showSaveBar ? 'translate-y-0' : 'translate-y-full'
        } ${isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-white/90 border-slate-200 shadow-lg'}`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          {justSaved && !isDirty ? (
            <div className="flex items-center gap-2 text-emerald-500">
              <CheckCircle2 className="w-4 h-4" />
              <span className="text-sm font-medium">Changes saved</span>
            </div>
          ) : saveMutation.isError ? (
            <span className="text-sm text-red-500">
              Save failed: {saveMutation.error instanceof Error ? saveMutation.error.message : 'Unknown error'}
            </span>
          ) : (
            <div className="flex items-center gap-3">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-500" />
              </span>
              <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                Unsaved changes
              </span>
            </div>
          )}

          <div className="flex items-center gap-3">
            {isDirty && (
              <>
                <button
                  onClick={handleDiscard}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${
                    isDark
                      ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                      : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  Discard
                </button>
                <button
                  onClick={handleSave}
                  disabled={saveMutation.isPending}
                  className="inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold bg-accent-500 text-white hover:bg-accent-600 transition-all duration-150 disabled:opacity-50 shadow-sm shadow-accent-500/20"
                >
                  {saveMutation.isPending && <RotateCw className="w-3.5 h-3.5 animate-spin" />}
                  Save changes
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function subtitleFor(id: string): string {
  switch (id) {
    case 'general':  return 'Appearance, units, time, and other preferences.';
    case 'account':  return 'Profile, plan, and the people who can access this library.';
    case 'hardware': return 'Telescopes, cameras, and connection details.';
    case 'sky':      return 'Observing site, catalogs, and external data sources.';
    case 'storage':  return 'Where library data lives and how it stays in sync.';
    case 'danger':   return 'Destructive actions. Read carefully before continuing.';
    default:         return '';
  }
}
