import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
// import.ts has module-load side effects (reading the DB), even though this
// suite only exercises the standalone createWorkerQueue primitive it exports.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-workerqueue-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { createWorkerQueue } from '../../server/lib/library/import';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('createWorkerQueue', () => {
  it('processes every pushed item exactly once', async () => {
    const seen: number[] = [];
    const q = createWorkerQueue<number>(3, async n => { seen.push(n); });
    for (let i = 0; i < 10; i++) q.push(i);
    q.close();
    await q.drain();
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('never runs more than `concurrency` items at once', async () => {
    let active = 0;
    let maxActive = 0;
    const q = createWorkerQueue<number>(3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
    });
    for (let i = 0; i < 12; i++) q.push(i);
    q.close();
    await q.drain();
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1); // actually ran concurrently, not serialized
  });

  it('accepts items pushed after workers have already started draining', async () => {
    const seen: number[] = [];
    const q = createWorkerQueue<number>(2, async n => {
      seen.push(n);
      await new Promise(r => setTimeout(r, 5));
    });
    q.push(1);
    q.push(2);
    // Give the pool a moment to start pulling from the queue before pushing more.
    await new Promise(r => setTimeout(r, 15));
    q.push(3);
    q.push(4);
    q.close();
    await q.drain();
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
  });

  it('drain() resolves immediately when closed with an empty queue', async () => {
    const q = createWorkerQueue<number>(2, async () => { /* never called */ });
    q.close();
    await expect(q.drain()).resolves.toBeUndefined();
  });

  it('propagates a processor error via drain() rejection', async () => {
    const q = createWorkerQueue<number>(2, async n => {
      if (n === 2) throw new Error('boom');
    });
    q.push(1);
    q.push(2);
    q.close();
    await expect(q.drain()).rejects.toThrow('boom');
  });
});
