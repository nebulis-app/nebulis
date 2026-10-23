import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createHmac } from 'crypto';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-alertdelivery-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import {
  buildAlertRequest,
  buildDeviceRequest,
  dispatchAlert,
  sendToChannel,
  _setRetryDelayForTests,
} from '../../server/lib/alerts/delivery';
import { formatAlert, formatHours, _alertStringsForTests } from '../../server/lib/alerts/messages';
import { createAlertChannel, deleteAlertChannel, getAlertChannel, listAlertChannels, setAlertConfig } from '../../server/lib/alerts/store';
import { announceUpdate } from '../../server/lib/alerts/index';
import { writeImportHistory } from '../../server/lib/library/importHistory';
import type { AlertChannel, AlertEvent, ClearNightAlertData, ImportAlertData } from '../../server/lib/alerts/types';
import type { ImportStatus } from '../../server/lib/library/importTypes';

let receiver: http.Server;
let base: string;
let received: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let replies: number[] = [];

beforeAll(async () => {
  _setRetryDelayForTests(10);
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.statusCode = replies.shift() ?? 200;
      res.end();
    });
  });
  await new Promise<void>(resolve => receiver.listen(0, resolve));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => receiver.close(() => resolve()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
  replies = [];
  for (const c of listAlertChannels()) deleteAlertChannel(c.id);
  setAlertConfig({ language: 'en' });
});

const channel = (over: Partial<AlertChannel>): AlertChannel => ({
  id: 'c1', name: 'c', kind: 'webhook', url: 'https://example.test/hook', secret: null, events: [], enabled: true,
  createdAt: '', lastSentAt: null, lastStatus: null, lastError: null, ...over,
});

const importData: ImportAlertData = {
  source: 'telescope', telescopeName: 'Elendil', newFiles: 42, manual: false, error: null,
  objects: [{ objectId: 'NGC6888', name: 'NGC6888', isNew: false }, { objectId: 'M27', name: 'M27', isNew: true }],
  sessions: [{ objectId: 'NGC6888', objectName: 'NGC6888', date: '2026-10-14' }],
};
const importEvent: AlertEvent = { type: 'import.finished', occurredAt: '2026-10-15T06:00:00.000Z', data: importData };

const clearData: ClearNightAlertData = {
  siteName: 'Verrens-Arvey', night: '2026-10-15', timeZone: 'Europe/Paris', clearHours: 5.5, darkHours: 9.5,
  longestStart: '2026-10-15T20:00:00.000Z', longestEnd: '2026-10-16T01:30:00.000Z', maxCloudCover: 30, seeing: 1.8,
  moonIllumination: 12, moonDownHours: 4.5, moonRise: null, moonSet: '2026-10-15T21:00:00.000Z',
};

describe('alert messages', () => {
  it('has the same keys in every language', () => {
    const keys = Object.keys(_alertStringsForTests.en).sort();
    for (const table of Object.values(_alertStringsForTests)) expect(Object.keys(table).sort()).toEqual(keys);
  });

  it('describes an import', () => {
    expect(formatAlert(importEvent, 'en')).toMatchObject({ title: 'Import finished', body: '42 new files from Elendil: NGC6888, M27' });
    expect(formatAlert(importEvent, 'fr').body).toBe('42 nouveaux fichiers depuis Elendil : NGC6888, M27');
    const failed = formatAlert({ ...importEvent, type: 'import.failed', data: { ...importData, source: 'folder', error: 'disk full' } }, 'en');
    expect(failed).toMatchObject({ title: 'Import failed', body: 'a local folder: disk full' });
  });

  it('lists five objects and counts the rest', () => {
    const objects = Array.from({ length: 7 }, (_, i) => ({ objectId: `M${i}`, name: `M${i}`, isNew: false }));
    expect(formatAlert({ ...importEvent, data: { ...importData, objects } }, 'en').body).toBe('42 new files from Elendil: M0, M1, M2, M3, M4 +2 more');
  });

  it('describes a clear night in local time, in three short lines with the answer first', () => {
    const en = formatAlert({ type: 'night.clear', occurredAt: '', data: clearData }, 'en');
    expect(en.title).toBe('Clear tonight: Verrens-Arvey');
    expect(en.body).toBe([
      '5.5 h of 9.5 h clear, best 22:00 to 03:30',
      'Moon 12%, sets 23:00',
      'Seeing good, clouds up to 30%',
    ].join('\n'));
    expect(en.lead).toBe('5.5 h of 9.5 h clear, best 22:00 to 03:30');
    for (const line of en.body.split('\n')) expect(line.length).toBeLessThanOrEqual(44);
    expect(formatAlert({ type: 'night.clear', occurredAt: '', data: clearData }, 'fr').body.split('\n')[0])
      .toBe('5,5 h dégagées sur 9,5 h, meilleur créneau de 22:00 à 03:30');
    const moonUp = formatAlert({ type: 'night.clear', occurredAt: '', data: { ...clearData, moonSet: null, moonRise: null, moonDownHours: 0, seeing: null } }, 'en');
    expect(moonUp.body.split('\n')).toEqual([expect.any(String), 'Moon 12%, up the whole time', 'Clouds up to 30%']);
  });

  it('says "all night" when the whole dark is clear, and not when a real part is lost', () => {
    const whole = formatAlert({ type: 'night.clear', occurredAt: '', data: { ...clearData, clearHours: 9.5 } }, 'en');
    expect(whole.lead).toBe('All night, 22:00 to 03:30');
    const nearly = formatAlert({ type: 'night.clear', occurredAt: '', data: { ...clearData, clearHours: 9.3 } }, 'en');
    expect(nearly.lead).toBe('All night, 22:00 to 03:30');
    const lost = formatAlert({ type: 'night.clear', occurredAt: '', data: { ...clearData, clearHours: 8.5 } }, 'en');
    expect(lost.lead).toBe('8.5 h of 9.5 h clear, best 22:00 to 03:30');
  });

  it('only a clear night has a lead line', () => {
    expect(formatAlert(importEvent, 'en').lead).toBeNull();
    expect(formatAlert({ type: 'test', occurredAt: '', data: {} } as never, 'en').lead).toBeNull();
  });

  it('rounds hours to the half hour', () => {
    expect(formatHours(3, 'en')).toBe('3 h');
    expect(formatHours(4.26, 'en')).toBe('4.5 h');
    expect(formatHours(4.24, 'de')).toBe('4 h');
  });
});

describe('the dew warning', () => {
  const dewData = { siteName: 'Franklin, TN', night: '2026-10-20', timeZone: 'America/Chicago', level: 'likely', from: '2026-10-21T07:00:00.000Z', lowTempC: 5, leadMinutes: 60 } as const;
  const dew = (over: object = {}) => ({ type: 'night.dew', occurredAt: '', data: { ...dewData, ...over } }) as const;

  it("leads with when the dew starts, then the night's low in the reader's unit", () => {
    const m = formatAlert(dew(), 'en', { temperatureUnit: 'fahrenheit' });
    expect(m.title).toBe('Dew warning: Franklin, TN');
    expect(m.body).toBe('Dew likely from 02:00\nLow 41°F tonight');
    expect(m.lead).toBe('Dew likely from 02:00');
    expect(formatAlert(dew(), 'en', { temperatureUnit: 'celsius' }).body).toContain('Low 5°C tonight');
    expect(m.tags).toEqual(['droplet']);
  });

  it('says "possible" for a smaller risk, and leaves the low out when the forecast had none', () => {
    expect(formatAlert(dew({ level: 'possible' }), 'en').lead).toBe('Dew possible from 02:00');
    expect(formatAlert(dew({ lowTempC: null }), 'en').body).toBe('Dew likely from 02:00');
  });

  it('is written in every language, with nothing left unfilled', () => {
    for (const lang of ['fr', 'de', 'es', 'nl'] as const) {
      const m = formatAlert(dew(), lang);
      expect(m.title).toContain('Franklin, TN');
      for (const text of [m.title, m.body]) expect(text).not.toMatch(/\{\w+\}/);
      expect(m.body.split('\n')).toHaveLength(2);
    }
  });

  it('goes to a phone with the warning as the subtitle and a tap that opens the Sky tab', () => {
    const device = { id: 'd1', token: 'a'.repeat(64), apnsEnv: 'production', credential: 'c'.repeat(40), name: 'iPhone' } as never;
    const body = JSON.parse(buildDeviceRequest(device, dew(), formatAlert(dew(), 'en')).body);
    expect(body).toMatchObject({ title: 'Dew warning: Franklin, TN', subtitle: 'Dew likely from 02:00', link: 'nebulis://sky', threadId: 'night.dew', ttlSeconds: 3 * 3600 });
    expect(body.body).toBe('Low 5°C tonight');
  });
});

describe('the Moon line', () => {
  const line = (over: object) => formatAlert({ type: 'night.clear', occurredAt: '', data: { ...clearData, ...over } }, 'en').body.split('\n')[1];

  it('says when the Moon leaves or arrives, whichever comes first', () => {
    expect(line({})).toBe('Moon 12%, sets 23:00');
    expect(line({ moonSet: null, moonRise: '2026-10-16T00:10:00.000Z' })).toBe('Moon 12%, rises 02:10');
    expect(line({ moonSet: '2026-10-15T23:00:00.000Z', moonRise: '2026-10-16T00:10:00.000Z' })).toBe('Moon 12%, sets 01:00');
  });

  it('does not bother with a timing for a thin Moon', () => {
    expect(line({ moonIllumination: 4 })).toBe('Moon 4%, no interference');
    expect(line({ moonIllumination: 10 })).toBe('Moon 10%, no interference');
  });

  it('falls back to how long it is down, or up the whole time, when it neither rises nor sets', () => {
    expect(line({ moonSet: null, moonRise: null })).toBe('Moon 12%, down for 4.5 h');
    expect(line({ moonSet: null, moonRise: null, moonDownHours: 0 })).toBe('Moon 12%, up the whole time');
  });
});

describe('the lines a person can add', () => {
  const event = (over: object) => ({ type: 'night.clear', occurredAt: '', data: { ...clearData, ...over } }) as const;
  const both = { dew: true, plan: true };

  it('adds nothing until asked', () => {
    const withData = event({ dew: { level: 'likely', from: '2026-10-16T00:00:00.000Z', lowTempC: 2 }, plan: { objects: ['M42'], blocks: 1 } });
    expect(formatAlert(withData, 'en').body.split('\n')).toHaveLength(3);
    expect(formatAlert(withData, 'en', { details: { dew: false, plan: false } }).body.split('\n')).toHaveLength(3);
  });

  it('puts the plan first, then the dew, so anything cut off is the least important', () => {
    const m = formatAlert(event({ dew: { level: 'likely', from: '2026-10-16T00:00:00.000Z', lowTempC: 2 }, plan: { objects: ['M42', 'M31'], blocks: 3 } }), 'en',
      { details: both, temperatureUnit: 'fahrenheit' });
    expect(m.body.split('\n')).toEqual([
      '5.5 h of 9.5 h clear, best 22:00 to 03:30', 'Planned: M42, M31', 'Dew likely from 02:00, low 36°F', 'Moon 12%, sets 23:00', 'Seeing good, clouds up to 30%',
    ]);
    expect(m.lead).toBe('5.5 h of 9.5 h clear, best 22:00 to 03:30');
  });

  it('reads the dew risk at each level, in the chosen unit', () => {
    const dew = (d: object, unit: 'celsius' | 'fahrenheit' = 'celsius') =>
      formatAlert(event({ dew: d }), 'en', { details: { dew: true }, temperatureUnit: unit }).body.split('\n')[1];
    expect(dew({ level: 'possible', from: '2026-10-16T01:30:00.000Z', lowTempC: 4.4 })).toBe('Dew possible from 03:30, low 4°C');
    expect(dew({ level: 'none', from: null, lowTempC: 9 })).toBe('No dew expected, low 9°C');
    expect(dew({ level: 'none', from: null, lowTempC: 9 }, 'fahrenheit')).toBe('No dew expected, low 48°F');
    // No forecast values at all: no line rather than an invented one.
    expect(formatAlert(event({ dew: null }), 'en', { details: { dew: true } }).body.split('\n')).toHaveLength(3);
  });

  it('names up to three planned objects and says when nothing is planned', () => {
    const plan = (objects: string[]) => formatAlert(event({ plan: { objects, blocks: objects.length } }), 'en', { details: { plan: true } }).body.split('\n')[1];
    expect(plan(['M42'])).toBe('Planned: M42');
    expect(plan(['M42', 'M31', 'M33', 'NGC 7000', 'IC 1805'])).toBe('Planned: M42, M31, M33 +2 more');
    expect(plan([])).toBe('Nothing planned. Tap to plan.');
    expect(formatAlert(event({ plan: null }), 'en', { details: { plan: true } }).body.split('\n')).toHaveLength(3);
  });

  it('opens the planner on a tap only when the plan line is on', () => {
    expect(formatAlert(event({ plan: { objects: [], blocks: 0 } }), 'en', { details: { plan: true } }).deepLink).toBe('nebulis://planner');
    expect(formatAlert(event({}), 'en', { details: { dew: true } }).deepLink).toBeNull();
    const device = { id: 'd1', token: 'a'.repeat(64), apnsEnv: 'production', credential: 'c'.repeat(40), name: 'iPhone' } as never;
    const on = formatAlert(event({ plan: { objects: [], blocks: 0 } }), 'en', { details: { plan: true } });
    expect(JSON.parse(buildDeviceRequest(device, event({}), on).body).link).toBe('nebulis://planner');
    expect(JSON.parse(buildDeviceRequest(device, event({}), formatAlert(event({}), 'en')).body).link).toBe('nebulis://sky');
  });

  it('has the new lines in every language', () => {
    for (const lang of ['fr', 'de', 'es', 'nl'] as const) {
      const body = formatAlert(event({ dew: { level: 'likely', from: '2026-10-16T00:00:00.000Z', lowTempC: 2 }, plan: { objects: [], blocks: 0 } }), lang,
        { details: both }).body.split('\n');
      expect(body).toHaveLength(5);
      for (const l of body) expect(l).not.toMatch(/\{\w+\}/);
    }
  });
});

describe('phone requests', () => {
  const device = { id: 'd1', token: 'a'.repeat(64), apnsEnv: 'production', credential: 'c'.repeat(40), name: 'iPhone' } as never;

  it('puts the answer in the subtitle and the rest in the body for a clear night', () => {
    const event = { type: 'night.clear', occurredAt: '', data: clearData } as const;
    const body = JSON.parse(buildDeviceRequest(device, event, formatAlert(event, 'en')).body);
    expect(body.title).toBe('Clear tonight: Verrens-Arvey');
    expect(body.subtitle).toBe('5.5 h of 9.5 h clear, best 22:00 to 03:30');
    expect(body.body).toBe('Moon 12%, sets 23:00\nSeeing good, clouds up to 30%');
    expect(body.link).toBe('nebulis://sky');
  });

  it('sends no subtitle when there is no lead, so the relay and the phone see what they always did', () => {
    const body = JSON.parse(buildDeviceRequest(device, importEvent, formatAlert(importEvent, 'en')).body);
    expect(body.subtitle).toBeUndefined();
    expect(body.body).toBe('42 new files from Elendil: NGC6888, M27');
  });
});

describe('request shapes', () => {
  const message = formatAlert(importEvent, 'en');

  it('posts signed JSON to a generic webhook', () => {
    const req = buildAlertRequest(channel({ secret: 'k' }), importEvent, message);
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ source: 'nebulis', event: 'import.finished', title: 'Import finished', occurredAt: importEvent.occurredAt, data: importData });
    expect(req.headers['X-Nebulis-Event']).toBe('import.finished');
    expect(req.headers['X-Nebulis-Signature']).toBe(`sha256=${createHmac('sha256', 'k').update(req.body).digest('hex')}`);
    expect(buildAlertRequest(channel({}), importEvent, message).headers['X-Nebulis-Signature']).toBeUndefined();
  });

  it('puts the ntfy title in the query, keeping any token already there', () => {
    const req = buildAlertRequest(channel({ kind: 'ntfy', url: 'https://ntfy.sh/astro?auth=tok' }), importEvent, formatAlert(importEvent, 'fr'));
    const url = new URL(req.url);
    expect(url.searchParams.get('auth')).toBe('tok');
    expect(url.searchParams.get('title')).toBe('Import terminé');
    expect(url.searchParams.get('tags')).toBe('inbox_tray');
    expect(req.body).toBe('42 nouveaux fichiers depuis Elendil : NGC6888, M27');
  });

  it('uses the Discord and Slack message fields', () => {
    expect(JSON.parse(buildAlertRequest(channel({ kind: 'discord' }), importEvent, message).body))
      .toEqual({ content: '**Import finished**\n42 new files from Elendil: NGC6888, M27', username: 'Nebulis' });
    expect(JSON.parse(buildAlertRequest(channel({ kind: 'slack' }), importEvent, message).body))
      .toEqual({ text: '*Import finished*\n42 new files from Elendil: NGC6888, M27' });
  });
});

describe('sending', () => {
  it('retries once on a server error, not on a client error', async () => {
    const c = createAlertChannel({ name: 'hook', kind: 'webhook', url: `${base}/h`, events: ['import.finished'] });
    replies = [503, 200];
    expect(await sendToChannel(c, importEvent)).toMatchObject({ ok: true, status: 200 });
    expect(received).toHaveLength(2);

    received = [];
    replies = [404];
    expect(await sendToChannel(c, importEvent)).toMatchObject({ ok: false, status: 404 });
    expect(received).toHaveLength(1);
    expect(getAlertChannel(c.id)).toMatchObject({ lastStatus: 'error', lastError: 'HTTP 404' });
  });

  it('dispatches only to enabled channels subscribed to the event', async () => {
    createAlertChannel({ name: 'yes', kind: 'slack', url: `${base}/yes`, events: ['import.finished'] });
    createAlertChannel({ name: 'other event', kind: 'slack', url: `${base}/other`, events: ['night.clear'] });
    createAlertChannel({ name: 'off', kind: 'slack', url: `${base}/off`, events: ['import.finished'], enabled: false });
    await dispatchAlert(importEvent);
    expect(received.map(r => r.url)).toEqual(['/yes']);
  });

  it('alerts on an import that brought files or failed, not on an empty or cancelled one', async () => {
    createAlertChannel({ name: 'all', kind: 'webhook', url: `${base}/all`, events: ['import.finished', 'import.failed'] });
    const status = (over: Partial<ImportStatus>) => ({
      startedAt: new Date().toISOString(), objectsTotal: 1, filesTotal: 1, bytesTotal: 0, error: null,
      telescopeId: 't', telescopeName: 'Elendil', transportKind: null, skipped: [], manual: false, cancelled: false, ...over,
    }) as unknown as ImportStatus;
    const acc = (files: number) => ({
      newFiles: Array.from({ length: files }, (_, i) => ({ name: `f${i}.fits`, size: 1 })),
      bytesNew: 0,
      objectsTouched: new Map([['M27', { objectId: 'M27', name: 'M27', isNew: false }]]),
      sessionsTouched: new Map(),
      source: 'telescope' as const,
    });
    const settle = () => new Promise(r => setTimeout(r, 200));

    writeImportHistory(status({}), acc(0));
    writeImportHistory(status({ cancelled: true, error: 'cancelled' }), acc(3));
    await settle();
    expect(received).toHaveLength(0);

    writeImportHistory(status({}), acc(3));
    writeImportHistory(status({ error: 'Wi-Fi lost' }), acc(0));
    await settle();
    const events = received.map(r => JSON.parse(r.body)).sort((a, b) => a.event.localeCompare(b.event));
    expect(events.map(e => e.event)).toEqual(['import.failed', 'import.finished']);
    expect(events[1].data).toMatchObject({ newFiles: 3, telescopeName: 'Elendil', objects: [{ objectId: 'M27' }] });
    expect(events[0].message).toBe('Elendil: Wi-Fi lost');
  });

  it('announces each new version once', async () => {
    createAlertChannel({ name: 'u', kind: 'webhook', url: `${base}/u`, events: ['update.available'] });
    const status = { currentVersion: '2.1.2', latestVersion: '2.2.0', notesUrl: 'https://example.test/notes', updateAvailable: true } as never;
    announceUpdate(status);
    announceUpdate(status);
    await new Promise(r => setTimeout(r, 200));
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.body)).toMatchObject({ title: 'Nebulis 2.2.0 is available', url: 'https://example.test/notes' });
  });
});
