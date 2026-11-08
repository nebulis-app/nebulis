import { z } from 'zod';

/** What the editor sends with a save: see `GeometryEdit`. Crop is a rectangle of the source, 0 to 1. */
export const geometryEditSchema = z.object({
  crop: z.object({
    x1: z.number().min(0).max(1), y1: z.number().min(0).max(1),
    x2: z.number().min(0).max(1), y2: z.number().min(0).max(1),
  }).refine(c => c.x2 > c.x1 && c.y2 > c.y1, 'crop must have a positive size').optional(),
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
});
