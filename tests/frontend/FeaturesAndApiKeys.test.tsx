// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../src/i18n';
import { FeaturesSection } from '../../src/components/settings/FeaturesSection';
import { ApiKeySection } from '../../src/components/settings/ApiKeySection';
import { SETTINGS_NAV, visibleSettingsNav } from '../../src/components/settings/settingsNavItems';
import enSettings from '../../src/locales/en/settings.json';

// Render-level checks (react-dom/server, like the other component tests here): the Features page
// shows the repository URL only while the integration is on, and both pages mount without a provider
// error. Behaviour behind the API (create/revoke/role rules) is covered in tests/backend/apiKeys.test.ts.
beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const noop = () => {};

describe('FeaturesSection', () => {
  it('shows the PixInsight switch, and hides the repository URL while it is off', () => {
    const html = renderToStaticMarkup(<FeaturesSection isDark={false} form={{ pixinsightEnabled: false }} setForm={noop} onOpenApiKeys={noop} />);
    expect(html).toContain(enSettings.featuresSection.pixinsight.label);
    expect(html).not.toContain('/plugins/pixinsight/');
  });

  it('shows the repository URL and the next-step hint once it is on', () => {
    const html = renderToStaticMarkup(<FeaturesSection isDark form={{ pixinsightEnabled: true }} setForm={noop} onOpenApiKeys={noop} />);
    expect(html).toContain('/plugins/pixinsight/');
    expect(html).toContain(enSettings.featuresSection.pixinsight.setup);
  });
});

describe('ApiKeySection', () => {
  it('mounts and shows its heading', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ApiKeySection isDark={false} />
      </QueryClientProvider>,
    );
    expect(html).toContain(enSettings.apiKeys.title);
  });
});

describe('settings nav', () => {
  it('Features is admin-only; API keys lives under Account and is open to every signed-in user', () => {
    expect(SETTINGS_NAV.find(g => g.id === 'integrations')?.adminOnly).toBe(true);
    expect(SETTINGS_NAV.find(g => g.id === 'api-keys')).toBeUndefined();
    const account = SETTINGS_NAV.find(g => g.id === 'account');
    // Pin the group's real item list first, so the `?? false` checks below
    // can't pass vacuously on a missing group or item.
    expect(account?.items?.map(i => i.id)).toEqual(['users', 'devices', 'api-keys']);
    expect(account?.adminOnly ?? false).toBe(false);
    expect(account?.items?.find(i => i.id === 'api-keys')?.adminOnly ?? false).toBe(false);
  });

  it('non-admins see Account with only API keys; admins see Users, Devices and API keys', () => {
    const ids = (admin: boolean) =>
      visibleSettingsNav(admin).find(g => g.id === 'account')?.items?.map(i => i.id);
    expect(ids(false)).toEqual(['api-keys']);
    expect(ids(true)).toEqual(['users', 'devices', 'api-keys']);
  });
});
