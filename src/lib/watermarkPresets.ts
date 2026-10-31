import type { WatermarkPreset } from './api/auth';

/**
 * Conversion between a text block on the picture and a saved watermark.
 *
 * The editor holds a text layer's font size in *preview-canvas pixels*
 * (`ImageEditorModal`'s TextLayer). A preview canvas is fitted to the editor
 * window and scaled by the device pixel ratio, so that number means nothing on
 * another picture, window or display. A saved watermark stores the size as a
 * fraction of the rendered picture's height instead, which survives all three.
 *
 * The fractions are relative to the same canvas the editor draws on, which is
 * already the rotated and cropped shape, so applying a watermark after a crop
 * keeps its corner where the user put it.
 */

/** A text layer's geometry and style, structurally, so this module never imports the editor. */
export interface WatermarkTextBlock {
  text: string;
  /** 0–1 anchor on the canvas: left/centre/right edge of the text for `align`, baseline of the first line. */
  x: number;
  y: number;
  /** Preview-canvas pixels, DPR included. */
  fontSize: number;
  fontFamily: string;
  color: string;
  bold: boolean;
  italic: boolean;
  opacity: number;
  align: 'left' | 'center' | 'right';
  angle: number;
}

/** Written to `userPreferences.watermarkPresets`; the server caps the array at the same number. */
export const MAX_WATERMARK_PRESETS = 50;
export const MAX_WATERMARK_NAME = 40;
export const MAX_WATERMARK_TEXT = 2000;

/** A font as tall as the picture is already absurd; clamp rather than refuse a legitimate save. */
export const MIN_SIZE_PCT = 0.001;
export const MAX_SIZE_PCT = 1;

/** Where `applyPreset` used to put every watermark. Presets saved before the geometry fields keep it. */
export const LEGACY_PRESET_X = 0.5;
export const LEGACY_PRESET_Y = 0.9;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Trim, collapse runs of whitespace, and cut to the stored limit. */
export function normalizePresetName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_WATERMARK_NAME);
}

/** Case-insensitive identity for the uniqueness rule, so "© Me" and "© me" cannot both exist. */
export function presetNameKey(name: string): string {
  return normalizePresetName(name).toLowerCase();
}

/**
 * A layer's font size as a fraction of the rendered picture height.
 *
 * `canvasHeight` is the preview canvas backing-store height, the same unit as
 * `fontSize`, so the device pixel ratio cancels out. At export the editor
 * multiplies every text layer by `offscreen.height / display.height`, which
 * lands the printed size at the same fraction of the final image.
 */
export function sizePctFromLayer(fontSize: number, canvasHeight: number): number {
  if (!(canvasHeight > 0) || !Number.isFinite(fontSize)) return MIN_SIZE_PCT;
  return clamp(fontSize / canvasHeight, MIN_SIZE_PCT, MAX_SIZE_PCT);
}

/** Whether a saved watermark already uses this name, ignoring case and extra spaces. */
export function findPresetByName(presets: WatermarkPreset[], name: string): WatermarkPreset | undefined {
  const key = presetNameKey(name);
  return key ? presets.find(p => presetNameKey(p.name) === key) : undefined;
}

/** Read the text block as a saved watermark. */
export function layerToPreset(args: {
  id: string;
  name: string;
  layer: WatermarkTextBlock;
  /** Preview canvas backing-store height; see `sizePctFromLayer`. */
  canvasHeight: number;
}): WatermarkPreset {
  const { id, name, layer, canvasHeight } = args;
  return {
    id,
    name: normalizePresetName(name),
    text: layer.text.slice(0, MAX_WATERMARK_TEXT),
    // Kept so an older client, or a rollback, still has a usable pixel size.
    fontSize: Math.round(layer.fontSize),
    fontFamily: layer.fontFamily,
    color: layer.color,
    bold: layer.bold,
    italic: layer.italic,
    opacity: clamp(layer.opacity, 0, 100),
    align: layer.align,
    angle: clamp(layer.angle, -90, 90),
    x: clamp(layer.x, 0, 1),
    y: clamp(layer.y, 0, 1),
    sizePct: sizePctFromLayer(layer.fontSize, canvasHeight),
  };
}

/**
 * Read a saved watermark back as text-block fields.
 *
 * A preset saved before the geometry fields existed has no `sizePct`/`x`/`y`.
 * It gets exactly the old behaviour: its stored pixel size and the old fixed
 * spot, rather than a guessed fraction that would change how it looks.
 */
export function presetToTextBlock(
  preset: WatermarkPreset,
  canvasHeight: number,
): WatermarkTextBlock {
  const sizePct = preset.sizePct != null && Number.isFinite(preset.sizePct) ? preset.sizePct : null;
  const fontSize = sizePct != null && canvasHeight > 0
    ? Math.max(1, Math.round(clamp(sizePct, MIN_SIZE_PCT, MAX_SIZE_PCT) * canvasHeight))
    : preset.fontSize;
  return {
    text: preset.text,
    x: clamp(preset.x ?? LEGACY_PRESET_X, 0, 1),
    y: clamp(preset.y ?? LEGACY_PRESET_Y, 0, 1),
    fontSize,
    fontFamily: preset.fontFamily,
    color: preset.color,
    bold: preset.bold,
    italic: preset.italic,
    opacity: preset.opacity,
    align: preset.align,
    angle: preset.angle,
  };
}
