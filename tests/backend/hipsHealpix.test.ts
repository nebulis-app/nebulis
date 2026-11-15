import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { skyToTile, bitCombine } from '../../server/lib/hips/healpix';

/**
 * The goldens are healpy's own answers (`ang2pix(..., nest=True)` at the tile order, and at order + 9 for the
 * sub-tile pixel index), so these tests say "we agree with the reference implementation" rather than "we agree
 * with ourselves". Regenerate with the snippet in `agent/features/hips-cutout-renderer.plan.md`.
 */
interface Golden {
  raDeg: number;
  decDeg: number;
  tiles: Record<string, number>;
  subPixels: Record<string, number>;
}
const golden: { note: string; points: Golden[] } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/healpixGoldens.json'), 'utf8'),
);

const RAD = Math.PI / 180;
const TILE_PIXELS = 512;

describe('skyToTile', () => {
  it('finds the same HEALPix cell as healpy at every order', () => {
    const wrong: string[] = [];
    for (const point of golden.points) {
      for (const [orderKey, expected] of Object.entries(point.tiles)) {
        const order = Number(orderKey);
        const actual = skyToTile(point.raDeg * RAD, point.decDeg * RAD, order).tile;
        if (actual !== expected) wrong.push(`order ${order} ra ${point.raDeg} dec ${point.decDeg}: ${actual} !== ${expected}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('lands in the same sub-tile pixel as healpy', () => {
    // Pins the face-plane cell coordinates and the order of the interleaved bits. Which way the tile raster is
    // addressed is a separate question, answered by the SkyView comparison in hipsCutout.test.ts.
    const wrong: string[] = [];
    for (const point of golden.points) {
      for (const [orderKey, expected] of Object.entries(point.subPixels)) {
        const order = Number(orderKey);
        const position = skyToTile(point.raDeg * RAD, point.decDeg * RAD, order);
        const row = Math.min(Math.floor(position.fx * TILE_PIXELS), TILE_PIXELS - 1);
        const column = Math.min(Math.floor(position.fy * TILE_PIXELS), TILE_PIXELS - 1);
        const actual = position.tile * TILE_PIXELS * TILE_PIXELS + bitCombine(row, column);
        if (actual !== expected) wrong.push(`order ${order} ra ${point.raDeg} dec ${point.decDeg}: ${actual} !== ${expected}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('keeps every position inside its cell, never on an edge', () => {
    for (const point of golden.points) {
      for (const order of [3, 5, 8]) {
        const position = skyToTile(point.raDeg * RAD, point.decDeg * RAD, order);
        expect(position.fx).toBeGreaterThanOrEqual(0);
        expect(position.fx).toBeLessThan(1);
        expect(position.fy).toBeGreaterThanOrEqual(0);
        expect(position.fy).toBeLessThan(1);
        expect(position.ix).toBeGreaterThanOrEqual(0);
        expect(position.ix).toBeLessThan(2 ** order);
        expect(position.iy).toBeGreaterThanOrEqual(0);
        expect(position.iy).toBeLessThan(2 ** order);
      }
    }
  });

  it('nests: a cell at one order sits inside its parent at the order above', () => {
    for (const point of golden.points) {
      for (let order = 4; order <= 7; order++) {
        const fine = skyToTile(point.raDeg * RAD, point.decDeg * RAD, order);
        const coarse = skyToTile(point.raDeg * RAD, point.decDeg * RAD, order - 1);
        expect(Math.floor(fine.tile / 4)).toBe(coarse.tile);
      }
    }
  });

  it('answers for every whole-degree position, including the face edges that used to return nothing', () => {
    // An object at a whole-degree RA in the polar cap used to fall exactly on a face edge and project to nothing,
    // which would render an empty picture. Every position must produce a usable cell.
    for (let ra = 0; ra < 360; ra += 5) {
      for (let dec = -89; dec <= 89; dec += 7) {
        const position = skyToTile(ra * RAD, dec * RAD, 5);
        expect(Number.isFinite(position.fx)).toBe(true);
        expect(Number.isFinite(position.fy)).toBe(true);
        expect(position.tile).toBeGreaterThanOrEqual(0);
        expect(position.tile).toBeLessThan(12 * 32 * 32);
      }
    }
  });

  it('is deterministic, so a cached cutout can be reproduced exactly', () => {
    const first = skyToTile(38.17296 * RAD, 61.456889 * RAD, 6);
    const second = skyToTile(38.17296 * RAD, 61.456889 * RAD, 6);
    expect(second).toEqual(first);
  });
});
