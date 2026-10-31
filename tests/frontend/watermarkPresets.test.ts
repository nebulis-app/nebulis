import { describe, it, expect } from 'vitest';
import {
  layerToPreset,
  presetToTextBlock,
  sizePctFromLayer,
  findPresetByName,
  normalizePresetName,
  MAX_WATERMARK_NAME,
  type WatermarkTextBlock,
} from '../../src/lib/watermarkPresets';
import type { WatermarkPreset } from '../../src/lib/api/auth';

const block = (over: Partial<WatermarkTextBlock> = {}): WatermarkTextBlock => ({
  text: '© 2026 Brent',
  x: 0.97,
  y: 0.94,
  fontSize: 36,
  fontFamily: 'Arial, sans-serif',
  color: '#ffffff',
  bold: false,
  italic: false,
  opacity: 70,
  align: 'right',
  angle: 0,
  ...over,
});

const preset = (over: Partial<WatermarkPreset> = {}): WatermarkPreset => ({
  id: 'p1',
  name: 'Bottom right',
  text: '© 2026 Brent',
  fontSize: 36,
  fontFamily: 'Arial, sans-serif',
  color: '#ffffff',
  bold: false,
  italic: false,
  opacity: 70,
  align: 'right',
  angle: 0,
  ...over,
});

describe('sizePctFromLayer', () => {
  it('expresses a display-pixel size as a fraction of the rendered picture height', () => {
    expect(sizePctFromLayer(36, 600)).toBeCloseTo(0.06, 10);
    expect(sizePctFromLayer(60, 1000)).toBeCloseTo(0.06, 10);
  });

  it('is device-pixel-ratio independent because both numbers are backing-store pixels', () => {
    // The same picture on a 2x display: the layer's font size and the canvas
    // height both double, so the fraction does not move.
    expect(sizePctFromLayer(72, 1200)).toBeCloseTo(sizePctFromLayer(36, 600), 10);
  });

  it('clamps instead of producing an unusable size', () => {
    expect(sizePctFromLayer(0, 600)).toBeGreaterThan(0);
    expect(sizePctFromLayer(5000, 600)).toBe(1);
    expect(sizePctFromLayer(36, 0)).toBeGreaterThan(0);
  });
});

describe('normalizePresetName / findPresetByName', () => {
  it('trims, collapses spaces and caps the length', () => {
    expect(normalizePresetName('  My   mark  ')).toBe('My mark');
    expect(normalizePresetName('x'.repeat(100))).toHaveLength(MAX_WATERMARK_NAME);
  });

  it('matches names case-insensitively after normalising', () => {
    const presets = [preset({ name: 'My  Mark' })];
    expect(findPresetByName(presets, ' my mark ')?.id).toBe('p1');
    expect(findPresetByName(presets, 'other')).toBeUndefined();
  });
});

describe('layerToPreset', () => {
  it('captures the block text, style, position and relative size', () => {
    const saved = layerToPreset({ id: 'p2', name: '  Bottom   right ', layer: block(), canvasHeight: 600 });
    expect(saved).toMatchObject({
      id: 'p2',
      name: 'Bottom right',
      text: '© 2026 Brent',
      x: 0.97,
      y: 0.94,
      fontSize: 36,
      align: 'right',
      opacity: 70,
      sizePct: 0.06,
    });
  });

  it('keeps a multi-line block intact', () => {
    const saved = layerToPreset({
      id: 'p3', name: 'Stacked', layer: block({ text: '© 2026 Brent\nDeer Lick Group' }), canvasHeight: 600,
    });
    expect(saved.text).toBe('© 2026 Brent\nDeer Lick Group');
  });

  it('clamps geometry and opacity instead of storing values the server would refuse', () => {
    const saved = layerToPreset({
      id: 'p4', name: 'Edge', layer: block({ x: 2, y: -1, opacity: 140, angle: 200 }), canvasHeight: 600,
    });
    expect(saved.x).toBe(1);
    expect(saved.y).toBe(0);
    expect(saved.opacity).toBe(100);
    expect(saved.angle).toBe(90);
  });
});

describe('presetToTextBlock', () => {
  it('restores the size at the target canvas height, keeping the same fraction of the picture', () => {
    const applied = presetToTextBlock(preset({ sizePct: 0.06, x: 0.3, y: 0.8 }), 1000);
    expect(applied.fontSize).toBe(60);
    expect(applied.x).toBe(0.3);
    expect(applied.y).toBe(0.8);
  });

  it('falls back to the stored pixel size and the old fixed spot for a pre-geometry preset', () => {
    const applied = presetToTextBlock(preset(), 1000);
    expect(applied.fontSize).toBe(36);
    expect(applied.x).toBe(0.5);
    expect(applied.y).toBe(0.9);
  });

  it('ignores a corrupt size and keeps the legacy pixel size', () => {
    expect(presetToTextBlock(preset({ sizePct: Number.NaN }), 1000).fontSize).toBe(36);
  });
});
