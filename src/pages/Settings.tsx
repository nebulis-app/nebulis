import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCw, CheckCircle2 } from 'lucide-react';
import { getSettings, updateSettings } from '../lib/api/settings';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../contexts/AuthContext';
import type { Settings as SettingsType } from '../types';
import { SettingsNav, SETTINGS_NAV } from '../components/settings/SettingsNav';
import { SettingsHero } from '../components/settings/SettingsHero';
import { GeneralSection } from '../components/settings/GeneralSection';
import { LibrarySection } from '../components/settings/LibrarySection';
import { SoftwareUpdateCard } from '../components/settings/SoftwareUpdateCard';
import { UsersSection } from '../components/settings/UsersSection';
import { ConnectedDevicesSection } from '../components/settings/ConnectedDevicesSection';
import { ConnectionSection } from '../components/settings/ConnectionSection';
import { SkySection } from '../components/settings/SkySection';
import { StorageLocationSection } from '../components/settings/StorageLocationSection';
import { ReorganizeLibrarySection } from '../components/settings/ReorganizeLibrarySection';
import { StorageCleanupSection } from '../components/settings/StorageCleanupSection';
import { DatabaseBackupsSection } from '../components/settings/DatabaseBackupsSection';
import { SystemLogSection } from '../components/settings/SystemLogSection';
import { DangerSection } from '../components/settings/DangerSection';
import { AboutSection } from '../components/settings/AboutSection';

export function SettingsPage() {
  const { isDark } = useTheme();
  const { isAdmin, isViewer } = useAuth();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  });

  const [form, setForm] = useState<Partial<SettingsType>>({});
  const [formInitialized, setFormInitialized] = useState(false);
  // The server value the draft was last seeded from. `['settings']` has no
  // staleTime, so it background-refetches on window focus; tracking this lets
  // us adopt fresh server data when the draft is untouched instead of letting
  // `isDirty` flip true (and Save post a stale snapshot) for edits another
  // admin / the iOS client made.
  const [syncedSettings, setSyncedSettings] = useState<Partial<SettingsType> | null>(null);
  const [searchParams] = useSearchParams();
  // Lets other parts of the app deep-link straight to a tab, e.g. the v1.5
  // "What's New" popup linking to Settings -> Storage via /settings?tab=storage.
  // Read once on mount (the route remounts on navigation into /settings from
  // elsewhere); invalid ids are harmless since resolvedActive falls back to
  // the first tab. `section` is the same idea one level down, for the two
  // groups (Account, Storage) dense enough to carry sub-navigation.
  const [activeGroup, setActiveGroup] = useState(() => searchParams.get('tab') || SETTINGS_NAV[0].id);
  const [activeSection, setActiveSection] = useState(() => searchParams.get('section') || '');
  const [justSaved, setJustSaved] = useState(false);

  const visibleGroups = SETTINGS_NAV.filter(g => !g.adminOnly || isAdmin);
  const resolvedGroup = visibleGroups.find(g => g.id === activeGroup) ? activeGroup : (visibleGroups[0]?.id ?? 'general');
  const activeMeta = visibleGroups.find(g => g.id === resolvedGroup) ?? visibleGroups[0];
  const resolvedSection = activeMeta.items?.find(i => i.id === activeSection)?.id ?? activeMeta.items?.[0]?.id ?? null;

  // Seed / re-sync the draft from the query. On first load, and on any later
  // refetch where the draft still matches what we last synced (i.e. no unsaved
  // edits), adopt the fresh server value. If the draft was edited, leave it —
  // the user's in-progress changes win and `isDirty` correctly shows the
  // divergence from the new server state.
  if (settings && settings !== syncedSettings) {
    const draftUntouched =
      syncedSettings === null || JSON.stringify(form) === JSON.stringify(syncedSettings);
    setSyncedSettings(settings);
    setFormInitialized(true);
    if (draftUntouched) setForm(settings);
  }

  // Diffs the draft against the live query, not a hand-kept copy of it — a
  // second `useState` mirroring `settings` was one more place for the two to
  // drift (e.g. if the server ever normalizes a submitted value), and it
  // couldn't drift once removed.
  const isDirty = useMemo(
    () => isAdmin && formInitialized && JSON.stringify(form) !== JSON.stringify(settings ?? {}),
    [isAdmin, formInitialized, form, settings],
  );

  const saveMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: (data) => {
      queryClient.setQueryData(['settings'], data);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      // Settings changes affect object naming/enrichment; the library grid keys
      // on ['library-objects'], not ['objects'] (which nothing declares).
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1500);
    },
  });

  function handleSave() {
    if (isViewer) return;
    saveMutation.mutate(form);
  }
  function handleDiscard() {
    if (settings) setForm({ ...settings });
  }
  function navigateGroup(id: string) {
    const group = SETTINGS_NAV.find(g => g.id === id);
    if (group?.adminOnly && isViewer) return;
    setActiveGroup(id);
    setActiveSection('');
  }
  function navigateSection(id: string) {
    // The sidebar now shows every group's sub-items at once (not just the
    // active group's), so a click can target a section belonging to a group
    // that isn't active yet. Switch groups too in that case, same guard as
    // navigateGroup.
    const owningGroup = SETTINGS_NAV.find(g => g.items?.some(i => i.id === id));
    if (owningGroup && owningGroup.id !== activeGroup) {
      if (owningGroup.adminOnly && isViewer) return;
      setActiveGroup(owningGroup.id);
    }
    setActiveSection(id);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <RotateCw className="w-5 h-5 animate-spin text-accent-500" />
      </div>
    );
  }

  const showSaveBar = isDirty || justSaved;
  const accent = isDark ? '#fbbf24' : '#b45309';

  function renderActive() {
    switch (resolvedGroup) {
      case 'general':
        return <GeneralSection isDark={isDark} form={form} setForm={setForm} />;
      case 'library':
        return <LibrarySection isDark={isDark} form={form} setForm={setForm} />;
      case 'updates':
        return <SoftwareUpdateCard isDark={isDark} form={form} setForm={setForm} />;
      case 'account':
        return resolvedSection === 'devices'
          ? <ConnectedDevicesSection isDark={isDark} />
          : <UsersSection isDark={isDark} />;
      case 'hardware':
        return <ConnectionSection isDark={isDark} />;
      case 'sky':
        return <SkySection isDark={isDark} form={form} setForm={setForm} />;
      case 'storage':
        if (resolvedSection === 'organize') return <ReorganizeLibrarySection isDark={isDark} />;
        if (resolvedSection === 'cleanup') return <StorageCleanupSection isDark={isDark} />;
        if (resolvedSection === 'backups') return <DatabaseBackupsSection isDark={isDark} />;
        return <StorageLocationSection isDark={isDark} />;
      case 'log':
        return <SystemLogSection isDark={isDark} />;
      case 'danger':
        return <DangerSection isDark={isDark} />;
      case 'about':
        return <AboutSection isDark={isDark} />;
      default:
        return <GeneralSection isDark={isDark} form={form} setForm={setForm} />;
    }
  }

  return (
    <div className={`-mt-8 ${showSaveBar ? 'pb-24' : ''}`} data-screen-label="Settings">
      <div className="max-w-[1800px] mx-auto px-1 pt-8">
        <SettingsHero accent={accent} subtitle={subtitleFor(resolvedGroup, resolvedSection)} isAdmin={isAdmin} />
      </div>

      {isViewer && (
        <div className="max-w-[1800px] mx-auto px-1 pt-4">
          <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium ${
            isDark ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-amber-50 text-amber-700 border border-amber-200'
          }`}>
            View-only mode. Contact an admin to make changes.
          </div>
        </div>
      )}

      {/* The outer frame matches every other page (max-w-[1800px], same as
          Layout's <main>) so switching to Settings doesn't shift the page
          edges. A form can't sensibly fill that width, though, so the
          sidebar + content group is capped at 1240px and centred under the
          full-width hero rather than left-aligned against a wide empty gutter. */}
      <div className="max-w-[1800px] mx-auto px-1 pt-8 pb-16">
        <div className="mx-auto max-w-[1240px] lg:flex lg:items-start lg:gap-10">
          <SettingsNav
            activeGroupId={resolvedGroup}
            activeItemId={resolvedSection}
            onNavigateGroup={navigateGroup}
            onNavigateItem={navigateSection}
            isDark={isDark}
            isAdmin={isAdmin}
          />
          <div className="min-w-0 flex-1 pt-6 lg:pt-0">
            {renderActive()}
          </div>
        </div>
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

function subtitleFor(groupId: string, sectionId: string | null): string {
  switch (groupId) {
    case 'general':  return 'Appearance and units.';
    case 'library':  return 'How object cards, naming, and the slideshow behave.';
    case 'updates':  return 'Version, release notes, and update settings.';
    case 'account':
      return sectionId === 'devices'
        ? 'Phones and Apple TVs linked to your account.'
        : 'The people who can sign in to this library.';
    case 'hardware': return 'Telescopes and camera connections.';
    case 'sky':      return 'Observing site, catalogs, and external data sources.';
    case 'storage':
      if (sectionId === 'organize') return 'How this library stores each object\'s files on disk.';
      if (sectionId === 'cleanup') return 'Temporary import files.';
      return 'Where library data lives and how it stays in sync.';
    case 'log':      return 'Sign-ins, user and telescope changes, syncs, and other admin activity.';
    case 'danger':   return 'Diagnostics, cleanup tools, and destructive actions.';
    case 'about':    return 'Why Nebulis exists, and who built it.';
    default:         return '';
  }
}
