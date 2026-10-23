import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, mockAdminAuth, mockViewerAuth, json, ok } from './fixtures/mocks';

/**
 * Settings → Alerts: where Nebulis sends what it notices on its own (an ntfy topic,
 * a Discord or Slack webhook, a generic webhook), which events go where, and the
 * evening clear-night check. The server keeps the URL and secret write-only, so
 * the browser only ever sees a masked preview. Admin only.
 */

interface Channel {
  id: string; name: string; kind: string; urlPreview: string; hasSecret: boolean; events: string[];
  enabled: boolean; createdAt: string; lastSentAt: string | null; lastStatus: 'ok' | 'error' | null; lastError: string | null;
}

interface Phone {
  id: string; name: string; apnsEnv: string; language: string | null; events: string[]; details?: { dew: boolean; plan: boolean; dewLeadMinutes?: number };
  enabled: boolean; createdAt: string; lastSentAt: string | null; lastStatus: 'ok' | 'error' | null; lastError: string | null;
}

const phone: Phone = {
  id: 'ph-1', name: 'My iPhone', apnsEnv: 'production', language: null, events: ['night.clear', 'import.failed'], details: { dew: false, plan: false },
  enabled: true, createdAt: '2026-10-01T00:00:00Z', lastSentAt: null, lastStatus: null, lastError: null,
};

const ntfy: Channel = {
  id: 'ch-1', name: 'My phone', kind: 'ntfy', urlPreview: 'https://ntfy.sh/…pic', hasSecret: false,
  events: ['night.clear', 'import.finished'], enabled: true, createdAt: '2026-10-01T00:00:00Z',
  lastSentAt: '2026-10-17T02:30:00Z', lastStatus: 'ok', lastError: null,
};

/**
 * A small in-memory stand-in for server/routes/alerts.ts, so the page can add,
 * edit, pause, test and delete and then show what the "server" now holds. Every
 * request is recorded for the specs that check what was sent.
 */
async function mockAlerts(page: Page, initial: Channel[] = [ntfy], phones: Phone[] = []) {
  const state = {
    channels: initial.map(c => ({ ...c })),
    phones: phones.map(p => ({ ...p })),
    next: { at: '2026-10-21T23:00:00.000Z', when: 'today', timeZone: 'America/Chicago' } as { at: string; when: string; timeZone: string },
    config: { language: 'en', clearNight: { checkTime: '18:00', minClearHours: 3, maxCloudCover: 30 } },
    testResult: { ok: true, status: 200, error: null as string | null },
    dewSample: { sent: 1, failed: [] as { name: string; error: string }[], phones: 1, sample: true },
    phoneSample: { sent: 1, failed: [] as { name: string; error: string }[], phones: 1, check: { night: '2026-10-21', checkedAt: '', sent: false, reason: 'preview', result: { siteName: 'Backyard' } } as Record<string, unknown> },
    requests: [] as { method: string; path: string; body: unknown }[],
  };
  const overview = () => ({
    channels: state.channels, devices: state.phones, config: state.config, lastClearNightCheck: null,
    nextClearNightCheck: state.next,
  });
  const record = (r: { request(): { method(): string; url(): string; postDataJSON(): unknown } }) => {
    let body: unknown = null;
    try { body = r.request().postDataJSON(); } catch { /* no body */ }
    state.requests.push({ method: r.request().method(), path: new URL(r.request().url()).pathname, body });
    return body as Record<string, unknown> | null;
  };

  await page.route('**/api/alerts', r => r.fulfill(json(ok(overview()))));
  await page.route('**/api/alerts/channels', async r => {
    const body = record(r) as { name: string; kind: string; url: string; secret?: string | null; events: string[] };
    const created: Channel = {
      id: `ch-${state.channels.length + 1}`, name: body.name, kind: body.kind, urlPreview: `${body.url.slice(0, 20)}…`,
      hasSecret: !!body.secret, events: body.events, enabled: true, createdAt: new Date().toISOString(),
      lastSentAt: null, lastStatus: null, lastError: null,
    };
    state.channels.push(created);
    await r.fulfill(json(ok(created)));
  });
  await page.route('**/api/alerts/channels/*/test', async r => {
    record(r);
    const id = r.request().url().split('/').slice(-2)[0]!;
    const ch = state.channels.find(c => c.id === id)!;
    ch.lastSentAt = new Date().toISOString();
    ch.lastStatus = state.testResult.ok ? 'ok' : 'error';
    ch.lastError = state.testResult.error;
    await r.fulfill(json(ok({ ...state.testResult, channel: ch })));
  });
  await page.route('**/api/alerts/channels/*', async r => {
    const body = record(r);
    const id = decodeURIComponent(r.request().url().split('/').pop()!);
    const i = state.channels.findIndex(c => c.id === id);
    if (r.request().method() === 'DELETE') {
      state.channels.splice(i, 1);
      return r.fulfill(json(ok({ deleted: true })));
    }
    state.channels[i] = { ...state.channels[i]!, ...(body as Partial<Channel>) };
    return r.fulfill(json(ok(state.channels[i])));
  });
  await page.route('**/api/alerts/devices/*', async r => {
    const body = record(r);
    const id = decodeURIComponent(r.request().url().split('/').pop()!);
    const i = state.phones.findIndex(p => p.id === id);
    state.phones[i] = { ...state.phones[i]!, ...(body as Partial<Phone>) };
    return r.fulfill(json(ok(state.phones[i])));
  });
  await page.route('**/api/alerts/config', async r => {
    const body = record(r) as { language?: string; clearNight?: Record<string, unknown> };
    state.config = {
      language: body.language ?? state.config.language,
      clearNight: { ...state.config.clearNight, ...(body.clearNight ?? {}) },
    } as typeof state.config;
    await r.fulfill(json(ok(state.config)));
  });
  await page.route('**/api/alerts/clear-night/send-to-phones', async r => {
    record(r);
    await r.fulfill(json(ok(state.phoneSample)));
  });
  await page.route('**/api/alerts/dew/send-to-phones', async r => {
    record(r);
    await r.fulfill(json(ok(state.dewSample)));
  });
  await page.route('**/api/alerts/clear-night/preview', async r => {
    record(r);
    await r.fulfill(json(ok({
      night: '2026-10-18', checkedAt: '2026-10-18T22:00:00Z', sent: false, reason: 'preview',
      result: {
        siteName: 'Backyard', night: '2026-10-18', timeZone: 'America/Chicago', clearHours: 5, darkHours: 8,
        longestStart: '2026-10-19T03:00:00Z', longestEnd: '2026-10-19T08:00:00Z', maxCloudCover: 30, seeing: 3,
        moonIllumination: 12, moonDownHours: 6,
      },
    })));
  });
  return state;
}

async function openAlerts(page: Page) {
  await page.goto('/settings?tab=alerts');
  await expect(page.getByText('Alert channels')).toBeVisible();
}

test.describe('Settings → Alerts: the channel list', () => {
  test('shows each channel with its kind, masked URL, events and last result', async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await mockAlerts(page);
    await openAlerts(page);

    const row = page.getByRole('listitem').filter({ hasText: 'My phone' });
    await expect(row).toContainText('ntfy');
    await expect(row).toContainText('https://ntfy.sh/…pic');
    await expect(row.getByText('Clear night', { exact: true })).toBeVisible();
    await expect(row.getByText('Import done', { exact: true })).toBeVisible();
    await expect(row.getByText('Import failed', { exact: true })).toHaveCount(0);
    await expect(row).toContainText('Last sent');
  });

  test('says so when there is no channel yet', async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await mockAlerts(page, []);
    await openAlerts(page);
    await expect(page.getByText('No alert channel yet.')).toBeVisible();
  });

  test('a failed last send shows the error, not a success tick', async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
    await mockAlerts(page, [{ ...ntfy, lastStatus: 'error', lastError: 'HTTP 403' }]);
    await openAlerts(page);
    await expect(page.getByText(/Last attempt .* failed: HTTP 403/)).toBeVisible();
  });
});

test.describe('Settings → Alerts: iPhones', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
  });

  test('an iPhone has the same choices as a channel, behind its edit button', async ({ page }) => {
    const server = await mockAlerts(page, [], [phone]);
    await openAlerts(page);
    await page.getByRole('button', { name: 'Choose alerts for My iPhone' }).click();
    const dialog = page.getByRole('dialog', { name: 'Alerts for My iPhone' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: /Clear night ahead/ })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: /Import failed/ })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: /Import finished/ })).not.toBeChecked();

    await dialog.getByRole('checkbox', { name: /Tonight's plan/ }).check();
    await dialog.getByRole('checkbox', { name: /Import finished/ }).check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog', { name: 'Alerts for My iPhone' })).toHaveCount(0);
    const put = server.requests.find(r => r.method === 'PUT' && r.path === '/api/alerts/devices/ph-1');
    expect(put?.body).toMatchObject({ name: 'My iPhone', details: { dew: false, plan: true } });
    expect((put?.body as { events: string[] }).events).toEqual(expect.arrayContaining(['night.clear', 'import.failed', 'import.finished']));
  });

  test('the dew warning asks how far ahead it should go, and saves the choice for that iPhone', async ({ page }) => {
    const server = await mockAlerts(page, [], [phone]);
    await openAlerts(page);
    await page.getByRole('button', { name: 'Choose alerts for My iPhone' }).click();
    const dialog = page.getByRole('dialog', { name: 'Alerts for My iPhone' });
    await expect(dialog.getByRole('combobox', { name: 'Send it' })).toHaveCount(0);
    await dialog.getByRole('checkbox', { name: /Dew warning/ }).check();
    const lead = dialog.getByRole('combobox', { name: 'Send it' });
    await expect(lead).toHaveValue('60');
    await lead.selectOption('120');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const put = server.requests.find(r => r.method === 'PUT' && r.path === '/api/alerts/devices/ph-1');
    expect((put?.body as { events: string[] }).events).toContain('night.dew');
    expect(put?.body).toMatchObject({ details: { dewLeadMinutes: 120 } });
  });

  test('a stored lead time that is not in the list still shows, and the row says it', async ({ page }) => {
    await mockAlerts(page, [], [{ ...phone, events: ['night.dew'], details: { dew: false, plan: false, dewLeadMinutes: 90 } }]);
    await openAlerts(page);
    await expect(page.getByText('Dew warning: 90 minutes before the dew')).toBeVisible();
    await page.getByRole('button', { name: 'Choose alerts for My iPhone' }).click();
    await expect(page.getByRole('combobox', { name: 'Send it' })).toHaveValue('90');
  });

  test('sends the dew warning to the iPhones only when one is subscribed, and says when it used example times', async ({ page }) => {
    const none = await mockAlerts(page, [], [phone]);
    await openAlerts(page);
    await expect(page.getByRole('button', { name: 'Send dew warning to iPhones' })).toHaveCount(0);
    expect(none.requests.some(r => r.path.endsWith('/dew/send-to-phones'))).toBe(false);

    const server = await mockAlerts(page, [], [{ ...phone, events: ['night.dew'] }]);
    await openAlerts(page);
    await page.getByRole('button', { name: 'Send dew warning to iPhones' }).click();
    await expect(page.getByText('Dew warning sent to 1 iPhone.')).toBeVisible();
    await expect(page.getByText(/used example times/)).toBeVisible();
    expect(server.requests.filter(r => r.method === 'POST' && r.path === '/api/alerts/dew/send-to-phones')).toHaveLength(1);
  });

  test('phones and channels are one list under one heading', async ({ page }) => {
    await mockAlerts(page, [ntfy], [phone]);
    await openAlerts(page);
    await expect(page.getByRole('heading', { name: 'Alert channels' })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'iPhones' })).toHaveCount(0);
    const list = page.getByRole('list').filter({ hasText: 'My iPhone' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    // A phone named for what it is does not say it twice; one with another name does.
    await expect(list.getByRole('listitem').filter({ hasText: 'My iPhone' })).not.toContainText('iPhone iPhone');
    await expect(list.getByRole('listitem').filter({ hasText: 'My phone' })).toContainText('ntfy');
    // The same controls on both, so neither kind has to be learned separately.
    for (const row of [list.getByRole('listitem').filter({ hasText: 'My iPhone' }), list.getByRole('listitem').filter({ hasText: 'My phone' })]) {
      await expect(row.getByRole('switch')).toBeVisible();
      await expect(row.getByRole('button', { name: /Test/ })).toBeVisible();
    }
  });

  test('with nothing yet, one empty state explains both ways in', async ({ page }) => {
    await mockAlerts(page, [], []);
    await openAlerts(page);
    await expect(page.getByText('No alert channel yet.')).toBeVisible();
    await expect(page.getByText(/An iPhone appears here by itself/)).toBeVisible();
  });

  test('says which extras a phone carries, and shows none for a phone that has none', async ({ page }) => {
    await mockAlerts(page, [], [{ ...phone, details: { dew: true, plan: true } }]);
    await openAlerts(page);
    await expect(page.getByText("Clear night adds: Tonight's plan, Dew risk")).toBeVisible();
  });

  test('a phone from a server that does not send the extras yet still opens', async ({ page }) => {
    const older: Phone = { ...phone };
    delete older.details;
    await mockAlerts(page, [], [older]);
    await openAlerts(page);
    await expect(page.getByText(/Clear night adds/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Choose alerts for My iPhone' }).click();
    await expect(page.getByRole('checkbox', { name: /Dew risk/ })).not.toBeChecked();
  });
});

test.describe('Settings → Alerts: add, test, pause, delete', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
  });

  test('Save stays off until the channel has a name and a URL', async ({ page }) => {
    await mockAlerts(page, []);
    await openAlerts(page);
    await page.getByRole('button', { name: 'Add channel' }).click();
    const save = page.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();
    await page.getByLabel('Name').fill('My phone');
    await expect(save).toBeDisabled();
    await page.getByLabel('URL').fill('https://ntfy.sh/my-nebulis-topic');
    await expect(save).toBeEnabled();
  });

  test('adds an ntfy channel with the default events and lists it', async ({ page }) => {
    const server = await mockAlerts(page, []);
    await openAlerts(page);
    await page.getByRole('button', { name: 'Add channel' }).click();
    await expect(page.getByRole('dialog', { name: 'Add an alert channel' })).toBeVisible();
    // ntfy is the default kind; clear night, import finished and import failed are on, update is off.
    await expect(page.getByRole('checkbox', { name: /Clear night ahead/ })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /Import finished/ })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /Import failed/ })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /Update available/ })).not.toBeChecked();

    await page.getByLabel('Name').fill('My phone');
    await page.getByLabel('URL').fill('https://ntfy.sh/my-nebulis-topic');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('dialog', { name: 'Add an alert channel' })).toHaveCount(0);
    await expect(page.getByRole('listitem').filter({ hasText: 'My phone' })).toBeVisible();
    const post = server.requests.find(r => r.method === 'POST' && r.path === '/api/alerts/channels');
    expect(post?.body).toMatchObject({
      name: 'My phone', kind: 'ntfy', url: 'https://ntfy.sh/my-nebulis-topic',
      events: ['night.clear', 'import.finished', 'import.failed'],
    });
  });

  test('offers the clear-night extras under that event, off to begin with, and sends the ones ticked', async ({ page }) => {
    const server = await mockAlerts(page, []);
    await openAlerts(page);
    await page.getByRole('button', { name: 'Add channel' }).click();
    const plan = page.getByRole('checkbox', { name: /Tonight's plan/ });
    const dew = page.getByRole('checkbox', { name: /Dew risk/ });
    await expect(plan).not.toBeChecked();
    await expect(dew).not.toBeChecked();

    // They belong to "Clear night ahead": gone when it is off, and back with their choices when it is on again.
    await dew.check();
    await page.getByRole('checkbox', { name: /Clear night ahead/ }).uncheck();
    await expect(plan).toHaveCount(0);
    await page.getByRole('checkbox', { name: /Clear night ahead/ }).check();
    await expect(page.getByRole('checkbox', { name: /Dew risk/ })).toBeChecked();

    await page.getByRole('checkbox', { name: /Tonight's plan/ }).check();
    await page.getByLabel('Name').fill('My phone');
    await page.getByLabel('URL').fill('https://ntfy.sh/my-nebulis-topic');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog', { name: 'Add an alert channel' })).toHaveCount(0);
    const post = server.requests.find(r => r.method === 'POST' && r.path === '/api/alerts/channels');
    expect(post?.body).toMatchObject({ details: { dew: true, plan: true } });
  });

  test('only a webhook asks for a signing secret, and sends it', async ({ page }) => {
    const server = await mockAlerts(page, []);
    await openAlerts(page);
    await page.getByRole('button', { name: 'Add channel' }).click();
    await expect(page.getByLabel('Signing secret (optional)')).toHaveCount(0);

    await page.getByRole('button', { name: 'Webhook', exact: true }).click();
    await page.getByLabel('Name').fill('Home Assistant');
    await page.getByLabel('URL').fill('https://homeassistant.local:8123/api/webhook/nebulis');
    await page.getByLabel('Signing secret (optional)').fill('s3cret');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('listitem').filter({ hasText: 'Home Assistant' })).toBeVisible();
    const post = server.requests.find(r => r.method === 'POST' && r.path === '/api/alerts/channels');
    expect(post?.body).toMatchObject({ kind: 'webhook', secret: 's3cret' });
  });

  test('editing keeps the stored URL unless a new one is typed', async ({ page }) => {
    const server = await mockAlerts(page);
    await openAlerts(page);
    await page.getByRole('listitem').filter({ hasText: 'My phone' }).getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('Leave empty to keep the current URL.')).toBeVisible();
    await page.getByLabel('Name').fill('Renamed phone');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('listitem').filter({ hasText: 'Renamed phone' })).toBeVisible();
    const put = server.requests.find(r => r.method === 'PUT' && r.path === '/api/alerts/channels/ch-1');
    expect(put?.body).toMatchObject({ name: 'Renamed phone' });
    expect(put?.body).not.toHaveProperty('url');
  });

  test('Test reports success', async ({ page }) => {
    await mockAlerts(page);
    await openAlerts(page);
    await page.getByRole('button', { name: 'Test' }).click();
    await expect(page.getByText('Test alert sent.')).toBeVisible();
  });

  test('Test reports why it failed', async ({ page }) => {
    const server = await mockAlerts(page);
    server.testResult = { ok: false, status: 404, error: 'HTTP 404' };
    await openAlerts(page);
    await page.getByRole('button', { name: 'Test' }).click();
    await expect(page.getByText('Test failed: HTTP 404')).toBeVisible();
  });

  test('the switch pauses a channel', async ({ page }) => {
    const server = await mockAlerts(page);
    await openAlerts(page);
    await page.getByRole('switch', { name: 'Send alerts to My phone' }).click();
    await expect.poll(() => server.requests.find(r => r.method === 'PUT' && r.path === '/api/alerts/channels/ch-1')?.body)
      .toEqual({ enabled: false });
  });

  test('delete asks first, and Cancel keeps the channel', async ({ page }) => {
    const server = await mockAlerts(page);
    await openAlerts(page);
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(/Delete “My phone”\?/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'My phone' })).toBeVisible();
    expect(server.requests.some(r => r.method === 'DELETE')).toBe(false);
  });

  test('confirming delete removes the channel', async ({ page }) => {
    await mockAlerts(page);
    await openAlerts(page);
    await page.getByRole('listitem').filter({ hasText: 'My phone' }).getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await expect(page.getByText('No alert channel yet.')).toBeVisible();
  });
});

test.describe('Settings → Alerts: the clear-night check', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminAuth(page);
    await mockAllRoutes(page);
  });

  test('shows the saved settings', async ({ page }) => {
    await mockAlerts(page);
    await openAlerts(page);
    await expect(page.getByLabel('Check at')).toHaveValue('18:00');
    await expect(page.getByLabel('Send when at least')).toHaveValue('3');
    await expect(page.getByLabel('An hour is clear up to')).toHaveValue('30');
  });

  test('the check time only offers the evening', async ({ page }) => {
    // A time after midnight would check the wrong night, so the input starts at noon.
    await mockAlerts(page);
    await openAlerts(page);
    await expect(page.getByLabel('Check at')).toHaveAttribute('min', '12:00');
  });

  test('changing a setting saves just that setting', async ({ page }) => {
    const server = await mockAlerts(page);
    await openAlerts(page);
    await page.getByLabel('Send when at least').selectOption('5');
    await expect.poll(() => server.requests.find(r => r.method === 'PUT' && r.path === '/api/alerts/config')?.body)
      .toEqual({ clearNight: { minClearHours: 5 } });
  });

  test('"Check tonight now" shows tonight\'s clear hours without sending anything', async ({ page }) => {
    await mockAlerts(page);
    await openAlerts(page);
    await page.getByRole('button', { name: 'Check tonight now' }).click();
    await expect(page.getByText(/5 h clear out of 8 h of darkness/)).toBeVisible();
    await expect(page.getByText(/Moon 12%/)).toBeVisible();
  });

  test('sends tonight to the iPhones, and only offers to when one is switched on', async ({ page }) => {
    const none = await mockAlerts(page, [ntfy], []);
    await openAlerts(page);
    await expect(page.getByRole('button', { name: 'Send to iPhones' })).toHaveCount(0);
    expect(none.requests.some(r => r.path.endsWith('/send-to-phones'))).toBe(false);
  });

  test('sending tonight to the iPhones says how many got it, and nothing goes without a click', async ({ page }) => {
    const server = await mockAlerts(page, [], [phone]);
    await openAlerts(page);
    expect(server.requests.some(r => r.path.endsWith('/send-to-phones'))).toBe(false);
    await page.getByRole('button', { name: 'Send to iPhones' }).click();
    await expect(page.getByText('Sent to 1 iPhone.')).toBeVisible();
    expect(server.requests.filter(r => r.method === 'POST' && r.path === '/api/alerts/clear-night/send-to-phones')).toHaveLength(1);
    // With no extra line turned on for any phone, it says that, and where to turn them on.
    await expect(page.getByText(/None of your iPhones has an extra line turned on/)).toBeVisible();
  });

  test('does not nag about extras when a phone has one turned on', async ({ page }) => {
    await mockAlerts(page, [], [{ ...phone, details: { dew: true, plan: false } }]);
    await openAlerts(page);
    await page.getByRole('button', { name: 'Send to iPhones' }).click();
    await expect(page.getByText('Sent to 1 iPhone.')).toBeVisible();
    await expect(page.getByText(/None of your iPhones has an extra line turned on/)).toHaveCount(0);
  });

  test('names a phone that refused, with the reason, and says why when there is nothing to send', async ({ page }) => {
    const server = await mockAlerts(page, [], [phone]);
    server.phoneSample = { sent: 0, failed: [{ name: 'My iPhone', error: 'The phone needs to register again: open Nebulis on it.' }], phones: 1, check: server.phoneSample.check };
    await openAlerts(page);
    await page.getByRole('button', { name: 'Send to iPhones' }).click();
    await expect(page.getByText('Could not send to My iPhone: The phone needs to register again: open Nebulis on it.')).toBeVisible();
    await expect(page.getByText(/^Sent to \d+ iPhones?\.$/)).toHaveCount(0);

    server.phoneSample = { sent: 0, failed: [], phones: 1, check: { night: '2026-10-21', checkedAt: '', sent: false, reason: 'no_site', result: null } };
    await page.getByRole('button', { name: 'Send to iPhones' }).click();
    await expect(page.getByText(/location|site/i).first()).toBeVisible();
  });

  test('says when the evening check runs next, and what it needs to send', async ({ page }) => {
    const server = await mockAlerts(page);
    await openAlerts(page);
    await expect(page.getByText(/Next check: tonight at 0?6:00 PM\. It sends only if at least 3 clear hours are ahead\./)).toBeVisible();

    server.next = { at: '2026-10-22T23:00:00.000Z', when: 'tomorrow', timeZone: 'America/Chicago' };
    await page.reload();
    await expect(page.getByText(/Tonight's check has run\. Next check: tomorrow at 0?6:00 PM\./)).toBeVisible();

    server.next = { at: '2026-10-21T23:30:00.000Z', when: 'now', timeZone: 'America/Chicago' };
    await page.reload();
    await expect(page.getByText(/The evening check is due now/)).toBeVisible();
  });

  test('says nothing about the next check when no channel or phone listens for it', async ({ page }) => {
    await mockAlerts(page, []);
    await openAlerts(page);
    await expect(page.getByText(/Next check:/)).toHaveCount(0);
  });

  test('says when no channel will hear about a clear night', async ({ page }) => {
    await mockAlerts(page, [{ ...ntfy, events: ['import.failed'] }]);
    await openAlerts(page);
    await expect(page.getByText(/does not run/)).toBeVisible();
  });

  test('counts the channels that will', async ({ page }) => {
    await mockAlerts(page);
    await openAlerts(page);
    await expect(page.getByText('Sent to 1 channel or iPhone.')).toBeVisible();
  });
});

test.describe('Settings → Alerts: admin only', () => {
  test('a viewer has no Alerts tab', async ({ page }) => {
    await mockAllRoutes(page);
    await mockViewerAuth(page); // after mockAllRoutes, which also answers /api/auth/me
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Alerts' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Alerts' })).toHaveCount(0);
  });
});
