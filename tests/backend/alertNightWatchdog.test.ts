import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-alertwatchdog-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'fs';
import db from '../../server/lib/db';
import { _setRetryDelayForTests } from '../../server/lib/alerts/delivery';
import { formatAlert } from '../../server/lib/alerts/messages';
import {
  evaluateFrames, runNightWatchdog, tonightSessions, _resetNightWatchdogForTests,
  type Tonight, type WatchFrame,
} from '../../server/lib/alerts/nightWatchdog';
import { createAlertChannel, deleteAlertChannel, listAlertChannels } from '../../server/lib/alerts/store';
import type { FrameFlag, FrameReason } from '../../server/lib/frameAnalysis/ranking';
import type { WatchdogAlertData } from '../../server/lib/alerts/types';

let receiver: http.Server;
let base: string;
let calls: { url: string; body: Record<string, unknown> }[] = [];
let replies: number[] = [];

beforeAll(async () => {
  _setRetryDelayForTests(5);
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url ?? '', body: JSON.parse(body || '{}') });
      res.statusCode = replies.shift() ?? 200;
      res.end('{}');
    });
  });
  await new Promise<void>(r => receiver.listen(0, r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(r => receiver.close(() => r()));
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  replies = [];
  _resetNightWatchdogForTests();
  for (const c of listAlertChannels()) deleteAlertChannel(c.id);
  db.prepare("DELETE FROM alertState WHERE key LIKE 'watchdog.%'").run();
});

/** A frame of the dual-band set; `flags` are what frame analysis found. */
const frame = (n: number, flags: FrameFlag[] = [], reasons: FrameReason[] = [], set = 'h|180.0s|zwo asi585mc air|3840x2160'): WatchFrame => ({
  name: `Light_NGC 6888_180.0s_Bin1_H_gain200_20260912-0${n}_0${n}.fit`, set, filter: 'H', flags, reasons, scale: 0.98,
});
const soft = (fwhm: number): FrameReason => ({ flag: 'soft', fwhm, typical: 2.6 });

describe('judging the latest frames', () => {
  it('waits for a full window before judging a set', () => {
    expect(evaluateFrames([frame(1, ['soft']), frame(2, ['soft']), frame(3, ['soft']), frame(4, ['soft'])])).toEqual([]);
  });

  it('calls a problem when most of the latest frames share it, with its measure in arcseconds', () => {
    const frames = [frame(1), frame(2), frame(3, ['soft'], [soft(3.4)]), frame(4, ['soft'], [soft(3.6)]), frame(5, ['soft'], [soft(3.5)])];
    const softFinding = evaluateFrames(frames).find(f => f.problem === 'soft')!;
    expect(softFinding).toMatchObject({ state: 'problem', count: 3, window: 5, filter: 'H', unit: 'arcsec' });
    expect(softFinding.value).toBeCloseTo(3.5 * 0.98, 5);
    expect(softFinding.typical).toBeCloseTo(2.6 * 0.98, 5);
    expect(softFinding.lastFrame).toContain('_05.fit');
    expect(evaluateFrames(frames).find(f => f.problem === 'clouds')).toMatchObject({ state: 'clear', count: 0 });
  });

  it('looks only at the latest frames: a bad start that has passed is clear, two of five is mixed', () => {
    const passed = [frame(1, ['clouds']), frame(2, ['clouds']), frame(3, ['clouds']), frame(4), frame(5), frame(6), frame(7), frame(8)];
    expect(evaluateFrames(passed).find(f => f.problem === 'clouds')?.state).toBe('clear');
    const mixed = [frame(1), frame(2), frame(3), frame(4, ['trails']), frame(5, ['trails'])];
    expect(evaluateFrames(mixed).find(f => f.problem === 'trails')?.state).toBe('mixed');
  });

  it('judges each set on its own', () => {
    const other = 'sii|180.0s|zwo asi585mc air|3840x2160';
    const frames = [
      ...[1, 2, 3, 4, 5].map(n => frame(n, ['clouds'], [{ flag: 'clouds', stars: 40, typical: 300, percentFewer: 87, percentDimmer: null, brighterSky: false }])),
      ...[6, 7, 8, 9, 10].map(n => frame(n, [], [], other)),
    ];
    const findings = evaluateFrames(frames).filter(f => f.problem === 'clouds');
    expect(findings.map(f => [f.set.split('|')[0], f.state])).toEqual([['h', 'problem'], ['sii', 'clear']]);
    expect(findings[0]).toMatchObject({ value: 87, unit: 'percent' });
  });
});

describe("tonight's sessions", () => {
  it('come from recent imports, dated tonight', () => {
    const insert = db.prepare(
      `INSERT INTO importHistory (startedAt, finishedAt, objectsTotal, filesTotal, newFiles, bytesTotal, bytesNew, sessionsTouched)
       VALUES (?, ?, 1, 1, 1, 0, 0, ?)`,
    );
    const touched = (sessions: Array<[string, string]>) =>
      JSON.stringify(sessions.map(([objectId, date]) => ({ objectId, objectName: objectId.toUpperCase(), date, isNew: false })));
    insert.run('2026-09-12T01:00:00Z', '2026-09-12T01:05:00Z', touched([['ngc6888', '2026-09-11'], ['m31', '2026-09-01']]));
    // Too old to say anything about tonight.
    insert.run('2026-09-10T01:00:00Z', '2026-09-10T01:05:00Z', touched([['sh2-112', '2026-09-11']]));

    expect(tonightSessions(new Date('2026-09-12T02:00:00Z'), '2026-09-11')).toEqual([{ objectId: 'ngc6888', objectName: 'NGC6888' }]);
  });
});

describe('sending', () => {
  const night = (state: 'problem' | 'clear' | 'mixed', date = '2026-09-11'): (() => Promise<Tonight>) => async () => ({
    night: date,
    sessions: [{
      objectId: 'ngc6888', objectName: 'NGC 6888',
      findings: [{
        set: 'h|180.0s|cam|3840x2160', problem: 'soft', state, count: state === 'problem' ? 4 : 0, window: 5, filter: 'H',
        lastFrame: 'Light_NGC 6888_0108.fit', value: state === 'problem' ? 3.4 : null, typical: state === 'problem' ? 2.5 : null,
        unit: state === 'problem' ? 'arcsec' : null,
      }],
    }],
  });
  const at = new Date('2026-09-12T02:10:00Z');
  const hook = () => createAlertChannel({ name: 'hook', kind: 'webhook', url: `${base}/hook`, events: ['night.watchdog'] });
  const kinds = () => calls.map(c => (c.body.data as WatchdogAlertData).kind);

  it('sends a problem once, then back to normal once, then nothing more that night', async () => {
    hook();
    expect(await runNightWatchdog(at, night('problem'))).toBe(1);
    expect(await runNightWatchdog(at, night('problem'))).toBe(0);
    expect(await runNightWatchdog(at, night('mixed'))).toBe(0);
    expect(await runNightWatchdog(at, night('clear'))).toBe(1);
    // A relapse the same night is not sent again.
    expect(await runNightWatchdog(at, night('problem'))).toBe(0);
    expect(kinds()).toEqual(['problem', 'recovered']);
    expect(calls[0].body).toMatchObject({ event: 'night.watchdog', data: { objectName: 'NGC 6888', problem: 'soft', count: 4, window: 5 } });
  });

  it('says nothing about a clean night, and starts over the next night', async () => {
    hook();
    expect(await runNightWatchdog(at, night('clear'))).toBe(0);
    expect(await runNightWatchdog(at, night('problem'))).toBe(1);
    expect(await runNightWatchdog(new Date('2026-09-13T02:10:00Z'), night('problem', '2026-09-12'))).toBe(1);
  });

  it('only sends to destinations that chose the watchdog, and retries one that failed', async () => {
    createAlertChannel({ name: 'dew only', kind: 'webhook', url: `${base}/dew`, events: ['night.dew'] });
    hook();
    replies = [503, 503];
    expect(await runNightWatchdog(at, night('problem'))).toBe(0);
    // Left alone for a while, then sent: the failure did not count as sent.
    expect(await runNightWatchdog(at, night('problem'))).toBe(0);
    expect(await runNightWatchdog(new Date(at.getTime() + 16 * 60_000), night('problem'))).toBe(1);
    expect(calls.every(c => c.url === '/hook')).toBe(true);
  });
});

describe('the message', () => {
  const data: WatchdogAlertData = {
    kind: 'problem', problem: 'soft', objectId: 'ngc6888', objectName: 'NGC 6888', night: '2026-09-11', window: 5, count: 4,
    filter: 'H', lastFrame: 'Light_NGC 6888_0108.fit', value: 3.43, typical: 2.58, unit: 'arcsec',
  };
  const event = (d: WatchdogAlertData) => ({ type: 'night.watchdog' as const, occurredAt: '2026-09-12T02:10:00Z', data: d });

  it('says what, how bad, and what to check', () => {
    const en = formatAlert(event(data), 'en');
    expect(en.title).toBe('NGC 6888: soft focus');
    expect(en.body.split('\n')).toEqual([
      '4 of the last 5 frames: soft focus',
      'FWHM 3.4″ against 2.6″ earlier tonight',
      'Check the focus.',
      'Last frame: Light_NGC 6888_0108.fit',
    ]);
    expect(en.lead).toBe('4 of the last 5 frames: soft focus');
    expect(formatAlert(event(data), 'fr').title).toBe('NGC 6888 : mise au point floue');
  });

  it('says when the night is back to normal', () => {
    const msg = formatAlert(event({ ...data, kind: 'recovered', problem: 'clouds', count: 0, value: null, typical: null, unit: null }), 'en');
    expect(msg.title).toBe('NGC 6888: back to normal');
    expect(msg.body).toBe('The last 5 frames are good again: no more clouds.');
  });
});
